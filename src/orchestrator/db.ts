import fs from 'node:fs';
import path from 'node:path';

import DatabaseConstructor, { Database as BetterSqlite3Database } from 'better-sqlite3';

const DEFAULT_DB_PATH = process.env.ORCHESTRATOR_DB_PATH ?? path.resolve(process.cwd(), 'orchestrator.sqlite');

let dbInstance: BetterSqlite3Database | null = null;

const ensureDbDirectory = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const createConnection = (): BetterSqlite3Database => {
  ensureDbDirectory(DEFAULT_DB_PATH);
  const instance = new DatabaseConstructor(DEFAULT_DB_PATH);
  instance.pragma('journal_mode = WAL');
  return instance;
};

export const getDb = (): BetterSqlite3Database => {
  if (!dbInstance) {
    dbInstance = createConnection();
  }
  return dbInstance;
};

export const runMigrations = (): void => {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      repo_url TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worker_type TEXT NOT NULL,
      status TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      result_summary TEXT,
      conversation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_worker_type ON jobs(worker_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_worker_type ON jobs(status, worker_type);
  `);

  const columns = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
  const hasConversationId = columns.some((column) => column.name === 'conversation_id');
  if (!hasConversationId) {
    db.exec('ALTER TABLE jobs ADD COLUMN conversation_id TEXT');
  }
};

export const initDb = (): BetterSqlite3Database => {
  const db = getDb();
  runMigrations();
  return db;
};
