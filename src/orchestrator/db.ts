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
      feature_id TEXT,
      feature_part TEXT,
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
  const hasFeatureId = columns.some((column) => column.name === 'feature_id');
  const hasFeaturePart = columns.some((column) => column.name === 'feature_part');
  const hasPushMode = columns.some((column) => column.name === 'push_mode');
  
  if (!hasConversationId) {
    db.exec('ALTER TABLE jobs ADD COLUMN conversation_id TEXT');
  }
  if (!hasFeatureId) {
    db.exec('ALTER TABLE jobs ADD COLUMN feature_id TEXT');
  }
  if (!hasFeaturePart) {
    db.exec('ALTER TABLE jobs ADD COLUMN feature_part TEXT');
  }
  if (!hasPushMode) {
    db.exec("ALTER TABLE jobs ADD COLUMN push_mode TEXT DEFAULT 'always'");
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_feature_id ON jobs(feature_id)');

  // Job dependencies table for DAG support
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_dependencies (
      job_id TEXT NOT NULL,
      depends_on_job_id TEXT NOT NULL,
      PRIMARY KEY (job_id, depends_on_job_id),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_dependencies_job_id ON job_dependencies(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_dependencies_depends_on ON job_dependencies(depends_on_job_id);
  `);
};;

export const initDb = (): BetterSqlite3Database => {
  const db = getDb();
  runMigrations();
  return db;
};
