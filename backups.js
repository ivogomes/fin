// Backups: download, restore, and Google Drive.

import { currentUser } from './cloud.js';
import {
  KEEP as DRIVE_KEEP, canUseSilently, driveAccount, driveConfigured, disconnect as driveDisconnect,
  listBackups, uploadBackup,
} from './drive.js';
import { today } from './market.js';
import { toCsv } from './model.js';
import {
  BACKUP_TABLES, backupData, clearTables, loadAllTransactions, persist, restoreData,
  transactionsComplete,
} from './store.js';
import { makeZip, readZip } from './zip.js';
import {
  avatar, byName, refreshRates, render, setEditingTxId, setTxPage, setView, showToast, state,
} from './app.js';
import { download, readableCsvs } from './imports.js';
import { renderWhenIdle, selected } from './transactions.js';
import { button, field, h, input, loader, num, readPref, say, select, writePref } from './ui.js';

// ── backups ──────────────────────────────────────────────────────────────────

export function downloadBytes(name, bytes, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// One .zip with everything: backup.json (restores exactly, links included) and the same data as
// readable CSV files. API keys aren't in it, so the file is safe to keep in cloud storage.
// The backup .zip: { name, bytes }. A backup has every transaction, wherever it's made from (the
// reminder shows on any page), so they're all loaded first.
export async function buildBackup() {
  if (!transactionsComplete()) {
    say('Getting all your transactions for the backup…');
    await loadAllTransactions();
  }
  const data = backupData();
  const counts = Object.entries(data.tables).filter(([, rows]) => rows.length).map(([t, rows]) => `${rows.length} ${t}`).join(', ');
  const readme = [
    `Fin backup, ${new Date().toLocaleString()}`,
    '',
    'backup.json holds everything and restores it exactly: open Fin, Settings → Backup and restore → Restore.',
    'The .csv files are the same data to read in Excel, Numbers or Google Sheets.',
    'API keys aren’t included; add them again in Settings → Market data after a restore.',
    '',
    `Contents: ${counts}.`,
  ].join('\r\n');
  const csvs = readableCsvs();
  const bytes = makeZip([
    { name: 'README.txt', data: readme },
    { name: 'backup.json', data: JSON.stringify(data) },
    ...Object.entries(csvs).map(([k, rows]) => ({ name: `${k}.csv`, data: toCsv(rows) })),
  ]);
  return { name: `finance-backup-${today()}.zip`, bytes };
}

export async function downloadBackup() {
  let backup;
  try { backup = await buildBackup(); } catch (err) { say(`Couldn’t make the backup: ${err.message}`); return; }
  downloadBytes(backup.name, backup.bytes, 'application/zip');
  state.settings.lastBackupAt = new Date().toISOString();
  persist();
  render();
  say('Backup downloaded. Keep it somewhere safe, like iCloud Drive or Google Drive.');
}

// Backups to Google Drive (drive.js), once connected in this browser: made when Fin opens and one is
// due, or from a button. `interactive`: from a click, so Google may show its window.
export let driveBusy = false;
export let driveFailed = null; // why the backup made on opening didn't go through, for the Overview's alert
// finance:drive is true once connected in this browser, false after Disconnect, unset before either.
export const driveOn = () => driveConfigured() && readPref('finance:drive', null) === true;
// Signed in with Google (or with an email that has Google linked): that account's Drive can be used
// without connecting it again in each browser.
export const googleUser = () => Boolean(currentUser()?.app_metadata?.providers?.includes('google') || currentUser()?.app_metadata?.provider === 'google');
// On opening Fin signed in with Google, in a browser where Drive was never connected or disconnected:
// use it when Google already has the permission (given in another browser, say), without asking.
export async function adoptGoogleDrive() {
  if (!driveConfigured() || !googleUser() || readPref('finance:drive', null) !== null) return;
  if (!(await canUseSilently())) return;
  writePref('finance:drive', true);
  driveFiles = null;
  renderWhenIdle();
}
export async function backupToDrive({ interactive = false } = {}) {
  if (driveBusy) return false;
  driveBusy = true;
  if (interactive) say('Backing up to Google Drive…');
  try {
    const backup = await buildBackup();
    await uploadBackup(backup.name, backup.bytes, { interactive });
    writePref('finance:drive', true);
    state.settings.lastBackupAt = new Date().toISOString();
    persist();
    driveFiles = null;
    driveFailed = null;
    renderWhenIdle();
    say(`Backed up to Google Drive, in “Fin backups” (the latest ${DRIVE_KEEP} are kept).`);
    return true;
  } catch (err) {
    // Opening the page: Google wanted to ask something, so the Overview's alert offers the button.
    if (interactive) showToast(`Couldn’t back up to Google Drive: ${err.message}`);
    else { driveFailed = err.message || 'Google didn’t answer'; renderWhenIdle(); }
    return false;
  } finally {
    driveBusy = false;
  }
}
// The backups in Drive, for the Backup page: null until asked, then a list (or an error message).
export let driveFiles = null;
export function loadDriveFiles(interactive = false) {
  driveFiles = { loading: true };
  // The list first (it gets Google's permission, asking if need be), then whose Drive it is.
  listBackups({ interactive })
    .then(async (files) => { driveFiles = { files, account: await driveAccount() }; renderWhenIdle(); })
    .catch((err) => { driveFiles = { error: err.message }; renderWhenIdle(); });
}

export const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 864e5);
// The reminder: no backup for `backupEvery` days (0: never remind). With Google Drive backing up
// every day it doesn't show, unless those backups stop.
export function backupDue() {
  const every = state.settings.backupEvery ?? 7;
  if (!every || !state.accounts.length) return false;
  const snooze = readPref('finance:backupSnooze', null);
  if (snooze && snooze >= today()) return false;
  return !state.settings.lastBackupAt || daysSince(state.settings.lastBackupAt) >= every;
}

// Google Drive backs up once a day, the first time Fin opens that day.
export const driveBackupDue = () => state.accounts.length > 0 && (state.settings.lastBackupAt ?? '').slice(0, 10) < today();

export function backupBanner() {
  if (!state || !backupDue()) return null;
  const last = state.settings.lastBackupAt;
  const drive = driveOn() || (driveConfigured() && googleUser() && readPref('finance:drive', null) === null);
  return h('div', { class: 'fin-notice fin-legacy fin-backup-due', role: 'region', 'aria-label': 'Backup reminder' },
    h('p', {}, last
      ? `Your last backup was ${daysSince(last)} days ago. The database keeps no backups of its own, so it’s worth making one.`
      : 'You haven’t made a backup yet. The database keeps no backups of its own, so it’s worth having one.'),
    // Signed in with Google but Drive not used here yet (and not disconnected): one click starts it.
    h('div', { class: 'fin-actions' },
      drive && button('Back up to Google Drive', () => backupToDrive({ interactive: true }), 'primary'),
      button('Download backup', downloadBackup, drive ? 'secondary' : 'primary'),
      button('Remind me tomorrow', () => { writePref('finance:backupSnooze', today()); render(); }, 'secondary')));
}

export let restoreDraft = null;
export async function readRestoreFile(file) {
  try {
    let text;
    if (/\.zip$/i.test(file.name)) {
      const files = await readZip(new Uint8Array(await file.arrayBuffer()));
      const json = files.get('backup.json');
      if (!json) throw new Error('This ZIP has no backup.json in it');
      text = new TextDecoder().decode(json);
    } else text = await file.text();
    const data = JSON.parse(text);
    if (data?.format !== 'finance-backup' || !data.tables) throw new Error('This isn’t a Fin backup');
    restoreDraft = { name: file.name, data };
    render('restore-confirm');
  } catch (err) {
    say(err.message);
    showToast(`Couldn’t read ${file.name}: ${err.message}`);
  }
}

export function backupSection() {
  const last = state.settings.lastBackupAt;
  const every = select([['7', 'After a week'], ['14', 'After 2 weeks'], ['30', 'After a month'], ['0', 'Never']], String(state.settings.backupEvery ?? 7), { 'data-key': 'backup-every' });
  every.addEventListener('change', () => { state.settings.backupEvery = Number(every.value); persist(); render('backup-every'); say('Saved.'); });
  const file = input({ type: 'file', accept: '.zip,.json,application/zip,application/json', 'data-key': 'restore-file' });
  file.addEventListener('change', () => file.files[0] && readRestoreFile(file.files[0]));

  let restore;
  if (restoreDraft) {
    const d = restoreDraft.data;
    const confirmIn = input({ type: 'text', autocomplete: 'off', spellcheck: 'false', 'data-key': 'restore-confirm' });
    const go = button('Replace everything with this backup', async () => {
      go.disabled = true;
      say('Restoring…');
      try {
        await clearTables(BACKUP_TABLES);
        restoreData(d);
      } catch (err) {
        showToast(`Restore failed: ${err.message}. Try again; the backup file is unchanged.`);
        go.disabled = false;
        return;
      }
      restoreDraft = null;
      setTxPage(0); selected.clear(); setEditingTxId(null);
      const first = [...state.accounts].sort(byName).find((a) => !a.archived);
      setView(first ? { name: 'account', id: first.id } : { name: 'settings', section: 'backup' });
      render();
      say(`Restored ${state.transactions.length} transactions and ${state.accounts.length} accounts. Saving to your account…`);
      await refreshRates();
    }, 'danger', { disabled: true });
    confirmIn.addEventListener('input', () => { go.disabled = confirmIn.value.trim() !== 'RESTORE'; });
    const labels = { accounts: 'accounts', transactions: 'transactions', categories: 'categories', rules: 'rules', holdings: 'holdings', lots: 'buys and sells', schedules: 'schedules', people: 'people', ious: 'IOU entries', snapshots: 'daily values' };
    restore = [
      h('p', {}, h('strong', {}, restoreDraft.name), ` · made ${new Date(d.createdAt).toLocaleString()}`),
      h('ul', { class: 'fin-import-list' }, Object.entries(labels).filter(([t]) => d.tables[t]?.length).map(([t, label]) =>
        h('li', {}, `${d.tables[t].length} ${label}`, h('span', { class: 'fin-muted' }, ` (now ${state[t].length})`)))),
      h('p', { class: 'fin-notice' }, 'This replaces everything in your account with the backup. It can’t be undone, so download a backup of what’s there now first if you might want it.'),
      h('div', { class: 'fin-actions fin-mt' },
        button('Download a backup of what’s there now', downloadBackup, 'secondary')),
      h('div', { class: 'fin-grid fin-mt' }, field('Type RESTORE to confirm', confirmIn)),
      h('div', { class: 'fin-actions' }, go, button('Cancel', () => { restoreDraft = null; render('restore-file'); }, 'secondary')),
    ];
  }

  return h('div', {},
    backupCard(last, every),
    h('section', { class: 'fin-card fin-pad fin-danger-zone', 'aria-labelledby': 'restore-h' },
      h('h3', { id: 'restore-h', class: 'fin-label' }, 'Restore from a backup'),
      restore ?? [
        h('p', { class: 'fin-hint' }, 'Pick a backup .zip (or its backup.json). You’ll see what’s in it before anything changes.'),
        h('div', { class: 'fin-grid' }, field('Backup file', file)),
      ]));
}

// Backups: when the last one was made, Google Drive (where they go by themselves once connected) with
// what's in the folder, and Download backup next to it for a copy of your own. Without Drive, the
// download is the backup and a reminder says when one is due. `every` is the how-often menu.
export function backupCard(last, every) {
  const lastLine = h('p', {}, last
    ? `Last backup: ${new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${daysSince(last) === 0 ? 'today' : `${daysSince(last)} days ago`}).`
    : 'No backup made yet.');
  const download = (primary) => button('Download backup', downloadBackup, primary ? 'primary' : 'secondary', { 'data-key': 'backup-now' });
  const about = h('p', { class: 'fin-hint' }, 'Your data is in your Supabase project, whose free plan keeps no backups. A backup is one .zip file: backup.json restores everything exactly, and the same data comes as readable CSV files. API keys aren’t included.');
  const card = (...body) => h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'settings-h' }, lastLine, ...body,
    h('div', { class: 'fin-grid fin-mt' }, field('Remind me when there’s no backup', every, driveOn()
      ? 'Fin backs up to Google Drive every day, the first time it opens. The reminder is a banner in case that stops working.'
      : 'A banner appears when it’s been that long since the last backup.')));

  if (!driveConfigured()) {
    return card(about,
      h('p', { class: 'fin-hint' }, 'Fin can also back itself up to your Google Drive every day. It needs a Google OAuth client ID in tools/finance/config.js; the steps are in tools/finance/README.md (Backups).'),
      h('div', { class: 'fin-actions fin-mt' }, download(true)));
  }
  if (!driveOn()) {
    // Signed in with Google: it's that account's Drive, already picked in Google's window.
    const email = googleUser() && currentUser()?.email;
    return card(
      h('p', { class: 'fin-hint' }, email
        ? `Back up to a “Fin backups” folder in the Google Drive of ${email}, the account you signed in with, by itself every day, keeping the latest ${DRIVE_KEEP}. Fin can only see the files it creates there, nothing else in your Drive. Google asks once for the permission; after that, any browser where you sign in with Google uses it without asking.`
        : `Back up to a “Fin backups” folder in your Google Drive, by itself every day, keeping the latest ${DRIVE_KEEP}. Fin can only see the files it creates there, nothing else in your Drive. Connect once in each browser you use, or sign in with Google to connect it everywhere.`),
      about,
      h('div', { class: 'fin-actions fin-mt' },
        button(email ? 'Use Google Drive and back up now' : 'Connect Google Drive and back up now', async () => {
          if (await backupToDrive({ interactive: true })) loadDriveFiles();
        }, 'primary', { 'data-key': 'drive-connect' }),
        download(false)));
  }
  if (!driveFiles) loadDriveFiles();
  const files = driveFiles?.files;
  // Which Google account the backups go to, as Drive says (it can differ from the one signed in).
  const who = driveFiles?.account;
  const signedInAs = currentUser()?.email;
  return card(
    who && h('div', { class: 'fin-me-who fin-me-who--page' },
      avatar({ name: who.displayName ?? '', email: who.emailAddress ?? '', photo: who.photoLink ?? '' }, 40),
      h('div', { class: 'fin-me-names' }, h('strong', {}, who.displayName || who.emailAddress),
        h('span', { class: 'fin-sub' }, who.emailAddress && signedInAs && who.emailAddress.toLowerCase() !== signedInAs.toLowerCase()
          ? `${who.emailAddress}, not the account you signed in with (${signedInAs})` : who.emailAddress))),
    h('p', { class: 'fin-hint' }, `Backups go to “Fin backups” in Google Drive${googleUser() ? ', with your Google sign-in' : ', connected in this browser'}, once a day, keeping the latest ${DRIVE_KEEP}.`),
    driveFiles?.loading ? loader('Looking in Google Drive…')
      : driveFiles?.error ? h('p', { class: 'fin-hint' }, `Couldn’t list the backups in Drive: ${driveFiles.error} `,
        h('button', { type: 'button', class: 'fin-link fin-link-sm', onclick: () => loadDriveFiles(true) }, 'Try again'))
        : files?.length ? h('ul', { class: 'fin-import-list' }, files.map((f) => h('li', {},
          new Date(f.createdTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
          h('span', { class: 'fin-muted' }, ` · ${f.name}${f.size ? ` · ${num(Number(f.size) / 1048576, 1)} MB` : ''}`))))
          : h('p', { class: 'fin-hint' }, 'No backups in Drive yet.'),
    h('div', { class: 'fin-actions fin-mt' },
      button('Back up to Google Drive now', () => backupToDrive({ interactive: true }), 'primary', { 'data-key': 'drive-now' }),
      download(false),
      button('Disconnect', async () => {
        await driveDisconnect();
        writePref('finance:drive', false);
        driveFiles = null;
        render('drive-connect');
        say('Google Drive disconnected in this browser. The backups already there stay.');
      }, 'secondary')));
}

export function exportSection() {
  const stamp = today();
  const csv = () => readableCsvs();
  const labels = { transactions: 'Transactions', accounts: 'Accounts', holdings: 'Holdings', lots: 'Buys and sells', ious: 'IOUs', schedules: 'Scheduled', categories: 'Categories', rules: 'Category rules' };
  return h('section', { class: 'fin-card fin-pad', 'aria-labelledby': 'export-h' },
    h('h3', { id: 'export-h', class: 'fin-label' }, 'Export (CSV)'),
    h('p', { class: 'fin-hint' }, 'Opens in Excel, Numbers or Google Sheets. The transactions file can be imported back here. For everything at once, use Backup and restore.'),
    h('div', { class: 'fin-actions' },
      Object.entries(labels).map(([key, label]) => button(label, () => download(`${key}-${stamp}.csv`, csv()[key])))));
}
