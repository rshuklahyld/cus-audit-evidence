// On-demand agent: you sign in to GitHub (incl. authenticator app), then it opens each repo's
// Settings > Collaborators and teams, clicks "Direct access", filters Role = Admin, stamps date/time, and saves a screenshot.
// Usage: node agent.mjs [--repos repos.json] [--out ./screenshots] [--role Admin] [--delay 5000]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepo, displayStamp, uniqueFileName, isRestrictedPage, isLoginUrl, isNotFoundText, isSsoRedirect, createRunZip } from './lib.mjs';

const here0 = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_META = JSON.parse(fs.readFileSync(path.join(here0, 'agent.meta.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isAuthenticated(page) {
  try {
    const login = await page.locator('meta[name="user-login"]').first().getAttribute('content', { timeout: 1500 });
    return !!(login && login.trim());
  } catch { return false; }
}

/** Capture banner: repo name and date/time as light-coloured, large "chips" at the top of the page. */
export async function stampPage(page, repoFull, whenText) {
  await page.evaluate(({ repoFull, whenText }) => {
    document.getElementById('__agent_stamp')?.remove();
    const bar = document.createElement('div');
    bar.id = '__agent_stamp';
    bar.style.cssText = 'display:block;width:100%;box-sizing:border-box;background:#f6f8fa;border-bottom:3px solid #d0d7de;padding:12px 16px;text-align:center;font-family:Segoe UI,Arial,sans-serif;';
    const chip = (id, label, text, bg, border) => {
      const el = document.createElement('span');
      el.id = id;
      el.textContent = text;
      el.title = label;
      el.style.cssText = 'display:inline-block;margin:4px 10px;padding:6px 14px;border-radius:8px;font-weight:700;color:#1f2328;background:' + bg + ';border:2px solid ' + border + ';';
      return el;
    };
    const repo = chip('__agent_repo', 'Repository', repoFull, '#ddf4ff', '#54aeff');
    repo.style.fontSize = '24px';
    const time = chip('__agent_time', 'Captured', 'Captured ' + whenText, '#fff8c5', '#d4a72c');
    time.style.fontSize = '22px';
    bar.append(repo, time);
    document.body.prepend(bar);
  }, { repoFull, whenText });
}

async function clickDirectAccess(page) {
  const candidates = [
    page.getByRole('tab', { name: /direct access/i }),
    page.getByRole('link', { name: /direct access/i }),
    page.getByRole('button', { name: /direct access/i }),
    page.getByText(/^\s*direct access/i),
  ];
  for (const c of candidates) {
    const first = c.first();
    if (await first.count()) {
      await first.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

/** In the Direct access list, open the "Role" filter and choose the given role (default Admin). */
async function applyRoleFilter(page, role) {
  const roleRe = new RegExp(`^\\s*${role}\\s*$`, 'i');
  const openers = [
    page.getByRole('button', { name: /^\s*role\b/i }),
    page.getByRole('combobox', { name: /role/i }),
    page.getByText(/^\s*role\s*$/i),
  ];
  let opened = false;
  for (const o of openers) {
    const first = o.first();
    if (await first.count()) {
      await first.click({ timeout: 5000 });
      opened = true;
      break;
    }
  }
  if (!opened) return false;
  const options = [
    page.getByRole('menuitemradio', { name: roleRe }),
    page.getByRole('menuitem', { name: roleRe }),
    page.getByRole('option', { name: roleRe }),
    page.getByRole('radio', { name: roleRe }),
    page.getByRole('button', { name: roleRe }),
    page.getByText(roleRe),
  ];
  for (const c of options) {
    const first = c.first();
    if (await first.count()) {
      await first.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

/**
 * @returns {Promise<{results: object[], aborted: string|null}>}
 */
export async function run({
  repos,
  outDir,
  baseUrl = 'https://github.com',
  profileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'profile'),
  channel = 'chrome',
  headless = false,
  delayMs = 5000,
  role = AGENT_META.inputs.role,
  authTimeoutMs = 10 * 60 * 1000,
  onLoginPrompt = null, // test hook; in real use the human signs in
  log = console.log,
  now = () => new Date(),
}) {
  const parsed = repos.map(parseRepo);
  log(`${AGENT_META.displayName} (v${AGENT_META.version})`);
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: channel || undefined, headless, viewport: { width: 1400, height: 1000 },
  });
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  const ghHost = new URL(baseUrl).host;
  const watch = (p) => {
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) { try { log(`  [nav] ${new URL(f.url()).host}${new URL(f.url()).pathname}`); } catch {} } });
    p.on('close', () => log('  [browser] a tab closed'));
    p.on('crash', () => log('  [browser] a tab CRASHED'));
  };
  ctx.on('page', (p) => { log('  [browser] new tab/popup opened (kept open)'); watch(p); });
  ctx.on('close', () => log('  [browser] browser window was closed'));
  ctx.pages().forEach(watch);
  const results = [];
  let aborted = null;
  try {
    // Step 1: human authentication (GitHub -> Okta SSO -> authenticator -> back to GitHub)
    await page.goto(`${baseUrl}/login`);
    const findAuthed = async () => {
      for (const p of ctx.pages()) {
        if (p.isClosed()) continue;
        let host = '';
        try { host = new URL(p.url()).host; } catch { continue; }
        // Never touch a page while it is on the IdP (Okta) domain: just let the human work.
        if (host === ghHost && (await isAuthenticated(p))) return p;
      }
      return null;
    };
    let authed = await findAuthed();
    if (!authed) {
      log('Please sign in to GitHub in the browser window (SSO + authenticator). Do not close it. Waiting...');
      if (onLoginPrompt) await onLoginPrompt(page);
      const deadline = Date.now() + authTimeoutMs;
      while (!(authed = await findAuthed())) {
        if (!ctx.pages().length) throw new Error('Browser was closed before login completed');
        if (Date.now() > deadline) throw new Error('Timed out waiting for login');
        await sleep(1000);
      }
    }
    page = authed;
    log('Authenticated. Starting captures.');

    // Step 2-5
    for (const [i, repo] of parsed.entries()) {
      if (i > 0) await sleep(delayMs);
      const url = `${baseUrl}/${repo.full}/settings/access`;
      const entry = { repo: repo.full, url, status: 'pending' };
      results.push(entry);
      try {
        let resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const needsHuman = (u) => isSsoRedirect(u, ghHost) || isLoginUrl(u);
        const onTarget = () => page.url().toLowerCase().includes(`/${repo.full.toLowerCase()}/settings/access`);
        // GitHub often redirects to SAML/Okta from the page's own script *after* domcontentloaded,
        // so let the page settle before judging where we are, then wait for the human if needed.
        for (let round = 0; round < 3; round++) {
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await sleep(2000);
          if (!needsHuman(page.url())) break;
          log(`SSO/sign-in required for ${repo.full}. Complete the Okta sign-in / authenticator in the browser (do not close it). Waiting...`);
          await page.waitForURL((u) => !needsHuman(u.toString()), { timeout: authTimeoutMs });
          log('SSO/sign-in completed.');
          await sleep(1500);
          if (!onTarget()) resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
        }
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const body = (await page.locator('body').innerText().catch(() => '')) || '';
        if (isRestrictedPage(body)) {
          entry.status = 'aborted';
          entry.error = 'GitHub restricted access (bot/rate limit). Stopping; not retrying.';
          aborted = entry.error;
          break;
        }
        if (isLoginUrl(page.url()) || !(await isAuthenticated(page))) {
          entry.status = 'failed'; entry.error = 'Not authenticated (session lost)';
          aborted = entry.error;
          break;
        }
        if (resp?.status() === 404 || isNotFoundText(await page.title(), body)) {
          entry.status = 'failed';
          entry.error = 'Settings page not found (no admin access or repo missing)';
          continue;
        }
        entry.directAccessClicked = await clickDirectAccess(page);
        entry.role = role;
        entry.roleFilterApplied = entry.directAccessClicked ? await applyRoleFilter(page, role) : false;
        if (!entry.roleFilterApplied) entry.warning = `Could not apply Role = ${role} filter; screenshot shows the unfiltered page`;
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await sleep(1000);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const when = now();
        entry.capturedAt = displayStamp(when);
        await stampPage(page, repo.full, entry.capturedAt);
        const file = uniqueFileName(outDir, repo.name, when);
        await page.screenshot({ path: path.join(outDir, file), fullPage: true });
        entry.file = file;
        entry.status = 'ok';
        log(`Saved ${file}`);
      } catch (e) {
        entry.status = 'failed';
        entry.error = String(e.message ?? e);
      }
    }
  } finally {
    await ctx.close();
  }
  let zip = null;
  try {
    const shots = results.filter((r) => r.file).map((r) => r.file);
    zip = createRunZip(outDir, shots, AGENT_META.agentName, now());
    if (zip) log(`Zipped ${shots.length} screenshot(s): ${zip}`);
  } catch (e) { log(`Could not create zip: ${e.message}`); }
  const manifest = path.join(outDir, `run-manifest-${displayStamp(now()).replace(/[: ()+]/g, '-')}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ agent: AGENT_META.displayName, version: AGENT_META.version, results, aborted, zip }, null, 2));
  return { results, aborted, zip };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repos = JSON.parse(fs.readFileSync(path.resolve(arg('repos', path.join(here, 'repos.json'))), 'utf8'));
  const outDir = path.resolve(arg('out', path.join(here, 'screenshots')));
  const { results, aborted } = await run({ repos, outDir, delayMs: Number(arg('delay', 5000)), role: arg('role', AGENT_META.inputs.role) });
  console.table(results.map(({ repo, status, file, error }) => ({ repo, status, file, error })));
  if (aborted) { console.error(`ABORTED: ${aborted}`); process.exit(2); }
  process.exit(results.every((r) => r.status === 'ok') ? 0 : 1);
}
