# CUS Audit agents

On-demand agents that capture dated screenshots of GitHub repository settings for the HylandExperience
`fcc-*` repositories. **You sign in yourself** (SSO + authenticator app); the agents never see or store
credentials. Each agent runs only when you start it.

```
CUS Audit\
  README.md                                   <- this file
  AGENT-STANDARDS.md                          <- rules every agent must follow
  run-all.cmd                                 <- run all agents one after another
  Branch Specific Write Access\               <- agent 1
  Access To Deploy Changes to Production\     <- agent 2
  Github Administrator Listing\               <- agent 3
```

## The agents

| Agent | Version | Page it captures | Screenshot name |
|---|---|---|---|
| **Branch Specific Write Access** | 1.1.0 | Repo → Settings → Collaborators and teams → click **Direct access** | `<repo> Branch Specific Write Access <YYYYMMDD-HHMMSS>.png` |
| **Access To Deploy Changes to Production** | 1.2.0 | Repo → Settings → Environments → **Configure prod-apply** (deployment protection rules) | `<repo> Access To Deploy Changes to Production <YYYYMMDD-HHMMSS>.png` |
| **Github Administrator Listing** | 1.0 | Repo → Settings → Collaborators and teams → **Direct access** → **Role = Admin** filter | `<repo> Github Administrator Listing <YYYYMMDD-HHMMSS>.png` |

Every agent folder contains: `agent.mjs` (entry point), `lib.mjs`, `agent.meta.json` (name, version, changelog,
inputs/outputs), `repos.json` (repos to visit), `run.cmd` (launcher), `test/`, `screenshots/` (output), `profile/`
(saved Chrome session, created on first run), `node_modules/`.

### Repos covered (all agents, from each agent's `repos.json`)

```
HylandExperience/fcc-cus-component-registration
HylandExperience/fcc-cus-guided-upgrade-assistant
HylandExperience/fcc-cus-server-inventory
HylandExperience/fcc-seu-artifact-registry
HylandExperience/fcc-seu-orchestrator
HylandExperience/fcc-seu-tenant-inventory
HylandExperience/fcc-seu-ui
HylandExperience/tf-config-fccseu-infrastructure
```

Edit a `repos.json` to change the list (`Owner/name` or a github.com URL per entry).

## What every run does

1. Opens Google Chrome on the agent's own saved profile and goes to GitHub.
2. **Waits for you** to sign in. If the org requires SAML SSO it follows the redirect to Okta and waits again
   until you finish the authenticator prompt. Do not close the browser window while it waits (up to 10 minutes).
3. For each repo, opens the page above, waits 5 s between repos, and takes a **full-page screenshot**.
4. Adds a banner at the top of every screenshot: the repo name (light-blue chip, 24 px) and the capture
   date/time (light-yellow chip, 22 px).
5. Saves the screenshot as `<repo> <Agent Name> <YYYYMMDD-HHMMSS>.png` in the agent's `screenshots\` folder.
   Existing files are never overwritten (a `(2)`, `(3)` suffix is added).
6. At the end, zips **this run's** screenshots as `<Agent Name> <YYYYMMDD-HHMMSS>.zip` in the same folder
   (no zip if nothing was captured).
7. Writes `run-manifest-<timestamp>.json` with the agent name, version, per-repo status, any warnings, and the zip name.

## Prerequisites

- Windows with **Google Chrome** installed.
- **Node.js 20 or newer** (`node -v`).
- Dependencies are already installed. On a fresh copy, run `npm install` once inside each agent folder.
- Access to the repos: the Settings pages need **admin** access. Repos you cannot administer show
  "Settings page not found" (404) and are reported as `failed` in the manifest; the run continues.

## Run one agent

Pick one of these (they are equivalent). Replace the folder name as needed.

Double-click, or from PowerShell:

```powershell
& "C:\WORKSPACE\Multi Agent\CUS Audit\Branch Specific Write Access\run.cmd"
```

```powershell
& "C:\WORKSPACE\Multi Agent\CUS Audit\Access To Deploy Changes to Production\run.cmd"
```

```powershell
& "C:\WORKSPACE\Multi Agent\CUS Audit\Github Administrator Listing\run.cmd"
```

Or with Node directly (lets you pass options):

```powershell
cd "C:\WORKSPACE\Multi Agent\CUS Audit\Branch Specific Write Access"
node agent.mjs
```

Then sign in (and finish Okta / authenticator) in the Chrome window that opens. Screenshots appear in that
agent's `screenshots\` folder.

### Options

| Option | Applies to | Default | Meaning |
|---|---|---|---|
| `--repos <file>` | all | `repos.json` | JSON array of repos to visit |
| `--out <folder>` | all | `.\screenshots` | Where screenshots, manifest and zip go |
| `--delay <ms>` | all | `5000` | Pause between repos |
| `--env <name>` | Access To Deploy Changes to Production | `prod-apply` | Environment to open ("Configure <name>") |
| `--role <name>` | Github Administrator Listing | `Admin` | Role to filter in Direct access |

Example: `node agent.mjs --repos my-repos.json --delay 8000`

## Run all agents (one after another)

```powershell
& "C:\WORKSPACE\Multi Agent\CUS Audit\run-all.cmd"
```

Order: Branch Specific Write Access → Access To Deploy Changes to Production → Github Administrator Listing.
Each agent opens its own Chrome window and its own sign-in (separate saved sessions), so you will be asked to
sign in / approve the authenticator for each one the first time (a saved session may skip this later).

Stopping rules in `run-all.cmd`:
- An agent ends with exit code **1** (some repos not accessible): normal, the next agent still runs.
- An agent ends with exit code **2** (GitHub restriction page or lost session): the whole sequence **stops**, so GitHub
  is not hit again.

## Exit codes (each agent)

| Code | Meaning |
|---|---|
| 0 | Every repo captured |
| 1 | Run finished, but at least one repo failed (e.g. no admin access / page not found) |
| 2 | Aborted: GitHub showed "Access is temporarily restricted" (bot/rate limit) or the session was lost |

## Checking results

- Screenshots, the run zip and `run-manifest-*.json` are in each agent's `screenshots\` folder.
- In the manifest, each repo has `status` (`ok` / `failed` / `aborted`), `file`, `capturedAt`, and any `warning`:
  - Branch Specific Write Access / Github Administrator Listing: `directAccessClicked`; Github Administrator Listing also
    has `role` and `roleFilterApplied`.
  - Access To Deploy Changes to Production: `environment` and `environmentOpened`.
  - A `warning` means the page was captured but the target control was not found (the screenshot shows the
    unfiltered / list view).

## Tests

Run inside an agent folder (uses a fake local GitHub, no real login, takes about a minute):

```powershell
cd "C:\WORKSPACE\Multi Agent\CUS Audit\Branch Specific Write Access"
npm test
```

Tests cover repo-name parsing, file naming and uniqueness, the SSO wait, restriction abort, missing repos, the
zip contents and name, the banner's colours and size, and the metadata/version in the manifest.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Access is temporarily restricted" and the agent aborts | GitHub's automation / rate-limit protection. The agents deliberately stop and never retry or evade it. Wait, then run again later; use the "Submit feedback" link with the ID shown if it persists. |
| Browser sits on the Okta page | It is waiting for you: finish the sign-in and authenticator prompt, and keep the window open. |
| `failed: Settings page not found` for a repo | You lack admin access to that repo (or it does not exist). Ask a repo admin to run it. |
| `warning: No "prod-apply" environment found` | The repo has no environment with that name; the Environments list was captured instead. |
| `warning: Could not apply Role = Admin filter` | The Role control was not found on the real page, so the screenshot is unfiltered. The Role lookup was written against a fake page and has not been confirmed on real GitHub; adjust `applyRoleFilter` in that agent's `agent.mjs` if needed. |
| Chrome profile error / window will not open | Another run of the same agent is still open. Close its Chrome window (or Ctrl-C its terminal) and retry. Run agents one at a time. |

## Security notes

- Credentials are never handled by the agents. Each `profile\` folder holds a saved browser session (cookies) for
  GitHub/Okta: treat it as sensitive, do not share or commit it.
- Screenshots show repository access settings and user names: store and share them accordingly.
- Use only as allowed by Hyland's AI Use requirements.

## Changing or adding an agent

Follow [AGENT-STANDARDS.md](AGENT-STANDARDS.md): copy an existing agent folder, change the page-specific step, update
`agent.meta.json` (name, version, changelog), keep the banner / naming / zip / manifest behaviour, make `npm test` pass,
and add the new agent to `run-all.cmd` and the table above.
