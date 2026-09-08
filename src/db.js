import * as SQLite from 'expo-sqlite';

const FREE_DOMAINS = new Set(['gmail.com','yahoo.com','yahoo.co.in','outlook.com','hotmail.com','live.com','icloud.com','rediffmail.com']);

let _db = null;
function getDb() {
  if (_db) return _db;
  _db = SQLite.openDatabaseSync('reach.db');
  _db.execSync(`CREATE TABLE IF NOT EXISTS sent (
    email TEXT PRIMARY KEY, domain TEXT NOT NULL DEFAULT '', sent_at TEXT, subject TEXT
  )`);
  _db.execSync(`CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_email TEXT, from_name TEXT, company TEXT,
    subject TEXT, preview TEXT, received_at TEXT, suggested_reply TEXT
  )`);
  _db.execSync(`CREATE INDEX IF NOT EXISTS idx_sent_domain ON sent(domain)`);
  // Follow-up tracking columns (idempotent)
  const addCol = (col, def) => { try { _db.execSync(`ALTER TABLE sent ADD COLUMN ${col} ${def}`); } catch {} };
  addCol('name',         "TEXT DEFAULT ''");
  addCol('company',      "TEXT DEFAULT ''");
  addCol('followup1_at', 'TEXT DEFAULT NULL');
  addCol('followup2_at', 'TEXT DEFAULT NULL');
  addCol('replied',      'INTEGER DEFAULT 0');
  return _db;
}

export function alreadySent(email) {
  const e = email.toLowerCase().trim();
  const db = getDb();
  if (db.getFirstSync('SELECT 1 FROM sent WHERE email=?', [e])) return true;
  const domain = e.split('@')[1] || '';
  if (FREE_DOMAINS.has(domain)) return false;
  return !!db.getFirstSync('SELECT 1 FROM sent WHERE domain=?', [domain]);
}

export function markSent(email, subject = '', name = '', company = '') {
  const e = email.toLowerCase().trim();
  const domain = e.split('@')[1] || '';
  getDb().runSync(
    'INSERT OR IGNORE INTO sent (email, domain, sent_at, subject, name, company) VALUES (?,?,?,?,?,?)',
    [e, domain, new Date().toISOString(), subject, name, company]
  );
}

export function markReplied(email) {
  getDb().runSync('UPDATE sent SET replied=1 WHERE email=?', [email.toLowerCase().trim()]);
}

export function getDueFollowups(followupNum) {
  const db = getDb();
  const daysAgo = followupNum === 1 ? 3 : 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysAgo);
  const col = followupNum === 1 ? 'followup1_at' : 'followup2_at';
  const prevGuard = followupNum === 2 ? 'AND followup1_at IS NOT NULL' : '';
  return db.getAllSync(
    `SELECT * FROM sent WHERE sent_at <= ? AND replied=0 AND ${col} IS NULL ${prevGuard} LIMIT 10`,
    [cutoff.toISOString()]
  );
}

export function markFollowupSent(email, followupNum) {
  const col = followupNum === 1 ? 'followup1_at' : 'followup2_at';
  getDb().runSync(`UPDATE sent SET ${col}=? WHERE email=?`, [new Date().toISOString(), email.toLowerCase().trim()]);
}

export function getStats() {
  const db = getDb();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const total    = db.getFirstSync('SELECT COUNT(*) as n FROM sent')?.n || 0;
  const todaySent= db.getFirstSync("SELECT COUNT(*) as n FROM sent WHERE sent_at LIKE ?", [`${today}%`])?.n || 0;
  const replies  = db.getFirstSync('SELECT COUNT(*) as n FROM replies')?.n || 0;
  return { total, todaySent, replies };
}

// Returns today's send cap based on account warmup ramp
// Day 0 = first ever send → 3; Day 4+ → 15 (full speed)
const WARMUP_RAMP = [3, 5, 8, 12, 15];
export function getWarmupCap() {
  const db = getDb();
  const row = db.getFirstSync('SELECT MIN(sent_at) as first FROM sent');
  if (!row?.first) return WARMUP_RAMP[0]; // no emails ever sent yet — day 0
  const firstDate = new Date(row.first);
  const today = new Date();
  const daysElapsed = Math.floor((today - firstDate) / (1000 * 60 * 60 * 24));
  return WARMUP_RAMP[Math.min(daysElapsed, WARMUP_RAMP.length - 1)];
}

export function saveReply({ fromEmail, fromName, company, subject, preview, suggestedReply }) {
  getDb().runSync(
    'INSERT INTO replies (from_email,from_name,company,subject,preview,received_at,suggested_reply) VALUES (?,?,?,?,?,?,?)',
    [fromEmail, fromName, company || '', subject, preview, new Date().toISOString(), suggestedReply || '']
  );
}

export function getRecentReplies(limit = 30) {
  return getDb().getAllSync('SELECT * FROM replies ORDER BY id DESC LIMIT ?', [limit]);
}
