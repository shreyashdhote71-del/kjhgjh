-- ONERA database. Safe to run again: the server runs it at every start.
-- Times are milliseconds since 1970, like Date.now(). seq keeps the order records were added.
-- email, photo and profile in users are sealed by the server with DATA_KEY; ID document photos are sealed files in doc-files.

CREATE TABLE IF NOT EXISTS meta (k text PRIMARY KEY, v text NOT NULL);

CREATE TABLE IF NOT EXISTS schools (
  seq bigserial, id text PRIMARY KEY, name text NOT NULL, type text, city text, by_name text NOT NULL DEFAULT 'Super Admin', at bigint
);

CREATE TABLE IF NOT EXISTS users (
  seq bigserial, id text PRIMARY KEY, role text NOT NULL, name text NOT NULL, username text NOT NULL UNIQUE,
  school_id text REFERENCES schools ON DELETE CASCADE, cls text, classes text[], sub bigint,
  salt text NOT NULL, h text NOT NULL, email text, email_hash text, photo text, profile text
);
CREATE INDEX IF NOT EXISTS users_school ON users (school_id, role, cls);
CREATE INDEX IF NOT EXISTS users_email ON users (email_hash) WHERE email_hash IS NOT NULL;

-- tokens are kept hashed, so a stolen database copy cannot log anybody in
CREATE TABLE IF NOT EXISTS sessions (token text PRIMARY KEY, user_id text NOT NULL REFERENCES users ON DELETE CASCADE, expires bigint NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);

CREATE TABLE IF NOT EXISTS otps (k text PRIMARY KEY, h text NOT NULL, x bigint NOT NULL, n int NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mail_gaps (k text PRIMARY KEY, at bigint NOT NULL);

CREATE TABLE IF NOT EXISTS notices (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE,
  title text NOT NULL, body text NOT NULL, by_name text, at bigint
);
CREATE INDEX IF NOT EXISTS notices_school ON notices (school_id, seq);

CREATE TABLE IF NOT EXISTS notes (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE, cls text NOT NULL,
  title text NOT NULL, content text, files jsonb NOT NULL DEFAULT '[]', by_name text, at bigint
);
CREATE INDEX IF NOT EXISTS notes_school ON notes (school_id, cls, seq);

CREATE TABLE IF NOT EXISTS homework (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE, cls text NOT NULL,
  subject text NOT NULL, details text NOT NULL, due text NOT NULL, by_name text, at bigint
);
CREATE INDEX IF NOT EXISTS homework_school ON homework (school_id, cls, seq);

-- class chat: one room per class (or semester). A deleted message is blanked and moved to a new seq, so open pages see it go
CREATE TABLE IF NOT EXISTS chat (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE, cls text NOT NULL,
  user_id text REFERENCES users ON DELETE SET NULL, by_name text NOT NULL, role text NOT NULL, body text NOT NULL,
  gone boolean NOT NULL DEFAULT false, at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_room ON chat (school_id, cls, seq);

CREATE TABLE IF NOT EXISTS timetable (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE, cls text NOT NULL,
  day text NOT NULL, start_t text NOT NULL, end_t text NOT NULL, subject text NOT NULL, teacher_id text
);
CREATE INDEX IF NOT EXISTS timetable_school ON timetable (school_id, cls, day);

CREATE TABLE IF NOT EXISTS results (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users ON DELETE CASCADE, exam text NOT NULL, subject text NOT NULL,
  marks double precision NOT NULL, total double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS results_school ON results (school_id, seq);
CREATE INDEX IF NOT EXISTS results_student ON results (student_id, seq);

CREATE TABLE IF NOT EXISTS attendance (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users ON DELETE CASCADE, month text NOT NULL, days int[] NOT NULL DEFAULT '{}',
  UNIQUE (student_id, month)
);
CREATE INDEX IF NOT EXISTS attendance_school ON attendance (school_id, month);

CREATE TABLE IF NOT EXISTS docs (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users ON DELETE CASCADE, type text NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_school ON docs (school_id, seq);
CREATE INDEX IF NOT EXISTS docs_student ON docs (student_id);

CREATE TABLE IF NOT EXISTS fees (
  seq bigserial, id text PRIMARY KEY, school_id text NOT NULL REFERENCES schools ON DELETE CASCADE,
  title text NOT NULL, amount double precision NOT NULL, due_date text NOT NULL
);
CREATE INDEX IF NOT EXISTS fees_school ON fees (school_id, seq);

CREATE TABLE IF NOT EXISTS payments (
  fee_id text NOT NULL REFERENCES fees ON DELETE CASCADE, student_id text NOT NULL REFERENCES users ON DELETE CASCADE,
  at bigint, PRIMARY KEY (fee_id, student_id)
);
CREATE INDEX IF NOT EXISTS payments_student ON payments (student_id);
