import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRepo, fileStamp, displayStamp, uniqueFileName, isRestrictedPage, isLoginUrl, isNotFoundText, isSsoRedirect } from '../lib.mjs';
import { run } from '../agent.mjs';

// ---------- unit tests ----------
test('parseRepo accepts owner/name and URLs, rejects junk', () => {
  assert.deepEqual(parseRepo('HylandExperience/fcc-seu-ui'), { owner: 'HylandExperience', name: 'fcc-seu-ui', full: 'HylandExperience/fcc-seu-ui' });
  assert.equal(parseRepo('https://github.com/Org/repo.git/').full, 'Org/repo');
  for (const bad of ['', 'noslash', 'a/b/c', '../x', null]) assert.throws(() => parseRepo(bad), /Invalid repo/);
});

test('fileStamp / displayStamp formats', () => {
  const d = new Date(2026, 10, 19, 14, 3, 5);
  assert.equal(fileStamp(d), '20261119-140305');
  assert.match(displayStamp(d), /^2026-11-19 14:03:05 \(UTC[+-]\d\d:\d\d\)$/);
});

test('uniqueFileName has required text and never collides', () => {
  const d = new Date(2026, 10, 19, 14, 3, 5);
  const taken = new Set();
  const exists = (p) => taken.has(path.basename(p));
  const a = uniqueFileName('x', 'fcc-seu-ui', d, exists); taken.add(a);
  const b = uniqueFileName('x', 'fcc-seu-ui', d, exists); taken.add(b);
  const c = uniqueFileName('x', 'fcc-seu-ui', d, exists);
  assert.equal(a, 'fcc-seu-ui Access To Deploy Changes to Production 20261119-140305.png');
  assert.equal(b, 'fcc-seu-ui Access To Deploy Changes to Production 20261119-140305 (2).png');
  assert.equal(c, 'fcc-seu-ui Access To Deploy Changes to Production 20261119-140305 (3).png');
});

test('isSsoRedirect detects SAML and IdP hops', () => {
  assert.ok(isSsoRedirect('https://github.com/orgs/HylandExperience/saml/initiate', 'github.com'));
  assert.ok(isSsoRedirect('https://hyland.okta.com/app/githubcloud/x/sso/saml', 'github.com'));
  assert.ok(!isSsoRedirect('https://github.com/Org/r/settings/environments', 'github.com'));
});

test('page classifiers', () => {
  assert.ok(isRestrictedPage('Access is temporarily restricted\nWe detected unusual activity'));
  assert.ok(!isRestrictedPage('Collaborators and teams'));
  assert.ok(isLoginUrl('https://github.com/login?return_to=x'));
  assert.ok(isLoginUrl('https://github.com/sessions/two-factor'));
  assert.ok(!isLoginUrl('https://github.com/Org/r/settings/environments'));
  assert.ok(isNotFoundText('Page not found · GitHub', ''));
  assert.ok(!isNotFoundText('Collaborators', 'hello'));
});

// ---------- integration tests against a fake GitHub ----------
function startFake() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    const authed = /sid=ok/.test(req.headers.cookie ?? '');
    const html = (code, body, title = 'GitHub') => {
      res.writeHead(code, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><title>${title}</title>${authed ? '<meta name="user-login" content="tester">' : ''}</head><body>${body}</body></html>`);
    };
    if (u.pathname === '/do-login') { res.writeHead(302, { 'set-cookie': 'sid=ok; Path=/', location: '/' }); return res.end(); }
    if (u.pathname === '/login' || u.pathname === '/') return html(200, authed ? 'Home' : 'Sign in');
    if (u.pathname === '/orgs/Org/saml/initiate') return html(200, '<h1>SSO (Okta stand-in)</h1>');
    if (u.pathname === '/sso-done') { res.writeHead(302, { 'set-cookie': 'sso=ok; Path=/', location: '/Org/sso/settings/environments' }); return res.end(); }
    const edit = /^\/([^/]+)\/([^/]+)\/settings\/environments\/1\/edit$/.exec(u.pathname);
    if (edit) return html(200, `<h1>prod-apply</h1><p>Deployment protection rules: Required reviewers for ${edit[2]}</p>`);
    const m = /^\/([^/]+)\/([^/]+)\/settings\/environments$/.exec(u.pathname);
    if (!m) return html(404, 'nope', 'Page not found');
    if (!authed) { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (m[2] === 'sso' && !/sso=ok/.test(req.headers.cookie ?? '')) return html(200, '<h1>Loading</h1><script>setTimeout(() => { location = "/orgs/Org/saml/initiate"; }, 600)</script>');
    if (m[2] === 'missing') return html(404, 'This is not the web page you are looking for', 'Page not found · GitHub');
    if (m[2] === 'restricted') return html(200, 'Access is temporarily restricted. We detected unusual activity from your device or network.');
    if (m[2] === 'noprod') return html(200, '<h1>Environments</h1><a href="#">staging</a>');
    return html(200, `<h1>Environments</h1><a aria-label="Configure prod-apply" href="/${m[1]}/${m[2]}/settings/environments/1/edit">settings</a>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

async function harness(repos, extra = {}) {
  const fake = await startFake();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  const outDir = path.join(tmp, 'shots');
  try {
    const res = await run({
      repos, outDir, baseUrl: fake.base, profileDir: path.join(tmp, 'profile'), headless: true,
      delayMs: 50, authTimeoutMs: 15000, log: () => {},
      onLoginPrompt: async (page) => { await page.goto(`${fake.base}/do-login`); }, // simulates the human signing in
      ...extra,
    });
    return { ...res, fake, outDir, files: fs.existsSync(outDir) ? fs.readdirSync(outDir) : [] };
  } finally {
    fake.server.close();
  }
}

test('happy path: waits for login, clicks Configure prod-apply, saves uniquely named screenshots', { timeout: 90000 }, async () => {
  const r = await harness(['Org/alpha', 'Org/beta']);
  assert.equal(r.aborted, null);
  assert.deepEqual(r.results.map((x) => x.status), ['ok', 'ok']);
  assert.ok(r.results.every((x) => x.environmentOpened === true));
  const pngs = r.files.filter((f) => f.endsWith('.png'));
  assert.equal(pngs.length, 2);
  assert.ok(pngs.some((f) => /^alpha Access To Deploy Changes to Production \d{8}-\d{6}\.png$/.test(f)));
  assert.ok(pngs.some((f) => /^beta Access To Deploy Changes to Production \d{8}-\d{6}\.png$/.test(f)));
  for (const f of pngs) assert.ok(fs.statSync(path.join(r.outDir, f)).size > 2000, `${f} should be a real image`);
  assert.ok(r.results.every((x) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(UTC/.test(x.capturedAt)));
  assert.ok(r.files.some((f) => f.startsWith('run-manifest-')));
});

test('same repo twice with a frozen clock still yields unique files', { timeout: 90000 }, async () => {
  const frozen = new Date(2026, 10, 19, 9, 0, 0);
  const r = await harness(['Org/alpha', 'Org/alpha'], { now: () => frozen });
  const pngs = r.files.filter((f) => f.endsWith('.png'));
  assert.equal(new Set(pngs).size, 2);
  assert.ok(pngs.some((f) => f.endsWith('(2).png')));
});

test('repo without the prod-apply environment is captured with a warning', { timeout: 90000 }, async () => {
  const r = await harness(['Org/noprod']);
  assert.equal(r.results[0].status, 'ok');
  assert.equal(r.results[0].environmentOpened, false);
  assert.match(r.results[0].warning, /No "prod-apply" environment/);
});

test('inaccessible repo is reported failed and the run continues', { timeout: 90000 }, async () => {
  const r = await harness(['Org/missing', 'Org/alpha']);
  assert.equal(r.results[0].status, 'failed');
  assert.match(r.results[0].error, /not found/i);
  assert.equal(r.results[1].status, 'ok');
  assert.equal(r.files.filter((f) => f.endsWith('.png')).length, 1);
  assert.equal(r.aborted, null);
});

test('SSO redirect: waits for the human to finish SSO instead of aborting, then captures', { timeout: 90000 }, async () => {
  const logs = [];
  const fake = await startFake();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sso-'));
  try {
    let simulated = false;
    const r = await run({
      repos: ['Org/sso'], outDir: path.join(tmp, 's'), baseUrl: fake.base, profileDir: path.join(tmp, 'p'), headless: true,
      delayMs: 10, authTimeoutMs: 20000, log: (m) => { logs.push(m); if (/sign-in required/.test(m) && !simulated) { simulated = true; setTimeout(() => { /* human completes SSO */ globalThis.__page?.goto(`${fake.base}/sso-done`); }, 1500); } },
      onLoginPrompt: async (page) => { globalThis.__page = page; await page.goto(`${fake.base}/do-login`); },
    });
    assert.equal(r.aborted, null);
    assert.equal(r.results[0].status, 'ok', JSON.stringify(r.results[0]));
    assert.ok(logs.some((m) => /sign-in completed/.test(m)));
  } finally { fake.server.close(); }
});

test('restriction page aborts the run immediately and never retries or continues', { timeout: 90000 }, async () => {
  const r = await harness(['Org/alpha', 'Org/restricted', 'Org/beta']);
  assert.match(r.aborted, /restricted/i);
  assert.deepEqual(r.results.map((x) => x.status), ['ok', 'aborted']);
  assert.equal(r.fake.hits.filter((p) => p.includes('/beta/')).length, 0, 'must not touch repos after restriction');
  assert.equal(r.fake.hits.filter((p) => p.includes('/restricted/')).length, 1, 'must not retry');
});

test('agent metadata: name, version 1.0, and it is recorded in the run manifest', { timeout: 90000 }, async () => {
  const { AGENT_META } = await import('../agent.mjs');
  assert.equal(AGENT_META.displayName, 'Agent Name : Access To Deploy Changes to Production');
  assert.equal(AGENT_META.version, '1.2.0');
  assert.ok(fs.existsSync(new URL('../agent.meta.json', import.meta.url)));
  const r = await harness(['Org/alpha']);
  const m = JSON.parse(fs.readFileSync(path.join(r.outDir, r.files.find((f) => f.startsWith('run-manifest-'))), 'utf8'));
  assert.equal(m.agent, 'Agent Name : Access To Deploy Changes to Production');
  assert.equal(m.version, '1.2.0');
});

test('run zips this run screenshots as "<agent name> <date time>.zip"', { timeout: 90000 }, async () => {
  const { default: AdmZip } = await import('adm-zip');
  const { AGENT_META } = await import('../agent.mjs');
  const r = await harness(['Org/alpha', 'Org/beta']);
  assert.ok(r.zip, 'zip name returned');
  assert.ok(r.zip.startsWith(AGENT_META.agentName + ' '));
  assert.ok(r.zip.endsWith('.zip'));
  const stamp = r.zip.slice(AGENT_META.agentName.length + 1, -4);
  assert.equal(stamp.length, 15);
  assert.equal(stamp[8], '-');
  assert.ok(!Number.isNaN(Number(stamp.replace('-', ''))));
  assert.ok(r.files.includes(r.zip));
  const entries = new AdmZip(path.join(r.outDir, r.zip)).getEntries().map((e) => e.entryName);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((n) => n.endsWith('.png')));
  assert.deepEqual([...entries].sort(), r.files.filter((f) => f.endsWith('.png')).sort());
});

test('no zip when nothing was captured', { timeout: 90000 }, async () => {
  const r = await harness(['Org/restricted']);
  assert.equal(r.zip, null);
  assert.ok(!r.files.some((f) => f.endsWith('.zip')));
});

test('capture banner is highlighted with light backgrounds and large text', { timeout: 60000 }, async () => {
  const { chromium } = await import('playwright-core');
  const { stampPage } = await import('../agent.mjs');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<body><p>content</p></body>');
    await stampPage(page, 'Org/alpha', '2026-11-22 13:00:00 (UTC+05:30)');
    const s = await page.evaluate(() => {
      const g = (id) => { const e = document.getElementById(id); const c = getComputedStyle(e); return { text: e.textContent, bg: c.backgroundColor, size: parseFloat(c.fontSize) }; };
      return { repo: g('__agent_repo'), time: g('__agent_time'), first: document.body.firstElementChild.id };
    });
    assert.equal(s.first, '__agent_stamp', 'banner is at the top of the page');
    assert.equal(s.repo.text, 'Org/alpha');
    assert.match(s.time.text, /2026-11-22 13:00:00/);
    for (const chip of [s.repo, s.time]) {
      assert.ok(chip.size >= 20, 'text is larger than normal (' + chip.size + 'px)');
      const rgb = chip.bg.replace('rgb(', '').replace(')', '').split(',').map(Number);
      assert.ok(Math.min(...rgb) >= 190, 'light background: ' + chip.bg);
    }
  } finally { await browser.close(); }
});

test('invalid repo input fails fast before opening a browser', async () => {
  await assert.rejects(run({ repos: ['bad'], outDir: os.tmpdir() }), /Invalid repo/);
});
