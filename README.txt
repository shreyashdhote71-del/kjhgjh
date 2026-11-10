ONERA WEBSITE — FIXED PROJECT

IMPORTANT: This website has a frontend AND a Node.js backend. Uploading index.html alone to Tiiny.site or another static HTML host will NOT make the login/API work. The backend must run on a Node.js host.

LOCAL WINDOWS TEST
1. Install Node.js LTS from https://nodejs.org
2. Set up PostgreSQL: see POSTGRESQL below.
3. Extract this ONERA folder.
4. Open the ONERA folder in VS Code using File > Open Folder.
5. Choose Terminal > New Terminal.
6. Run: npm install
7. Run: npm start
   (or: node server.js)
8. Keep the terminal running.
9. Open http://localhost:3000 — do not use Live Server port 5500 and do not open index.html directly.

FORGOT USERNAME / PASSWORD EMAILS
1. Copy .env.example to .env and fill in the mail account. Gmail needs an App Password. On a hosting service, set these as environment variables instead of using .env.
2. Restart the server.
Forgot username and forgot password both email a 6-digit code that expires in 10 minutes and allows 5 tries. Each user needs a saved email: fill it in on the Profile page, or when creating the account. A student's password code goes to their school admin's email, and the admin passes it on; if the school admin has no saved email, it goes to the student's own email instead. Until mail is configured, messages (including codes) are printed in the server terminal instead of being sent. Never commit .env.

DEFAULT DEMO ADMIN
Username: admin
Password: admin123
Change/remove this demo password before public use.

DEPLOY ONLINE
Deploy the entire ONERA folder/repository to a Node.js hosting service with a PostgreSQL database and a persistent disk. Set DATABASE_URL, DATA_KEY and DATA_DIR in its environment settings. Build command: npm install; start command: npm start. The service must run server.js and serve index.html from the same origin. Do not deploy only index.html to Tiiny.site. If using a separate static frontend, its API URL must point to the deployed backend and the backend must allow that frontend origin.

POSTGRESQL
All records live in PostgreSQL (version 14 or newer). The server will not start without DATABASE_URL.
1. Install PostgreSQL from https://www.postgresql.org/download/ and remember the password you set for the "postgres" user. On a hosting service, create a managed PostgreSQL database instead and skip step 2.
2. Open "SQL Shell (psql)", log in as postgres, and run these two lines with a strong password of your own:
   CREATE USER onera WITH PASSWORD 'yourpassword';
   CREATE DATABASE onera OWNER onera;
3. In .env, set DATABASE_URL=postgres://onera:yourpassword@localhost:5432/onera
4. Run: npm install
5. Run: npm start
The server creates its own tables at every start. If the database is empty and db.json exists, everything in db.json and school-data is moved in once, and the server prints how many records moved. db.json and school-data are left as they were, but nothing reads them after that: keep them for a while, then store them safely away from the server.
Records whose school or student no longer exists cannot join the database. They are listed by the server and kept in migration-skipped.json, sealed with DATA_KEY.

BACKUPS
The server backs up the database by itself, every day at 2 AM (BACKUP_HOUR). If it was off at that time, the backup runs as soon as it starts again. Each backup is checked by PostgreSQL's own tools before it counts.
Backups are in the backups folder (BACKUP_DIR), encrypted with DATA_KEY. The last 14 daily backups are kept (BACKUP_KEEP_DAYS), plus one for each of the last 12 months. Backups made before a yearly promotion or a restore are never removed by the server. New note files and ID photos are copied to files inside the same folder; copies of deleted files stay there until you remove them, so clear them by hand if a family asks for their documents to be erased.
1. A backup on the same disk does not survive that disk. Set BACKUP_COPY_DIR to another disk, or to a folder that syncs to the cloud.
2. Set BACKUP_ALERT_EMAIL to get an email if a backup fails. Without it, a failure only shows in the server's log.
3. Keep DATA_KEY somewhere else as well. Backups cannot be opened without it.
A crash can lose up to one day of changes, back to the last backup. To lose less, use a managed PostgreSQL with point-in-time recovery.
Commands (the machine needs PostgreSQL's pg_dump and pg_restore, of the same or a newer version than the database; set PG_BIN if they are not found):
   npm run backup                  make a backup now
   node backup.js list             show the backups
   node backup.js restore <file> --yes     replace the whole database with a backup
Stop the server before a restore. It first saves the current database as a "before-restore" backup. Try a restore on a spare database a few times a year: a backup is only proven once it has been restored.

SIZE: 50,000 TO 1,00,000 STUDENTS
SIZE-RESULTS-HERE
What the design relies on:
- Every list is limited to one school, or one class and month, and uses a database index. No page loads all students on the platform.
- Passwords are checked without blocking other requests, and each server process runs on its own CPU core (WORKERS).
- Logins and email codes are in the database, so a restart does not log anybody out. A login lasts 30 days.
- ID photos are sealed files in doc-files, not in the database, so backups stay small. They are fetched one at a time, with the "View photo" button.
For real use on this scale:
- Run PostgreSQL on a machine that does not sleep or shut down, with an SSD. A laptop is for testing only.
- Set shared_buffers to about a quarter of the database machine's RAM, and keep WORKERS x PG_POOL below max_connections.
- On a hosting service, DATA_DIR must be a persistent disk, or uploaded files disappear at each deploy.
- All server processes must share DATA_DIR, so this design runs on one app machine. The daily jobs also assume one machine. Use a bigger machine first; going to several needs shared file storage such as S3, and only one machine running the jobs.
- One school with several thousand students makes its admin pages heavier, because People, Results and the dashboard load that school's whole list into the browser.
- Do not store real student certificates until HTTPS, a strong admin password and backups are all in place.

CLASS SECTIONS
Schools run classes 1 to 10 with sections A, B and C (for example 5-A). Colleges keep semesters 1 to 8 without sections. Records from before sections were added are moved along with db.json: students and notes go to section A, teachers get all three sections of their classes.

TIMETABLE AND HOMEWORK
The school admin builds each class's timetable under Timetable; a class or teacher cannot get two periods at the same time. Teachers see the timetable of the classes they teach, and students see only their own class. Teachers give homework to their own classes with a due date, and students see only their own class's homework. School admins can see and delete all of it. Homework is free, unlike notes.

YEARLY PROMOTION
On 1 April the server moves every school student up one class in the same section (5-A goes to 6-A). Class 10 students become "Passed out": they keep their login and records, and can be found under Show > Passed out in People. If the server is off on 1 April, this runs the next time it starts. Colleges and teachers' classes do not change. A backup named before-promotion-YEAR is made first; if that backup fails, the promotion waits and tries again every hour. The database remembers the last year done.

PROFILES
Every login has a Profile page for personal, family and contact details. School admins can also open the profile of their own teachers and students from People. Teachers cannot see student profiles and the main admin cannot see anyone else's.

ENCRYPTION
Emails, profiles, profile photos and ID documents are encrypted with AES-256-GCM using DATA_KEY before they reach the database or the doc-files folder, and the server will not start without it. Backups are fully encrypted too. Files in note-files are study material and are not encrypted, so do not attach personal documents to notes.
Names, usernames, classes, marks, attendance and fee records are NOT encrypted inside PostgreSQL, because the database has to search and add them up. Protect them with a strong database password, no public access to the database, and disk encryption on its machine (BitLocker on Windows; managed databases usually do this for you). Password hashes and login tokens are never stored in a readable form.
Keep a copy of DATA_KEY in a password manager or on paper, not in this folder: if it is lost, the data cannot be recovered by anyone. On a hosting service, set it as an environment variable. Never store the key side by side with the backups.

HTTPS
Without HTTPS, passwords and ID photos travel over the internet readable. Plain http is fine only for testing on localhost; the server prints a warning in that case. For real use, pick one:
1. Host with built-in HTTPS (Render, Railway and similar): set TRUST_PROXY=1 and DATA_KEY in the host's environment settings. Every http visit is sent to https.
2. Your own server: get a free certificate for your domain from Let's Encrypt, then set TLS_KEY_FILE, TLS_CERT_FILE, PORT=443 and HTTP_PORT=80. Restart the server after each certificate renewal.
Do not set TRUST_PROXY=1 on a plain local run: every page would redirect to an https address that is not there.

NOTE FILES
PDFs and images that teachers attach to notes are kept in the note-files folder; the database only stores their names. The daily backup copies this folder too.

PAYMENTS
The current payment/subscribe actions are demonstrations only; they do not process real money.
