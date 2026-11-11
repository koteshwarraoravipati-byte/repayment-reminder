import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.resolve(__dirname, '../data/debts.db');

const SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lender TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'LOAN',
  principal_amount REAL NOT NULL,
  remaining_balance REAL NOT NULL,
  interest_rate REAL NOT NULL DEFAULT 0,
  minimum_payment REAL NOT NULL DEFAULT 0,
  next_due_date TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'MONTHLY',
  auto_pay INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  days_before INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'IN_APP',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNREAD',
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (debt_id, due_date, days_before)
);

CREATE TABLE IF NOT EXISTS reminder_settings (
  id INTEGER PRIMARY KEY,
  lead_days TEXT NOT NULL DEFAULT '7,3,1,0',
  daily_cron TEXT NOT NULL DEFAULT '0 9 * * *',
  browser_notifications INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  reminder_email TEXT NOT NULL DEFAULT '',
  preferred_strategy TEXT NOT NULL DEFAULT 'avalanche',
  currency TEXT NOT NULL DEFAULT 'INR',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_debts_status_due ON debts (status, next_due_date);
CREATE INDEX IF NOT EXISTS ix_payments_debt ON payments (debt_id);
CREATE INDEX IF NOT EXISTS ix_reminders_status ON reminders (status);
`;

function toSqliteQuery(sql, params = []) {
  const ordered = [];
  const translated = sql.replace(/\$(\d+)/g, (_, idx) => {
    const val = params[Number(idx) - 1];
    ordered.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
    return '?';
  });
  return { sql: translated, params: ordered };
}

export function createDb(options = {}) {
  const databaseUrl = (options.databaseUrl ?? process.env.DATABASE_URL ?? '').trim();
  const isPostgres = databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');
  const isVercelEphemeral = !isPostgres && !options.sqlitePath && Boolean(process.env.VERCEL);
  const persistence = isPostgres ? 'postgres' : isVercelEphemeral ? 'ephemeral-tmp' : 'sqlite-file';

  let sqliteDb = null;
  let pgPool = null;

  async function init() {
    if (isPostgres) {
      pgPool = new pg.Pool({
        connectionString: databaseUrl,
        ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
      });
      const schemaSql = fs.readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8');
      await pgPool.query(schemaSql);
    } else {
      const dbPath = options.sqlitePath || process.env.SQLITE_PATH || (isVercelEphemeral ? '/tmp/debts.db' : DEFAULT_SQLITE_PATH);
      if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      }
      sqliteDb = new DatabaseSync(dbPath);
      sqliteDb.exec(SQLITE_SCHEMA);
    }

    await execute(
      `INSERT INTO reminder_settings (id, lead_days, daily_cron, browser_notifications, email_enabled, reminder_email, preferred_strategy, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [1, '7,3,1,0', process.env.REMINDER_CRON || '0 9 * * *', true, false, process.env.REMINDER_EMAIL_TO || '', 'avalanche', 'INR']
    );
  }

  async function query(sql, params = []) {
    if (isPostgres) {
      const res = await pgPool.query(sql, params);
      return res.rows;
    }
    const q = toSqliteQuery(sql, params);
    return sqliteDb.prepare(q.sql).all(...q.params);
  }

  async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] || null;
  }

  async function execute(sql, params = []) {
    if (isPostgres) {
      const res = await pgPool.query(sql, params);
      return { changes: res.rowCount || 0 };
    }
    const q = toSqliteQuery(sql, params);
    const info = sqliteDb.prepare(q.sql).run(...q.params);
    return { changes: Number(info.changes || 0), lastInsertRowid: Number(info.lastInsertRowid || 0) };
  }

  async function insert(sql, params = []) {
    if (isPostgres) {
      const hasReturning = /\breturning\b/i.test(sql);
      const res = await pgPool.query(hasReturning ? sql : `${sql} RETURNING id`, params);
      return res.rows[0]?.id ?? null;
    }
    const q = toSqliteQuery(sql, params);
    const info = sqliteDb.prepare(q.sql).run(...q.params);
    return Number(info.lastInsertRowid);
  }

  async function close() {
    if (pgPool) await pgPool.end();
    if (sqliteDb) sqliteDb.close();
  }

  return { init, query, queryOne, execute, insert, close, dialect: isPostgres ? 'postgres' : 'sqlite', persistence };
}
