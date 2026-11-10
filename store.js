// What server.js, migrate.js and backup.js share: settings, the database connection and encryption
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const { Pool, types } = require('pg');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // hosting services set real env vars instead

const KEY = Buffer.from(process.env.DATA_KEY || '', 'hex'), SEALED = 'onera-aes256gcm:';
if (KEY.length !== 32) { console.error('DATA_KEY must be set to 64 hex characters: see .env.example'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL must be set: see README.txt, POSTGRESQL'); process.exit(1); }

const seal = t => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv), data = Buffer.concat([c.update(t), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
};
const unseal = t => { // text from before encryption is still plain
  if (t === null || t === undefined || !t.startsWith(SEALED)) return t;
  const b = Buffer.from(t.slice(SEALED.length), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
};
// emails are sealed, so finding one needs a keyed hash: the same address always gives the same hash
const emailHash = e => e ? crypto.createHmac('sha256', KEY).update(e).digest('hex') : null;

types.setTypeParser(20, Number); // bigint columns only hold Date.now() times, which fit a JS number
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: +process.env.PG_POOL || 10 });
pool.on('error', e => console.error('Database connection lost:', e.message));
const all = async (q, v) => (await pool.query(q, v)).rows;
const one = async (q, v) => (await pool.query(q, v)).rows[0];
const tx = async f => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await f(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};
const schema = () => pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const getMeta = async k => (await one('SELECT v FROM meta WHERE k=$1', [k]) || {}).v;
const setMeta = (k, v, c = pool) => c.query('INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, String(v)]);

// DATA_DIR is where uploaded files live; on a hosting service, point it at a persistent disk
const DATA_DIR = process.env.DATA_DIR || __dirname;
const NOTE_DIR = path.join(DATA_DIR, 'note-files'), DOC_DIR = path.join(DATA_DIR, 'doc-files');
fs.mkdirSync(NOTE_DIR, { recursive: true });
fs.mkdirSync(DOC_DIR, { recursive: true });

module.exports = { KEY, seal, unseal, emailHash, pool, all, one, tx, schema, getMeta, setMeta, NOTE_DIR, DOC_DIR };
