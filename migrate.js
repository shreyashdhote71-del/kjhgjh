// Moves an old db.json and school-data into PostgreSQL. server.js runs this once, when the users table is empty.
// db.json and school-data are only read, never changed, so they stay as a copy of the old data.
const fs = require('fs'), path = require('path');
const { seal, unseal, emailHash, tx, setMeta, DOC_DIR } = require('./store');

const DB = path.join(__dirname, 'db.json'), SCHOOL_DIR = path.join(__dirname, 'school-data');
const read = f => {
  try { return JSON.parse(unseal(String(fs.readFileSync(f)))); } catch (e) { throw new Error(`Cannot read ${f}: wrong DATA_KEY or a damaged file (${e.message})`); }
};

module.exports = async () => {
  if (!fs.existsSync(DB)) return false;
  const db = read(DB);
  ['u', 's', 'n', 'r', 'd', 'f', 'p', 'a', 'b', 't', 'h'].forEach(k => { db[k] = db[k] || []; });
  if (fs.existsSync(SCHOOL_DIR)) fs.readdirSync(SCHOOL_DIR).filter(f => f.endsWith('.json')).forEach(f => {
    db.d.push(...read(path.join(SCHOOL_DIR, f)).docs.filter(v => !db.d.some(y => y.id === v.id)));
  });

  const schools = new Set(db.s.map(x => x.id)), users = new Set(db.u.map(x => x.id)), fees = new Set(db.f.map(x => x.id));
  const college = id => (db.s.find(v => v.id === id) || {}).type === 'College';
  // older school records have only a class number: students and notes go to section A, teachers keep every section of their classes
  const fixCls = x => typeof x.cls === 'number' && !college(x.schoolId) ? `${x.cls}-A` : x.cls;
  const fixClasses = x => (x.classes || []).flatMap(c => typeof c === 'number' && !college(x.schoolId) ? ['A', 'B', 'C'].map(v => `${c}-${v}`) : [c]).map(String);
  const str = v => v === undefined || v === null ? null : String(v);

  // records whose school or student no longer exists cannot join the database: they are kept in a sealed file
  const skipped = {}, keep = (k, list, ok) => list.filter(x => ok(x) || !(skipped[k] = skipped[k] || []).push(x));
  const inSchool = x => schools.has(x.schoolId), ofStudent = x => inSchool(x) && users.has(x.studentId);
  const noticesL = keep('notices', db.b, inSchool), notesL = keep('notes', db.n, inSchool), hwL = keep('homework', db.h, inSchool), ttL = keep('timetable', db.t, inSchool);
  const resultsL = keep('results', db.r, ofStudent), attL = keep('attendance', db.a, ofStudent), docsL = keep('docs', db.d, ofStudent), feesL = keep('fees', db.f, inSchool);
  const paysL = keep('payments', db.p, x => users.has(x.s) && fees.has(x.f) && feesL.some(v => v.id === x.f));
  const usersL = keep('users', db.u, x => !x.schoolId || schools.has(x.schoolId));

  const done = await tx(async c => {
    for (const x of db.s) await c.query('INSERT INTO schools (id, name, type, city, by_name, at) VALUES ($1,$2,$3,$4,$5,$6)', [x.id, x.name, x.type, x.city, x.by || 'Super Admin', x.at]);
    for (const x of usersL) {
      const email = x.email ? String(x.email).toLowerCase() : null;
      await c.query('INSERT INTO users (id, role, name, username, school_id, cls, classes, sub, salt, h, email, email_hash, photo, profile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [
        x.id, x.role, x.name, x.username, x.schoolId || null, str(fixCls(x)), x.classes ? fixClasses(x) : null, x.sub || null, x.salt, x.h,
        email && seal(email), emailHash(email), x.photo ? seal(x.photo) : null, x.profile ? seal(JSON.stringify(x.profile)) : null
      ]);
    }
    for (const x of noticesL) await c.query('INSERT INTO notices (id, school_id, title, body, by_name, at) VALUES ($1,$2,$3,$4,$5,$6)', [x.id, x.schoolId, x.title, x.body, x.by, x.at]);
    for (const x of notesL) await c.query('INSERT INTO notes (id, school_id, cls, title, content, files, by_name, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [x.id, x.schoolId, str(fixCls(x)), x.title, x.content, JSON.stringify(x.files || []), x.by, x.at]);
    for (const x of hwL) await c.query('INSERT INTO homework (id, school_id, cls, subject, details, due, by_name, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [x.id, x.schoolId, str(fixCls(x)), x.subject, x.details, x.due, x.by, x.at]);
    for (const x of ttL) await c.query('INSERT INTO timetable (id, school_id, cls, day, start_t, end_t, subject, teacher_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [x.id, x.schoolId, str(fixCls(x)), x.day, x.start, x.end, x.subject, x.teacherId || null]);
    for (const x of resultsL) await c.query('INSERT INTO results (id, school_id, student_id, exam, subject, marks, total) VALUES ($1,$2,$3,$4,$5,$6,$7)', [x.id, x.schoolId, x.studentId, x.exam, x.subject, x.marks, x.total]);
    for (const x of attL) await c.query(`INSERT INTO attendance (id, school_id, student_id, month, days) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (student_id, month) DO UPDATE SET days = ARRAY(SELECT DISTINCT v FROM unnest(attendance.days || EXCLUDED.days) v ORDER BY v)`, [x.id, x.schoolId, x.studentId, x.month, x.days || []]);
    for (const x of feesL) await c.query('INSERT INTO fees (id, school_id, title, amount, due_date) VALUES ($1,$2,$3,$4,$5)', [x.id, x.schoolId, x.title, x.amount, x.dueDate]);
    for (const x of paysL) await c.query('INSERT INTO payments (fee_id, student_id, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [x.f, x.s, x.at]);
    for (const x of docsL) {
      await c.query('INSERT INTO docs (id, school_id, student_id, type) VALUES ($1,$2,$3,$4)', [x.id, x.schoolId, x.studentId, x.type]);
      if (x.photoData) fs.writeFileSync(path.join(DOC_DIR, x.id), seal(x.photoData));
    }
    if (db.promoted) await setMeta('promoted', db.promoted, c);
    return { schools: db.s.length, users: usersL.length, notices: noticesL.length, notes: notesL.length, homework: hwL.length, timetable: ttL.length, results: resultsL.length, attendance: attL.length, fees: feesL.length, payments: paysL.length, docs: docsL.length };
  });

  console.log('Moved db.json into PostgreSQL:', JSON.stringify(done));
  if (Object.keys(skipped).length) {
    fs.writeFileSync(path.join(__dirname, 'migration-skipped.json'), seal(JSON.stringify(skipped)));
    console.log('Not moved, because their school or student is gone (kept sealed in migration-skipped.json):', JSON.stringify(Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length]))));
  }
  return true;
};
