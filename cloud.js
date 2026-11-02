// Supabase over plain fetch: email-link sign-in (GoTrue) and table access (PostgREST).
// Only the sign-in session is kept in the browser; the data itself lives in the database.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const SESSION_KEY = 'finance:session';
const PAGE = 1000; // Supabase returns at most 1000 rows per request

export const configured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// ── session ──────────────────────────────────────────────────────────────────

let session = readSession();

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function writeSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode: the session lasts until the tab closes */ }
}
const toSession = (d) => ({
  accessToken: d.access_token,
  refreshToken: d.refresh_token,
  expiresAt: d.expires_at ? d.expires_at * 1000 : Date.now() + Number(d.expires_in) * 1000,
  user: d.user ?? session?.user ?? null,
});

export const currentUser = () => session?.user ?? null;

async function auth(path, body) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Can't reach ${SUPABASE_URL}. Check your connection, and that SUPABASE_URL in config.js is the project's API address (https://<project-ref>.supabase.co).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `Sign-in failed (${res.status})`);
  return data;
}

// Sends the sign-in email. The link brings you back to `redirectTo` with the session in the URL hash.
export function sendSignInLink(email, redirectTo) {
  return auth(`otp?redirect_to=${encodeURIComponent(redirectTo)}`, { email, create_user: true });
}

// Call once on page load: picks up the session from a sign-in link, if the URL carries one.
export async function completeSignIn() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_description')) {
    history.replaceState(null, '', location.pathname + location.search);
    throw new Error(hash.get('error_description'));
  }
  if (!hash.get('access_token')) return false;
  history.replaceState(null, '', location.pathname + location.search);
  writeSession(toSession(Object.fromEntries(hash)));
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: await headers() });
  if (res.ok) writeSession({ ...session, user: await res.json() });
  return true;
}

async function refresh() {
  try {
    writeSession(toSession(await auth('token?grant_type=refresh_token', { refresh_token: session.refreshToken })));
  } catch (err) {
    writeSession(null);
    throw new SignedOut(err.message);
  }
}

export class SignedOut extends Error {}

async function headers(extra = {}) {
  if (!session) throw new SignedOut('Not signed in');
  if (session.expiresAt - 60_000 < Date.now()) await refresh();
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', ...extra };
}

export async function signOut() {
  if (session) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: await headers().catch(() => ({})) }).catch(() => {});
  }
  writeSession(null);
}

// ── tables ───────────────────────────────────────────────────────────────────

async function rest(path, opts = {}, retried = false) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: await headers(opts.headers) });
  if (res.status === 401 && !retried) { await refresh(); return rest(path, opts, true); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Database error (${res.status})`);
  }
  // With `count`: the rows and the table's total, from the Content-Range header ("0-999/21398").
  if (opts.count) return { rows: await res.json(), total: Number(res.headers.get('content-range')?.split('/')[1]) };
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Whether `table` has all of `columns` (asks for none of the rows).
export async function hasColumns(table, columns) {
  try {
    await rest(`${table}?select=${columns.join(',')}&limit=0`);
    return true;
  } catch (err) {
    if (err instanceof SignedOut) throw err;
    return false;
  }
}

// Pages through the table in a stable order (`orderBy` must be unique per user). The first page
// also brings the row count, so the other pages are fetched side by side, a few at a time, instead
// of one after another (21 000 transactions are 22 pages).
const PARALLEL = 8;
// `filter` narrows it, as PostgREST query parameters (e.g. "&account_id=eq.abc").
export async function selectAll(table, orderBy = 'id', filter = '') {
  const page = (offset, opts) => rest(`${table}?select=*${filter}&order=${orderBy}&limit=${PAGE}&offset=${offset}`, opts);
  const { rows: first, total } = await page(0, { count: true, headers: { Prefer: 'count=exact' } });
  if (first.length < PAGE) return first;
  const out = [first];
  if (!Number.isFinite(total)) { // no count came back: one page after another
    for (let offset = PAGE; ; offset += PAGE) {
      const rows = await page(offset);
      out.push(rows);
      if (rows.length < PAGE) return out.flat();
    }
  }
  const offsets = [];
  for (let offset = PAGE; offset < total; offset += PAGE) offsets.push(offset);
  for (let i = 0; i < offsets.length; i += PARALLEL) {
    out.push(...await Promise.all(offsets.slice(i, i + PARALLEL).map((offset) => page(offset))));
  }
  return out.flat();
}

// Calls one of the database functions in schema.sql (they return JSON).
export const rpc = (name, args = {}) => rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });

export async function upsert(table, rows, conflict = 'user_id,id') {
  for (let i = 0; i < rows.length; i += 500) {
    await rest(`${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
}

// Deletes every row of the signed-in user in `table`, in one request.
export async function removeAll(table) {
  const userId = currentUser()?.id;
  if (!userId) throw new SignedOut('Not signed in');
  await rest(`${table}?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

export async function remove(table, ids) {
  for (let i = 0; i < ids.length; i += 100) {
    const list = ids.slice(i, i + 100).map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',');
    await rest(`${table}?id=in.(${encodeURIComponent(list)})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
}
