# CUS Audit agent standards

Every agent in this folder (existing and future) must follow these. Start a new agent by copying an existing
agent folder (e.g. `Access To Deploy Changes to Production`) so these come for free.

1. **Layout:** one folder per agent, named exactly like the agent. Contains `agent.mjs`, `lib.mjs`, `agent.meta.json`
   (name, version, changelog, home), `repos.json`, `run.cmd`, `test/`, `screenshots/`.
2. **Auth:** the human signs in (SSO + authenticator). The agent never handles credentials, waits through Okta/SAML,
   and aborts (never retries or evades) on a GitHub restriction page.
3. **Capture banner:** every screenshot has a banner at the top of the page with the repo name and the capture
   date/time as light-background chips with large text (24px / 22px). Use `stampPage(page, repoFull, whenText)`.
4. **Screenshot name:** `<repo> <Agent Name> <YYYYMMDD-HHMMSS>.png`, never overwriting (`(2)`, `(3)` suffix).
5. **Zip:** at the end of a run, this run's screenshots are zipped into the output folder as
   `<Agent Name> <YYYYMMDD-HHMMSS>.zip` (`createRunZip`). No zip when nothing was captured.
6. **Manifest:** `run-manifest-*.json` records agent, version, per-repo status, and the zip name.
7. **Tests:** `npm test` must pass (unit + fake-GitHub integration), including banner style and zip tests.
8. **Versioning:** bump `version` in `agent.meta.json` and `package.json`, and add a changelog entry, on every change.
