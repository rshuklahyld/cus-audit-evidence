import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

/** "Owner/name" (or a github.com URL) -> { owner, name, full }. Throws on bad input. */
export function parseRepo(input) {
  const s = String(input ?? '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) throw new Error(`Invalid repo: "${input}"`);
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

const pad = (n) => String(n).padStart(2, '0');

/** Local time, filename-safe: 20261119-143005 */
export function fileStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Human readable banner text: 2026-11-19 14:30:05 (UTC+05:30) */
export function displayStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)})`;
}

/** "<repo> Github Administrator Listing <stamp>.png", never overwriting an existing file. */
export function uniqueFileName(dir, repoName, date = new Date(), exists = fs.existsSync) {
  const base = `${repoName} Github Administrator Listing ${fileStamp(date)}`;
  let candidate = `${base}.png`;
  for (let i = 2; exists(path.join(dir, candidate)); i++) candidate = `${base} (${i}).png`;
  return candidate;
}

/** GitHub's abuse / rate-limit interstitial. The agent must stop, not retry. */
export function isRestrictedPage(text) {
  return /access is temporarily restricted|unusual activity from your device|rate limit exceeded|secondary rate limit/i.test(text ?? '');
}

export function isLoginUrl(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/(login|session|sessions\/|two-factor|sso)/.test(p);
  } catch { return false; }
}

export function isNotFoundText(title = '', body = '') {
  return /page not found/i.test(title) || /^\s*404\b/.test(title) || /this is not the web page you are looking for/i.test(body);
}

/** True when the browser has been sent to the org's SAML/SSO flow (GitHub /saml or the IdP, e.g. Okta). */
export function isSsoRedirect(url, ghHost) {
  try {
    const u = new URL(url);
    return u.host !== ghHost || /^\/(orgs\/[^/]+\/|enterprises\/[^/]+\/)?(saml|sso)(\/|$)/.test(u.pathname);
  } catch { return false; }
}

/** "<agent name> <YYYYMMDD-HHMMSS>.zip" */
export function zipFileName(agentName, date = new Date()) {
  return `${agentName} ${fileStamp(date)}.zip`;
}

/**
 * Zip this run's screenshots (file names relative to outDir) into outDir, never overwriting.
 * Returns the zip file name, or null when there is nothing to zip.
 */
export function createRunZip(outDir, files, agentName, date = new Date(), exists = fs.existsSync) {
  if (!files.length) return null;
  const base = zipFileName(agentName, date).slice(0, -4);
  let name = `${base}.zip`;
  for (let i = 2; exists(path.join(outDir, name)); i++) name = `${base} (${i}).zip`;
  const zip = new AdmZip();
  for (const f of files) zip.addLocalFile(path.join(outDir, f));
  zip.writeZip(path.join(outDir, name));
  return name;
}
