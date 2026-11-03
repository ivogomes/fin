// Backups to Google Drive, from the browser. Google's sign-in library asks for permission to the
// files Fin itself creates (the drive.file scope: nothing else in your Drive is visible to it), then
// the backup .zip goes to a "Fin backups" folder, keeping the latest few. The permission is a token
// that lasts about an hour; after that Google gives a new one, usually without asking again.

import { GOOGLE_CLIENT_ID } from './config.js';
import { currentUser } from './cloud.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'Fin backups';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size';
export const KEEP = 10; // backups kept in the folder; older ones go to the bin

export const driveConfigured = () => Boolean(GOOGLE_CLIENT_ID);

let token = null; // { value, expires }
let library = null;
// Google's sign-in library (also used to sign in to Fin, below), loaded once when first needed.
export function loadLibrary() {
  library ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => { library = null; reject(new Error('Couldn’t reach Google. Check your connection.')); };
    document.head.append(s);
  });
  return library;
}

// A token for Drive. `interactive`: from a click, so Google may show its window (to pick the account
// or give permission the first time). Without it, Google is asked not to show anything; that fails
// when it would need to, and the caller offers a button instead.
async function getToken(interactive) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const google = await loadLibrary();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      prompt: interactive ? '' : 'none',
      // Pre-select the Google account Fin is signed in with, so connecting is one click.
      ...(currentUser()?.email && { login_hint: currentUser().email }),
      callback: (r) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        token = { value: r.access_token, expires: Date.now() + Number(r.expires_in) * 1000 };
        resolve(token.value);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'The Google window was closed.' : e.message || e.type)),
    });
    client.requestAccessToken();
  });
}

async function call(url, opts = {}, interactive = false) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${await getToken(interactive)}`, ...opts.headers } });
  if (res.status === 401) { token = null; throw new Error('Google asked to sign in again.'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Google Drive answered ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// The "Fin backups" folder (one Fin made), created the first time.
async function folderId(interactive) {
  const q = encodeURIComponent(`name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await call(`${API}/files?q=${q}&fields=files(id)&spaces=drive`, {}, interactive);
  if (found.files?.length) return found.files[0].id;
  const made = await call(`${API}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  }, interactive);
  return made.id;
}

// The backups in the folder, newest first: [{ id, name, createdTime, size }].
export async function listBackups({ interactive = false } = {}) {
  const folder = await folderId(interactive);
  const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
  const r = await call(`${API}/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=100`, {}, interactive);
  return r.files ?? [];
}

// Uploads `bytes` (a .zip) as `name` into the folder, then moves all but the newest KEEP to the bin
// (Drive empties it after 30 days). Returns the new file.
export async function uploadBackup(name, bytes, { interactive = false } = {}) {
  const folder = await folderId(interactive);
  const boundary = `fin-${Math.random().toString(36).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, parents: [folder], mimeType: 'application/zip' }),
    `\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const file = await call(UPLOAD, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, interactive);
  const all = await listBackups();
  for (const old of all.slice(KEEP)) {
    await call(`${API}/files/${old.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }
  return file;
}

// Whether Drive can be used without asking: Google keeps the permission per Google account, not per
// browser, so after signing in with Google (login_hint) it usually answers at once. False when
// Google would need to show its window; then a click (interactive) is needed.
export async function canUseSilently() {
  try { await getToken(false); return true; } catch { return false; }
}

// The Google account the backups go to: { emailAddress, displayName, photoLink }, or null.
export async function driveAccount() {
  try { return (await call(`${API}/about?fields=user(emailAddress,displayName,photoLink)`)).user ?? null; } catch { return null; }
}

// Forgets the permission (Google's side too), for "Disconnect".
export async function disconnect() {
  if (token) {
    const google = await loadLibrary().catch(() => null);
    google?.accounts.oauth2.revoke(token.value, () => {});
  }
  token = null;
}

// ── Signing in to Fin with Google ────────────────────────────────────────────

// Draws Google's "Sign in with Google" button into `el`. Google hands back a signed ID token that
// says who you are (no access to anything); `onToken(idToken, nonce)` swaps it for a Supabase
// session. The nonce ties the token to this page: Google gets its SHA-256, Supabase the original,
// so a token picked up elsewhere can't be replayed. Rejects when Google can't be reached.
export async function renderGoogleButton(el, { onToken, dark = false }) {
  const google = await loadLibrary();
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce)));
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
    callback: (r) => onToken(r.credential, nonce),
    itp_support: true,
  });
  google.accounts.id.renderButton(el, {
    type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', text: 'signin_with', shape: 'pill',
    logo_alignment: 'center', width: Math.min(400, Math.max(200, Math.round(el.getBoundingClientRect().width) || 320)),
  });
}
