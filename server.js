// School Platform backend — run: npm install, then node server.js  (Node 20.12+, PostgreSQL 14+)
const http = require('http'), https = require('https'), fs = require('fs'), crypto = require('crypto'), path = require('path'), zlib = require('zlib'), cluster = require('cluster'), os = require('os');
const nodemailer = require('nodemailer');
// everything lives in PostgreSQL. email, photo and profile are sealed before they get there, ID photos are sealed files in doc-files
const { seal, unseal, emailHash, pool, all, one, tx, schema, getMeta, setMeta, NOTE_DIR, DOC_DIR } = require('./store');
const migrate = require('./migrate');
const { runBackup, backupDue } = require('./backup');

const id = () => crypto.randomBytes(5).toString('hex');
const hash = (p, s) => new Promise((ok, no) => crypto.scrypt(String(p), s, 32, (e, k) => e ? no(e) : ok(k.toString('hex')))); // not scryptSync: one login must not stop every other request
const mk = async (o, p) => { const salt = id(); return { id: id(), ...o, salt, h: await hash(p, salt) }; };
const E = (c, m) => { throw { c, m }; };
const SUB_DAYS = 30, SUB_PRICE = 199, SESSION_DAYS = 30;
const PORT = process.env.PORT || 3000;
const OTP_MS = 10 * 6e4, OTP_TRIES = 5, MAIL_GAP_MS = 6e4, PHOTO_MAX = 300 * 1024;
const NOTE_FILES = 20, NOTE_FILES_MAX = 10 * 1024 * 1024;
const CHAT_MAX = 1000, CHAT_PAGE = 200;

const smtpPort = +process.env.SMTP_PORT || 465;
const mailer = process.env.SMTP_USER && nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com', port: smtpPort, secure: smtpPort === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
const sendMail = (to, subject, text) => {
  if (!mailer) return console.log(`[email not configured] To ${to}: ${subject}\n${text}`);
  mailer.sendMail({ from: `ONERA <${process.env.SMTP_USER}>`, to, subject, text }).catch(e => console.error('Email failed:', e.message));
};
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
// one email per minute per address + type, so the public forms cannot be used to flood an inbox
const tooSoon = async k => !(await one('INSERT INTO mail_gaps (k, at) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET at=$2 WHERE mail_gaps.at <= $3 RETURNING k', [sha(k), Date.now(), Date.now() - MAIL_GAP_MS]));

// email codes: only the hash is kept, and a few wrong guesses cancel the code
const newOtp = async k => {
  const c = String(crypto.randomInt(1e6)).padStart(6, '0');
  await pool.query('INSERT INTO otps (k, h, x, n) VALUES ($1, $2, $3, 0) ON CONFLICT (k) DO UPDATE SET h=$2, x=$3, n=0', [sha(k), sha(k + c), Date.now() + OTP_MS]);
  return c;
};
const useOtp = async (k, c) => {
  const key = sha(k), o = await one('UPDATE otps SET n=n+1 WHERE k=$1 RETURNING h, x, n', [key]), live = o && o.x > Date.now() && o.n <= OTP_TRIES;
  if (live && o.h === sha(k + String(c || '').trim())) return pool.query('DELETE FROM otps WHERE k=$1', [key]);
  if (o && (!live || o.n === OTP_TRIES)) await pool.query('DELETE FROM otps WHERE k=$1', [key]);
  E(400, 'Wrong or expired code');
};
const cleanEmail = e => {
  const v = String(e || '').trim().toLowerCase();
  if (v && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(v)) E(400, 'Enter a valid email address');
  return v || undefined;
};

// PostgreSQL gives null for an empty column; the page expects those keys to be missing. cls is text there, but colleges use numbers
const toCls = v => typeof v === 'string' && /^\d+$/.test(v) ? +v : v;
const rec = x => {
  const o = Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null));
  if ('cls' in o) o.cls = toCls(o.cls);
  if (o.classes) o.classes = o.classes.map(toCls);
  return o;
};
const addUser = (x, c = pool) => c.query('INSERT INTO users (id, role, name, username, school_id, cls, classes, salt, h, email, email_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
  x.id, x.role, x.name, x.username, x.schoolId || null, x.cls === undefined || x.cls === null ? null : String(x.cls), x.classes ? x.classes.map(String) : null, x.salt, x.h, x.email ? seal(x.email) : null, emailHash(x.email)
]);
const USER = `id, role, name, username, school_id "schoolId", cls, classes, sub`; // what login and every page need; never photo or profile
const userBy = async (col, v) => rec(await one(`SELECT ${USER}, salt, h FROM users WHERE ${col}=$1`, [v]) || {});
const pub = x => ({ id: x.id, role: x.role, name: x.name, username: x.username, schoolId: x.schoolId, cls: x.cls, classes: x.classes, sub: x.sub });

// a school's type never changes, so it is only asked for once
const types = new Map();
const schoolOf = async sId => {
  if (!sId) return {};
  if (!types.has(sId)) { const s = await one('SELECT name, type FROM schools WHERE id=$1', [sId]); if (!s) return {}; types.set(sId, s); }
  return types.get(sId);
};
const self = async x => { // email and photo go only to their owner
  const r = await one('SELECT email, photo FROM users WHERE id=$1', [x.id]), s = await schoolOf(x.schoolId);
  return { ...pub(x), email: r.email ? unseal(r.email) : undefined, photo: r.photo ? unseal(r.photo) : undefined, college: s.type === 'College', school: s.name };
};
// schools run classes 1-10 with sections A-C (stored like '5-A'), colleges semesters 1-8 (stored like 3); both are stored in cls
const SECTIONS = ['A', 'B', 'C'];
const classList = college => college ? [...Array(8)].map((_, i) => i + 1) : [...Array(10)].flatMap((_, i) => SECTIONS.map(v => `${i + 1}-${v}`));
const cleanCls = (c, college) => { const v = college ? +c : String(c); if (!classList(college).includes(v)) E(400, college ? 'Semester must be 1-8' : 'Choose a class from 1-A to 10-C'); return v; };
// the classes a teacher teaches: stored sorted, without repeats
const cleanClasses = (list, college) => { const on = [].concat(list || []).map(v => cleanCls(v, college)); return classList(college).filter(v => on.includes(v)); };

// every April school students move up a class and class 10 passes out; colleges keep their semesters. meta 'promoted' is the last April done
const PASSED = 'Passed out';
const aprilYear = () => { const d = new Date(); return d.getFullYear() - (d.getMonth() < 3 ? 1 : 0); };
const promote = async () => {
  const y = aprilYear(), done = await getMeta('promoted');
  if (!done) return setMeta('promoted', y); // a first run only records the year, so nobody moves early
  if (+done >= y) return;
  await runBackup(`before-promotion-${y}`); // no copy, no promotion: the next hourly check tries again
  await tx(async c => {
    await c.query(`UPDATE users SET cls = CASE WHEN split_part(cls, '-', 1)::int >= 10 THEN '${PASSED}' ELSE (split_part(cls, '-', 1)::int + 1) || '-' || split_part(cls, '-', 2) END
      WHERE role='student' AND cls ~ '^\\d+-[A-C]$' AND school_id IN (SELECT id FROM schools WHERE type IS DISTINCT FROM 'College')`);
    await setMeta('promoted', y, c);
  });
  console.log(`Classes promoted for April ${y}`);
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
// profile details: every field is optional, the email in the form is the same recovery email as u.email
const GENDERS = ['Male', 'Female', 'Other'], BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const cleanPhone = v => { const t = String(v || '').trim(); if (t && !/^\+?[0-9][0-9 -]{6,18}$/.test(t)) E(400, 'Enter a valid phone number'); return t; };
const cleanProfile = b => {
  const p = { phone: cleanPhone(b.phone), altPhone: cleanPhone(b.altPhone) };
  ['address', 'mother', 'father', 'birthPlace', 'citizenship', 'religion'].forEach(k => { p[k] = String(b[k] || '').trim().slice(0, 300); });
  p.dob = String(b.dob || '');
  if (p.dob && (!/^\d{4}-\d{2}-\d{2}$/.test(p.dob) || isNaN(new Date(p.dob)) || new Date(p.dob) > Date.now())) E(400, 'Choose a valid date of birth');
  p.gender = GENDERS.includes(b.gender) ? b.gender : '';
  p.blood = BLOOD.includes(b.blood) ? b.blood : '';
  return p;
};
// a new password also logs out every session, so a stolen one stops working
const setPassword = async (x, p) => {
  const salt = id();
  await pool.query('UPDATE users SET salt=$1, h=$2 WHERE id=$3', [salt, await hash(p, salt), x.id]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [x.id]);
};
// one date, shared by the calendar and the class register
const checkDay = (month, d) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) E(400, 'Choose a valid month');
  const [y, mo] = month.split('-').map(Number), at = new Date(y, mo - 1, d);
  if (!Number.isInteger(d) || d < 1 || d > new Date(y, mo, 0).getDate()) E(400, 'Choose a valid date');
  if (at.getDay() === 0) E(400, 'Sunday is a holiday');
  if (at > Date.now() + 864e5) E(400, 'Cannot mark a future date'); // 1 day margin: server may be in another timezone
};
const DAY_SET = `ON CONFLICT (student_id, month) DO UPDATE SET days = ARRAY(SELECT DISTINCT v FROM unnest(attendance.days || EXCLUDED.days) v WHERE v <> $1 OR $1 = ANY(EXCLUDED.days) ORDER BY v)`;
const rmDocFiles = rows => Promise.all(rows.map(x => fs.promises.rm(path.join(DOC_DIR, x.id), { force: true })));

async function handle(m, p, q, b, u) {
  const k = m + ' ' + p, sid = u && u.schoolId, college = (await schoolOf(sid)).type === 'College';
  const need = (...r) => { if (!u) E(401, 'Please login first'); if (r.length && !r.includes(u.role)) E(403, 'Not allowed'); };
  // teachers only reach their own classes; everyone else passes
  const taught = c => u.role !== 'teacher' || (u.classes || []).includes(c);
  const mine = async sId => {
    const s = rec(await one(`SELECT cls FROM users WHERE id=$1 AND school_id=$2 AND role='student'`, [sId, sid]) || {});
    if (!Object.keys(s).length) E(400, 'Student not found in your school');
    if (!taught(s.cls)) E(403, 'This student is not in your classes');
    return s;
  };
  // the same rule as taught(), for a query: $n is u.classes as text, or null for everyone who is not a teacher
  const myClasses = u && u.role === 'teacher' ? (u.classes || []).map(String) : null;

  // ---- public ----
  if (k === 'GET schools') { // who added an institution and when goes only to the main admin
    const s = (q.get('q') || '').toLowerCase(), admin = u && u.role === 'admin';
    const rows = await all(`SELECT id, name, type, city, by_name "by", at FROM schools WHERE position($1 in lower(name || ' ' || coalesce(city, '') || ' ' || coalesce(type, ''))) > 0 ORDER BY seq`, [s]);
    return rows.map(x => admin ? rec(x) : rec({ id: x.id, name: x.name, type: x.type, city: x.city }));
  }
  if (k === 'POST login') {
    const x = await userBy('username', String(b.username));
    // school logins only work on their own school's page; the main admin has no school.
    // the /school-login page sends portal 'school': any school or college account, never the main admin
    const place = b.portal === 'school' ? !!x.schoolId : (x.schoolId || '') === (b.schoolId || '');
    if (!x.id || await hash(b.password || '', x.salt) !== x.h || !place) E(401, 'Wrong username or password');
    const t = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (token, user_id, expires) VALUES ($1, $2, $3)', [sha(t), x.id, Date.now() + SESSION_DAYS * 864e5]);
    return { token: t, user: await self(x) };
  }
  if (k === 'GET me') { need(); return self(u); }
  if (k === 'POST password') {
    need();
    if (await hash(b.old || '', u.salt) !== u.h) E(400, 'Current password is wrong');
    if (String(b.password || '').length < 6) E(400, 'Password must be at least 6 characters');
    await setPassword(u, b.password); return { ok: 1 };
  }
  if (k === 'POST photo') { // the page shrinks the picture first, so anything big here is not from it
    need();
    if (b.photoData) {
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.photoData)) E(400, 'Photo must be a JPEG image');
      if (b.photoData.length > PHOTO_MAX) E(400, 'Photo is too large');
    }
    await pool.query('UPDATE users SET photo=$1 WHERE id=$2', [b.photoData ? seal(b.photoData) : null, u.id]);
    return self(u);
  }

  // ---- profile: your own, or a school admin's own teachers and students. Not in self(), because the login is kept in localStorage ----
  if (k === 'GET profile' || k === 'POST profile') {
    need();
    const other = q.get('id') || b.id;
    const x = other ? (u.role === 'school' ? rec(await one(`SELECT ${USER} FROM users WHERE id=$1 AND school_id=$2 AND role IN ('teacher','student')`, [other, sid]) || {}) : {}) : u;
    if (!x.id) E(404, 'Person not found');
    if (m === 'POST') {
      const p = cleanProfile(b), e = cleanEmail(b.email);
      await pool.query('UPDATE users SET email=$1, email_hash=$2, profile=$3 WHERE id=$4', [e ? seal(e) : null, emailHash(e), seal(JSON.stringify(p)), x.id]);
    }
    const r = await one('SELECT profile FROM users WHERE id=$1', [x.id]);
    return { ...await self(x), profile: r.profile ? JSON.parse(unseal(r.profile)) : {} };
  }

  // ---- forgot username / password: same reply either way, so nobody can test which accounts exist ----
  if (k === 'POST forgot-username') {
    const e = cleanEmail(b.email), list = e ? await all('SELECT 1 FROM users WHERE email_hash=$1 LIMIT 1', [emailHash(e)]) : [];
    if (list.length && !await tooSoon('u:' + e)) sendMail(e, 'Your ONERA verification code', `Your code to see your username is ${await newOtp('u:' + e)}\n\nIt expires in 10 minutes. If you did not ask for this, ignore this email.`);
    return { ok: 1 };
  }
  if (k === 'POST verify-username') {
    const e = cleanEmail(b.email);
    await useOtp('u:' + e, b.code);
    return { usernames: (await all('SELECT username FROM users WHERE email_hash=$1 ORDER BY seq', [emailHash(e)])).map(v => v.username) };
  }
  if (k === 'POST forgot-password') {
    const x = await userBy('username', String(b.username));
    const mail = async where => { const r = await one(`SELECT email FROM users WHERE ${where} ORDER BY seq LIMIT 1`, [where.includes('school_id') ? x.schoolId : x.id]); return r && r.email ? unseal(r.email) : undefined; };
    if (!x.id) return { ok: 1 };
    // many students have no inbox of their own, so their code goes to their school admin, who passes it on
    const adminEmail = x.role === 'student' ? await mail(`role='school' AND school_id=$1`) : undefined;
    const to = adminEmail || await mail('id=$1');
    if (to && !await tooSoon('p:' + x.id)) {
      const c = await newOtp('p:' + x.id);
      sendMail(to, adminEmail ? `Password reset code for student ${x.name}` : 'Your ONERA verification code', adminEmail
        ? `${x.name} (username "${x.username}", class ${x.cls}) asked to reset their password. The code is ${c}\n\nIt expires in 10 minutes. Give it to the student only after checking it is really them. If nobody asked for this, ignore this email.`
        : `Your code to reset the password for "${x.username}" is ${c}\n\nIt expires in 10 minutes. If you did not ask for this, ignore this email.`);
    }
    return { ok: 1 };
  }
  if (k === 'POST reset-password') {
    const x = await userBy('username', String(b.username));
    if (String(b.password || '').length < 6) E(400, 'Password must be at least 6 characters');
    await useOtp('p:' + x.id, b.code);
    await setPassword(x, b.password); return { ok: 1 };
  }

  // ---- main admin: add schools / colleges ----
  if (k === 'POST schools') {
    need('admin');
    if (!b.name || !b.username || !b.password) E(400, 'Fill all fields');
    if (await one('SELECT 1 FROM users WHERE username=$1', [b.username])) E(400, 'Username already taken');
    const email = cleanEmail(b.email);
    const s = { id: id(), name: b.name, type: b.type, city: b.city, by: u.name, at: Date.now() };
    const a = await mk({ role: 'school', name: b.name + ' (Admin)', username: b.username, email, schoolId: s.id }, b.password);
    await tx(async c => {
      await c.query('INSERT INTO schools (id, name, type, city, by_name, at) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, s.name, s.type, s.city, s.by, s.at]);
      await addUser(a, c);
    });
    return s;
  }

  if (k === 'GET school-stats') { // totals only: the main admin never gets student names or document photos
    need('admin');
    return all(`WITH people AS (
        SELECT school_id, count(*) FILTER (WHERE role='student')::int students, count(*) FILTER (WHERE role='teacher')::int teachers
        FROM users WHERE cls IS DISTINCT FROM '${PASSED}' GROUP BY school_id
      ), dc AS (SELECT school_id, count(*)::int docs FROM docs GROUP BY school_id),
      fp AS (SELECT f.id, f.school_id, f.amount, count(p.student_id)::int paid FROM fees f LEFT JOIN payments p ON p.fee_id=f.id GROUP BY f.id)
      SELECT s.id, coalesce(pe.students, 0) students, coalesce(pe.teachers, 0) teachers, coalesce(dc.docs, 0) docs,
        coalesce((SELECT sum(amount * paid) FROM fp WHERE fp.school_id=s.id), 0) collected,
        coalesce((SELECT sum(amount * greatest(coalesce(pe.students, 0) - paid, 0)) FROM fp WHERE fp.school_id=s.id), 0) pending
      FROM schools s LEFT JOIN people pe ON pe.school_id=s.id LEFT JOIN dc ON dc.school_id=s.id ORDER BY s.seq`);
  }

  // ---- school admin: teachers & students ----
  if (k === 'POST users') {
    need('school');
    if (!['teacher', 'student'].includes(b.role)) E(400, 'Invalid role');
    if (await one('SELECT 1 FROM users WHERE username=$1', [b.username])) E(400, 'Username already taken');
    const c = b.role === 'student' ? cleanCls(b.cls, college) : null;
    const classes = b.role === 'teacher' ? cleanClasses(b.classes, college) : undefined;
    await addUser(await mk({ role: b.role, name: b.name, username: b.username, email: cleanEmail(b.email), schoolId: sid, cls: c, classes }, b.password));
    return { ok: 1 };
  }
  if (k === 'POST teacher-classes') {
    need('school');
    const r = await pool.query(`UPDATE users SET classes=$1 WHERE id=$2 AND school_id=$3 AND role='teacher'`, [cleanClasses(b.classes, college).map(String), b.id, sid]);
    if (!r.rowCount) E(404, 'Teacher not found');
    return { ok: 1 };
  }
  if (k === 'POST remove-user') { // a student's records go with them; a teacher's notes and notices stay for the school
    need('school');
    const gone = await all('SELECT id FROM docs WHERE student_id=$1 AND school_id=$2', [b.id, sid]);
    const r = await pool.query(`DELETE FROM users WHERE id=$1 AND school_id=$2 AND role IN ('teacher','student')`, [b.id, sid]);
    if (!r.rowCount) E(404, 'Person not found');
    await rmDocFiles(gone);
    return { ok: 1 };
  }
  if (k === 'GET users') { // a teacher gets only the students of their classes
    need('school', 'teacher');
    return (await all(`SELECT ${USER} FROM users WHERE school_id=$1 AND ((role='student' AND ($2::text[] IS NULL OR cls=ANY($2))) OR (role='teacher' AND $3)) ORDER BY seq`, [sid, myClasses, u.role === 'school'])).map(rec);
  }

  // ---- notice board ----
  if (k === 'POST notices') {
    need('school', 'teacher');
    if (!b.title || !b.body) E(400, 'Fill all fields');
    await pool.query('INSERT INTO notices (id, school_id, title, body, by_name, at) VALUES ($1,$2,$3,$4,$5,$6)', [id(), sid, b.title, b.body, u.name, Date.now()]); return { ok: 1 };
  }
  if (k === 'GET notices') { need('school', 'teacher', 'student'); return (await all(`SELECT id, school_id "schoolId", title, body, by_name "by", at FROM notices WHERE school_id=$1 ORDER BY seq DESC`, [sid])).map(rec); }

  // ---- timetable: the school admin sets it, teachers and students only see their classes ----
  if (k === 'POST timetable') {
    need('school');
    const c = cleanCls(b.cls, college), subject = String(b.subject || '').trim().slice(0, 100);
    if (!DAYS.includes(b.day)) E(400, 'Choose a day');
    if (!subject) E(400, 'Enter a subject');
    if (!CLOCK.test(b.start) || !CLOCK.test(b.end) || b.start >= b.end) E(400, 'End time must be after start time');
    const t = b.teacherId ? rec(await one(`SELECT id, name, classes FROM users WHERE id=$1 AND school_id=$2 AND role='teacher'`, [b.teacherId, sid]) || {}) : null;
    if (b.teacherId && !(t.id && (t.classes || []).includes(c))) E(400, 'That teacher does not teach this class');
    await tx(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sid]); // two admins saving at once must not both get the same slot
      const busy = async (col, v) => (await db.query(`SELECT 1 FROM timetable WHERE school_id=$1 AND day=$2 AND start_t<$3 AND end_t>$4 AND ${col}=$5 LIMIT 1`, [sid, b.day, b.end, b.start, v])).rowCount;
      if (await busy('cls', String(c))) E(400, 'This class already has a period at that time');
      if (t && await busy('teacher_id', t.id)) E(400, `${t.name} already has a period at that time`);
      await db.query('INSERT INTO timetable (id, school_id, cls, day, start_t, end_t, subject, teacher_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(), sid, String(c), b.day, b.start, b.end, subject, t ? t.id : null]);
    });
    return { ok: 1 };
  }
  if (k === 'GET timetable') {
    need('school', 'teacher', 'student');
    return (await all(`SELECT t.id, t.school_id "schoolId", t.cls, t.day, t.start_t "start", t.end_t "end", t.subject, t.teacher_id "teacherId", p.name teacher
      FROM timetable t LEFT JOIN users p ON p.id=t.teacher_id WHERE t.school_id=$1 AND ($2::text[] IS NULL OR t.cls=ANY($2)) ORDER BY t.seq`, [sid, u.role === 'student' ? [String(u.cls)] : myClasses])).map(rec);
  }

  // ---- homework: free for students, unlike notes ----
  if (k === 'POST homework') {
    need('teacher'); const c = cleanCls(b.cls, college);
    if (!taught(c)) E(403, 'You do not teach this class');
    if (!b.subject || !b.details) E(400, 'Fill all fields');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due) || isNaN(new Date(b.due))) E(400, 'Choose a valid due date');
    await pool.query('INSERT INTO homework (id, school_id, cls, subject, details, due, by_name, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(), sid, String(c), b.subject, b.details, b.due, u.name, Date.now()]); return { ok: 1 };
  }
  if (k === 'GET homework') {
    need('school', 'teacher', 'student');
    return (await all(`SELECT id, school_id "schoolId", cls, subject, details, due, by_name "by", at FROM homework WHERE school_id=$1 AND ($2::text[] IS NULL OR cls=ANY($2)) ORDER BY seq DESC`, [sid, u.role === 'student' ? [String(u.cls)] : myClasses])).map(rec);
  }

  // ---- class chat: students talk in their own class, teachers in the classes they teach, the school admin in any ----
  const room = c => {
    if (u.role === 'student') {
      if (u.cls === PASSED) E(403, 'Class chat is only for current students');
      c = u.cls;
    }
    const v = cleanCls(c, college);
    if (!taught(v)) E(403, 'You do not teach this class');
    return String(v);
  };
  if (k === 'GET chat') { // the newest CHAT_PAGE on opening, then only what changed after the last seq the page has
    need('school', 'teacher', 'student');
    const c = room(q.get('cls')), after = +q.get('after') || 0;
    return (await all(`SELECT * FROM (SELECT seq, id, user_id "userId", by_name "by", role, body, gone, at FROM chat
      WHERE school_id=$1 AND cls=$2 AND seq>$3 AND ($3>0 OR NOT gone) ORDER BY seq DESC LIMIT ${CHAT_PAGE}) r ORDER BY seq`, [sid, c, after])).map(rec);
  }
  if (k === 'POST chat') {
    need('school', 'teacher', 'student');
    const c = room(b.cls), body = String(b.body || '').trim();
    if (!body) E(400, 'Write a message');
    if (body.length > CHAT_MAX) E(400, `Keep a message within ${CHAT_MAX} characters`);
    await pool.query('INSERT INTO chat (id, school_id, cls, user_id, by_name, role, body, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(), sid, c, u.id, u.name, u.role, body, Date.now()]);
    return { ok: 1 };
  }
  if (k === 'POST chat-remove') { // your own message; teachers and the school admin can remove any in their classes
    need('school', 'teacher', 'student');
    const x = rec(await one('SELECT id, cls, user_id FROM chat WHERE id=$1 AND school_id=$2 AND NOT gone', [b.id, sid]) || {});
    if (!x.id) E(404, 'Message not found');
    if (x.user_id !== u.id && (u.role === 'student' || !taught(x.cls))) E(403, 'Not allowed');
    await pool.query(`UPDATE chat SET body='', gone=true, seq=nextval(pg_get_serial_sequence('chat', 'seq')) WHERE id=$1`, [x.id]);
    return { ok: 1 };
  }

  // ---- documents are managed only by the ONERA admin ----
  if (k === 'POST remove' && b.kind === 'docs') {
    need('admin');
    const x = await one('SELECT id FROM docs WHERE id=$1', [b.id]);
    if (!x) E(404, 'Not found');
    await pool.query('DELETE FROM docs WHERE id=$1', [x.id]);
    await rmDocFiles([x]);
    return { ok: 1 };
  }
  // ---- delete a record: teachers cannot touch fees or the timetable ----
  if (k === 'POST remove') {
    need('school', 'teacher');
    const table = { notices: 'notices', notes: 'notes', results: 'results', fees: 'fees', homework: 'homework', periods: 'timetable' }[b.kind];
    if (!table || (u.role === 'teacher' && ['fees', 'periods'].includes(b.kind))) E(403, 'Not allowed');
    const x = rec(await one(`SELECT * FROM ${table} WHERE id=$1 AND school_id=$2`, [b.id, sid]) || {});
    if (!x.id) E(404, 'Not found');
    if (((b.kind === 'notes' || b.kind === 'homework') && !taught(x.cls))) E(403, 'Not allowed');
    if (b.kind === 'results' && u.role === 'teacher') { const s = rec(await one('SELECT cls FROM users WHERE id=$1', [x.student_id]) || {}); if (!taught(s.cls)) E(403, 'Not allowed'); }
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [x.id]); // a fee's payments go with it
    if (b.kind === 'notes') await Promise.all((x.files || []).map(v => fs.promises.rm(path.join(NOTE_DIR, v.id), { force: true })));
    if (b.kind === 'docs') await rmDocFiles([x]);
    return { ok: 1 };
  }

  // ---- notes (paid) ----
  if (k === 'POST notes') {
    need('teacher'); const c = cleanCls(b.cls, college);
    if (!taught(c)) E(403, 'You do not teach this class');
    const list = Array.isArray(b.files) ? b.files : [];
    if (!b.title || !(b.content || list.length)) E(400, 'Add a title, then write notes or attach a file');
    if (list.length > NOTE_FILES) E(400, `Attach up to ${NOTE_FILES} files`);
    const files = list.map(f => {
      const match = /^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(f.data);
      if (!match) E(400, 'Files must be PDF, JPG, PNG or WebP');
      return { id: id(), name: String(f.name || 'file').slice(0, 120), type: match[1], buf: Buffer.from(match[2], 'base64') };
    });
    if (files.reduce((s, v) => s + v.buf.length, 0) > NOTE_FILES_MAX) E(400, 'Files must be 10 MB or smaller in total');
    await Promise.all(files.map(async v => { await fs.promises.writeFile(path.join(NOTE_DIR, v.id), v.buf); delete v.buf; }));
    await pool.query('INSERT INTO notes (id, school_id, cls, title, content, files, by_name, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(), sid, String(c), b.title, b.content, JSON.stringify(files), u.name, Date.now()]); return { ok: 1 };
  }
  const NOTE = `id, school_id "schoolId", cls, title, content, files, by_name "by", at`;
  if (k === 'GET notes') {
    need('teacher', 'student', 'school');
    if (u.role === 'student') {
      const ok = (u.sub || 0) > Date.now();
      return { subscribed: ok, price: SUB_PRICE, items: (await all(`SELECT ${NOTE} FROM notes WHERE school_id=$1 AND cls=$2 ORDER BY seq`, [sid, String(u.cls)])).map(rec).map(x => ({ ...x, content: ok ? x.content : null, files: ok ? x.files : [] })) };
    }
    return { items: (await all(`SELECT ${NOTE} FROM notes WHERE school_id=$1 AND ($2::text[] IS NULL OR cls=ANY($2)) ORDER BY seq`, [sid, myClasses])).map(rec) };
  }
  if (k === 'GET note-file') { // the paywall has to hold here too: a file id alone must not open a paid note
    need('teacher', 'student', 'school');
    const fid = String(q.get('id')), r = await one(`SELECT cls, files FROM notes WHERE school_id=$1 AND files @> $2::jsonb`, [sid, JSON.stringify([{ id: fid }])]);
    if (!r) E(404, 'File not found');
    const n = rec(r);
    if (!taught(n.cls)) E(403, 'You do not teach this class');
    if (u.role === 'student' && (n.cls !== u.cls || !((u.sub || 0) > Date.now()))) E(403, 'Subscribe to open this file');
    const f = n.files.find(v => v.id === fid);
    return { type: f.type, data: `data:${f.type};base64,${(await fs.promises.readFile(path.join(NOTE_DIR, f.id))).toString('base64')}` };
  }
  if (k === 'POST subscribe') { // demo: plug a payment gateway here
    need('student');
    const r = await one('UPDATE users SET sub = greatest(coalesce(sub, 0), $1) + $2 WHERE id=$3 RETURNING sub', [Date.now(), SUB_DAYS * 864e5, u.id]);
    return self({ ...u, sub: r.sub });
  }

  // ---- results ----
  if (k === 'POST results') {
    need('school', 'teacher'); await mine(b.studentId);
    if (!b.exam || !b.subject) E(400, 'Fill all fields');
    if (!(+b.total > 0 && +b.marks >= 0 && +b.marks <= +b.total)) E(400, 'Marks must be between 0 and the total');
    await pool.query('INSERT INTO results (id, school_id, student_id, exam, subject, marks, total) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id(), sid, b.studentId, b.exam, b.subject, +b.marks, +b.total]); return { ok: 1 };
  }
  if (k === 'GET results') {
    need('school', 'teacher', 'student');
    const RESULT = `r.id, r.school_id "schoolId", r.student_id "studentId", r.exam, r.subject, r.marks, r.total, s.name student`;
    return u.role === 'student'
      ? (await all(`SELECT ${RESULT} FROM results r JOIN users s ON s.id=r.student_id WHERE r.student_id=$1 ORDER BY r.seq`, [u.id])).map(rec)
      : (await all(`SELECT ${RESULT} FROM results r JOIN users s ON s.id=r.student_id WHERE r.school_id=$1 AND ($2::text[] IS NULL OR s.cls=ANY($2)) ORDER BY r.seq`, [sid, myClasses])).map(rec);
  }

  // ---- monthly attendance ----
  if (k === 'POST attendance') {
    need('school', 'teacher'); await mine(b.studentId);
    checkDay(b.month, b.day);
    await pool.query(`INSERT INTO attendance (id, school_id, student_id, month, days) VALUES ($2, $3, $4, $5, CASE WHEN $6 THEN ARRAY[$1::int] ELSE '{}'::int[] END) ${DAY_SET}`, [b.day, id(), sid, b.studentId, b.month, !!b.present]);
    return { ok: 1 };
  }
  if (k === 'POST attendance-day') { // the class register: one date, every student in the class
    need('school', 'teacher');
    const [, month, day] = /^(\d{4}-\d{2})-(\d{2})$/.exec(b.date) || E(400, 'Choose a valid date');
    const c = cleanCls(b.cls, college);
    if (!taught(c)) E(403, 'You do not teach this class');
    checkDay(month, +day);
    await pool.query(`INSERT INTO attendance (id, school_id, student_id, month, days)
      SELECT substr(md5(random()::text || s.id), 1, 10), s.school_id, s.id, $2, CASE WHEN s.id = ANY($3) THEN ARRAY[$1::int] ELSE '{}'::int[] END
      FROM users s WHERE s.school_id=$4 AND s.role='student' AND s.cls=$5 ${DAY_SET}`, [+day, month, [].concat(b.present || []).map(String), sid, String(c)]);
    return { ok: 1 };
  }
  if (k === 'GET attendance') { // staff ask for one class and the months on screen: a whole school's years would be far too much
    need('school', 'teacher', 'student');
    const ATT = `a.id, a.school_id "schoolId", a.student_id "studentId", a.month, a.days, s.name student`;
    if (u.role === 'student') return (await all(`SELECT ${ATT} FROM attendance a JOIN users s ON s.id=a.student_id WHERE a.student_id=$1 ORDER BY a.seq`, [u.id])).map(rec);
    const c = q.get('cls') === null ? null : String(q.get('cls'));
    if (c !== null && !taught(toCls(c))) E(403, 'You do not teach this class');
    const months = q.getAll('month').filter(v => /^\d{4}-\d{2}$/.test(v));
    return (await all(`SELECT ${ATT} FROM attendance a JOIN users s ON s.id=a.student_id
      WHERE a.school_id=$1 AND a.month=ANY($2) AND ($3::text IS NULL OR s.cls=$3) AND ($4::text[] IS NULL OR s.cls=ANY($4)) ORDER BY a.seq`,
      [sid, months.length ? months : [new Date().toLocaleDateString('en-CA').slice(0, 7)], c, myClasses])).map(rec);
  }

  // ---- student documents (govt IDs etc.): the list has no photos, each one is fetched when it is opened ----
  // every student of every school, for the ONERA admin's upload form
  if (k === 'GET doc-students') {
    need('admin');
    return all(`SELECT u.id, u.name, u.cls, s.id "schoolId", s.name school, s.type FROM users u JOIN schools s ON s.id=u.school_id WHERE u.role='student' ORDER BY s.seq, u.seq`);
  }
  if (k === 'POST docs') {
    need('admin');
    const st = await one(`SELECT school_id FROM users WHERE id=$1 AND role='student'`, [b.studentId]);
    if (!st) E(400, 'Student not found');
    if (!b.type || !b.photoData) E(400, 'Choose a document type and upload a photo');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.photoData);
    if (!match) E(400, 'Photo must be JPG, PNG or WebP');
    if (Buffer.from(match[2], 'base64').length > 3 * 1024 * 1024) E(400, 'Photo must be 3 MB or smaller');
    const did = id();
    await fs.promises.writeFile(path.join(DOC_DIR, did), seal(b.photoData));
    await pool.query('INSERT INTO docs (id, school_id, student_id, type) VALUES ($1,$2,$3,$4)', [did, st.school_id, b.studentId, b.type]);
    return { ok: 1 };
  }
  if (k === 'GET docs') {
    need('school', 'student', 'admin');
    const DOC = `d.id, d.school_id "schoolId", d.student_id "studentId", d.type, s.name student`;
    // the ONERA admin sees every school's documents (Previous Data), read only
    if (u.role === 'admin') return all(`SELECT ${DOC}, sc.name school FROM docs d JOIN users s ON s.id=d.student_id JOIN schools sc ON sc.id=d.school_id ORDER BY d.seq`);
    return u.role === 'student'
      ? all(`SELECT ${DOC} FROM docs d JOIN users s ON s.id=d.student_id WHERE d.student_id=$1 ORDER BY d.seq`, [u.id])
      : all(`SELECT ${DOC} FROM docs d JOIN users s ON s.id=d.student_id WHERE d.school_id=$1 ORDER BY d.seq`, [sid]);
  }
  if (k === 'GET doc-photo') {
    need('school', 'student', 'admin');
    const d = u.role === 'admin'
      ? await one('SELECT id FROM docs WHERE id=$1', [q.get('id')])
      : await one('SELECT id FROM docs WHERE id=$1 AND school_id=$2 AND ($3::text IS NULL OR student_id=$3)', [q.get('id'), sid, u.role === 'student' ? u.id : null]);
    if (!d) E(404, 'Document not found');
    return { photoData: unseal(await fs.promises.readFile(path.join(DOC_DIR, d.id), 'utf8')) };
  }

  // ---- fees / payments ----
  if (k === 'POST fees') { need('school'); if (!b.title || !(+b.amount > 0) || !b.dueDate) E(400, 'Enter a title, an amount above 0 and a last date'); await pool.query('INSERT INTO fees (id, school_id, title, amount, due_date) VALUES ($1,$2,$3,$4,$5)', [id(), sid, b.title, +b.amount, b.dueDate]); return { ok: 1 }; }
  if (k === 'GET fees') {
    need('school', 'student');
    if (u.role === 'student') return all(`SELECT f.id, f.school_id "schoolId", f.title, f.amount, f.due_date "dueDate", p.at IS NOT NULL paid, p.at "paidAt" FROM fees f LEFT JOIN payments p ON p.fee_id=f.id AND p.student_id=$2 WHERE f.school_id=$1 ORDER BY f.seq`, [sid, u.id]);
    return (await all(`SELECT f.id, f.school_id "schoolId", f.title, f.amount, f.due_date "dueDate", coalesce(array_agg(p.student_id) FILTER (WHERE p.student_id IS NOT NULL), '{}') "paidBy", array_agg(p.at) FILTER (WHERE p.student_id IS NOT NULL) ats
      FROM fees f LEFT JOIN payments p ON p.fee_id=f.id WHERE f.school_id=$1 GROUP BY f.id ORDER BY f.seq`, [sid])).map(({ ats, ...x }) => ({ ...x, paidAt: Object.fromEntries(x.paidBy.map((s, i) => [s, ats[i]])), paidCount: x.paidBy.length }));
  }
  if (k === 'POST pay') {
    need('student');
    if (!await one('SELECT 1 FROM fees WHERE id=$1 AND school_id=$2', [b.feeId, sid])) E(404, 'Fee not found');
    await pool.query('INSERT INTO payments (fee_id, student_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [b.feeId, u.id, Date.now()]); return { ok: 1 };
  }
  E(404, 'Not found');
}

// HTTPS: either this server holds the certificate (TLS_KEY_FILE, TLS_CERT_FILE), or the hosting service does and sets x-forwarded-proto (TRUST_PROXY=1)
const TLS = process.env.TLS_KEY_FILE && process.env.TLS_CERT_FILE && { key: fs.readFileSync(process.env.TLS_KEY_FILE), cert: fs.readFileSync(process.env.TLS_CERT_FILE) };
const PROXY = process.env.TRUST_PROXY === '1';
const toHttps = (req, res) => {
  const port = !TLS || +PORT === 443 ? '' : ':' + PORT;
  res.writeHead(308, { Location: `https://${req.headers.host.replace(/:\d+$/, '')}${port}${req.url}` });
  res.end();
};
// the page and logo are read once and kept zipped; a newer file on disk replaces them
const pages = {};
const page = async (res, req, name, type, age) => {
  const f = path.join(__dirname, name), t = (await fs.promises.stat(f)).mtimeMs;
  if (!pages[name] || pages[name].t !== t) { const raw = await fs.promises.readFile(f); pages[name] = { t, raw, zip: zlib.gzipSync(raw) }; }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': type, ...(age ? { 'Cache-Control': `max-age=${age}` } : {}), ...(gz ? { 'Content-Encoding': 'gzip' } : {}), Vary: 'Accept-Encoding' });
  res.end(gz ? pages[name].zip : pages[name].raw);
};
const app = (req, res) => {
  const secure = TLS || String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https';
  if (PROXY && !secure) return toHttps(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (PROXY || TLS) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x'); let body = '';
  const isNotes = url.pathname === '/api/notes', max = (isNotes ? 15 : 5) * 1024 * 1024; // 10 MB of note files is about 13.4 MB as base64
  req.on('data', d => {
    body += d;
    if (body.length > max) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: isNotes ? 'Request too large. Keep files within 10 MB in total.' : 'Request too large. Choose an image under 3 MB.' })); req.destroy(); }
  });
  req.on('end', async () => {
    const send = (c, o) => {
      const text = JSON.stringify(o), head = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
      if (text.length < 2048 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(c, head); return res.end(text); }
      zlib.gzip(text, { level: 4 }, (e, zip) => { res.writeHead(c, { ...head, 'Content-Encoding': 'gzip' }); res.end(zip); });
    };
    try {
      if (url.pathname === '/logo.png') return await page(res, req, 'logo.png', 'image/png', 86400);
      if (url.pathname === '/school-login') return await page(res, req, 'school-login.html', 'text/html; charset=utf-8');      if (!url.pathname.startsWith('/api/')) return await page(res, req, 'index.html', 'text/html; charset=utf-8');
      const r = req.headers.authorization && await one(`SELECT ${USER}, salt, h FROM users WHERE id = (SELECT user_id FROM sessions WHERE token=$1 AND expires>$2)`, [sha(req.headers.authorization), Date.now()]);
      send(200, await handle(req.method, url.pathname.slice(5), url.searchParams, body ? JSON.parse(body) : {}, r ? rec(r) : undefined));
    } catch (e) {
      if (e.code === '23505') return send(400, { error: 'Username already taken' }); // two people took the same name at the same moment
      if (!e.c && !(e instanceof SyntaxError)) console.error(e);
      send(e.c || (e instanceof SyntaxError ? 400 : 500), { error: e.m || (e instanceof SyntaxError ? e.message : 'Something went wrong. Please try again.') });
    }
  });
};

// one process per CPU core, up to WORKERS. They share nothing but PostgreSQL and the upload folders;
// the first process starts them and alone does the daily jobs, so these run once
const WORKERS = Math.max(+process.env.WORKERS || Math.min(os.availableParallelism(), 4), 1);
const started = () => console.log(`Running on ${TLS ? 'https' : 'http'}://localhost:${PORT} with ${WORKERS} workers` + (TLS || PROXY ? '' : '\nHTTPS is OFF: use this for local testing only, see README.txt') + (mailer ? '' : '\nEmail is NOT configured: see .env.example'));
const ALERT = process.env.BACKUP_ALERT_EMAIL;
const backupNow = async () => {
  try { if (await backupDue()) await runBackup('daily'); }
  catch (e) {
    console.error('BACKUP FAILED:', e.message);
    if (ALERT) sendMail(ALERT, 'ONERA backup FAILED', `Today's database backup did not work:\n\n${e.message}\n\nThe server will try again in 15 minutes.`);
  }
};
const jobs = () => {
  const safe = f => f().catch(e => console.error(`${f.name} failed:`, e.message));
  const sweep = () => Promise.all([
    pool.query('DELETE FROM sessions WHERE expires<$1', [Date.now()]),
    pool.query('DELETE FROM otps WHERE x<$1', [Date.now()]),
    pool.query('DELETE FROM mail_gaps WHERE at<$1', [Date.now() - MAIL_GAP_MS])
  ]);
  safe(promote); // also catches up if the server was off on 1 April
  setInterval(() => safe(promote), 36e5);
  setInterval(() => safe(sweep), 36e5);
  backupNow();
  setInterval(backupNow, 15 * 6e4);
};

if (cluster.isPrimary) (async () => {
  await schema();
  if (!await one('SELECT 1 FROM users LIMIT 1')) {
    if (!await migrate()) {
      const a = await mk({ role: 'admin', name: 'Super Admin', username: 'admin' }, 'admin123');
      await addUser(a);
    }
  }
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', () => setTimeout(() => cluster.fork(), 1000));
  started();
  jobs();
})().catch(e => { console.error('Cannot start:', e.message); process.exit(1); });
else if (TLS) {
  https.createServer(TLS, app).listen(PORT);
  if (process.env.HTTP_PORT) http.createServer(toHttps).listen(process.env.HTTP_PORT); // sends plain http visitors to https
} else http.createServer(app).listen(PORT);
