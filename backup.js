// Encrypted PostgreSQL backups. The server runs these by itself every day; see README.txt, BACKUPS.
//   node backup.js                   make a backup now
//   node backup.js list              show the backups
//   node backup.js restore <file> --yes   replace the database with a backup (stop the server first)
const fs = require('fs'), crypto = require('crypto'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');
const { KEY, pool, getMeta, setMeta, NOTE_DIR, DOC_DIR } = require('./store');

const DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const COPY_DIR = process.env.BACKUP_COPY_DIR; // a second place, best on another disk or a synced folder
const KEEP_DAYS = +process.env.BACKUP_KEEP_DAYS || 14, KEEP_MONTHS = 12;
const HOUR = process.env.BACKUP_HOUR === undefined ? 2 : +process.env.BACKUP_HOUR;
const MAGIC = Buffer.from('ONERAPG1'), IV = 12, TAG = 16, EXT = '.dump.enc';

// pg_dump is often not on the PATH on Windows
const tool = n => {
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, n);
  const root = 'C:\\Program Files\\PostgreSQL';
  if (os.platform() === 'win32' && fs.existsSync(root)) {
    const v = fs.readdirSync(root).sort((a, b) => b - a)[0];
    if (v) return path.join(root, v, 'bin', n + '.exe');
  }
  return n;
};
// the password goes by environment, so it never shows in a process list
const target = () => {
  const u = new URL(process.env.DATABASE_URL), PGPASSWORD = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.href, env: { ...process.env, PGPASSWORD } };
};
const run = (name, args) => {
  const t = target(), p = spawn(tool(name), [...args, `--dbname=${t.url}`], { env: t.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  p.done = new Promise((ok, no) => {
    p.on('error', e => no(new Error(`Cannot run ${name}: ${e.message}. Install PostgreSQL's client tools or set PG_BIN.`)));
    p.on('close', c => c ? no(new Error(`${name} failed: ${err.trim() || 'exit code ' + c}`)) : ok());
  });
  return p;
};

const dump = async file => {
  const iv = crypto.randomBytes(IV), c = crypto.createCipheriv('aes-256-gcm', KEY, iv), w = fs.createWriteStream(file);
  w.write(Buffer.concat([MAGIC, iv]));
  const p = run('pg_dump', ['--format=custom', '--no-owner']);
  await Promise.all([p.done, pipeline(p.stdout, c, w, { end: false })]);
  await new Promise((ok, no) => w.end(c.getAuthTag(), e => e ? no(e) : ok()));
};
const decrypted = file => {
  const size = fs.statSync(file).size, fd = fs.openSync(file, 'r'), head = Buffer.alloc(MAGIC.length + IV), tag = Buffer.alloc(TAG);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.readSync(fd, tag, 0, TAG, size - TAG);
  fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${file} is not an ONERA backup`);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, head.subarray(MAGIC.length));
  d.setAuthTag(tag);
  return [fs.createReadStream(file, { start: head.length, end: size - TAG - 1 }), d];
};
// proves the file was not damaged and the key opens it; nothing plain is written to disk
const checkKey = async file => {
  try { await pipeline(...decrypted(file), new Writable({ write: (b, e, f) => f() })); }
  catch (e) { throw new Error(`${file} cannot be opened: wrong DATA_KEY or a damaged file (${e.message})`); }
};
// and that PostgreSQL can read what is inside
const checkDump = async file => {
  const p = run('pg_restore', ['--list']);
  p.stdout.resume();
  await Promise.all([p.done, pipeline(...decrypted(file), p.stdin)]);
};

// uploaded files never change once written, so only new ones are copied. Copies of deleted files stay in the backup folder.
const syncFiles = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  const have = new Set(fs.readdirSync(to));
  let n = 0;
  for (const f of fs.readdirSync(from)) if (!have.has(f)) { fs.copyFileSync(path.join(from, f), path.join(to, f)); n++; }
  return n;
};
// the last KEEP_DAYS daily backups, and the newest one of each of the last KEEP_MONTHS months; other kinds are never removed here
const prune = dir => {
  const daily = fs.readdirSync(dir).filter(f => f.endsWith('-daily' + EXT)).sort().reverse();
  const months = new Set();
  daily.forEach((f, i) => {
    const m = f.slice('onera-'.length, 'onera-2026-11'.length), first = !months.has(m);
    months.add(m);
    if (i >= KEEP_DAYS && !(first && months.size <= KEEP_MONTHS)) fs.rmSync(path.join(dir, f));
  });
};

const runBackup = async (kind = 'manual') => {
  const started = Date.now(), d = new Date(), pad = n => String(n).padStart(2, '0');
  const name = `onera-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${kind}${EXT}`;
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name), tmp = file + '.tmp';
  try {
    await dump(tmp);
    await checkDump(tmp);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  for (const dir of [DIR, COPY_DIR].filter(Boolean)) {
    if (dir !== DIR) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(file, path.join(dir, name)); }
    syncFiles(NOTE_DIR, path.join(dir, 'files', 'note-files'));
    syncFiles(DOC_DIR, path.join(dir, 'files', 'doc-files'));
    prune(dir);
  }
  await setMeta('last_backup', started);
  console.log(`Backup done: ${file} (${Math.ceil(fs.statSync(file).size / 1024)} KB, ${Math.round((Date.now() - started) / 1000)}s)`);
  return file;
};
// due once the latest BACKUP_HOUR has passed, so a server that was off at that hour catches up when it starts
const backupDue = async () => {
  const at = new Date();
  at.setHours(HOUR, 0, 0, 0);
  if (at > Date.now()) at.setDate(at.getDate() - 1);
  return +(await getMeta('last_backup') || 0) < +at;
};

const restore = async file => {
  await checkKey(file);
  await checkDump(file);
  try { await runBackup('before-restore'); } catch (e) { console.log(`No copy of the current database was made: ${e.message}`); }
  const p = run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--single-transaction']);
  p.stdout.resume();
  await Promise.all([p.done, pipeline(...decrypted(file), p.stdin)]);
  const base = path.join(path.dirname(path.resolve(file)), 'files');
  if (fs.existsSync(base)) {
    syncFiles(path.join(base, 'note-files'), NOTE_DIR);
    syncFiles(path.join(base, 'doc-files'), DOC_DIR);
  }
  console.log(`Restored ${file}. Start the server again.`);
};

if (require.main === module) (async () => {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'list') {
    const l = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith(EXT)).sort() : [];
    console.log(l.length ? l.map(f => `${path.join(DIR, f)}  ${Math.ceil(fs.statSync(path.join(DIR, f)).size / 1024)} KB`).join('\n') : 'No backups yet.');
  } else if (cmd === 'restore') {
    if (!file || !process.argv.includes('--yes')) throw new Error('This replaces everything in the database. Stop the server, then run: node backup.js restore <file> --yes');
    await restore(file);
  } else if (cmd) throw new Error('Use: node backup.js [list | restore <file> --yes]');
  else await runBackup();
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { runBackup, backupDue };
