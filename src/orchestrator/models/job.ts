import { v4 as uuidv4 } from 'uuid';

import { getDb } from '../db.js';
import type { Job, JobStatus } from '../../shared/types.js';

type JobRow = {
  id: string;
  repo_url: string;
  base_ref: string;
  branch_name: string;
  worktree_path: string;
  worker_type: string;
  status: JobStatus;
  spec_json: string;
  result_summary: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateJobInput = Omit<Job, 'id' | 'created_at' | 'updated_at'>;

const serializeResultSummary = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const deserializeJob = (row: JobRow): Job => ({
  id: row.id,
  repo_url: row.repo_url,
  base_ref: row.base_ref,
  branch_name: row.branch_name,
  worktree_path: row.worktree_path,
  worker_type: row.worker_type,
  status: row.status,
  spec_json: JSON.parse(row.spec_json),
  result_summary: row.result_summary,
  conversation_id: row.conversation_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const createJob = (job: CreateJobInput): Job => {
  const db = getDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const insert = db.prepare(
    `INSERT INTO jobs (
      id,
      repo_url,
      base_ref,
      branch_name,
      worktree_path,
      worker_type,
      status,
      spec_json,
      result_summary,
      conversation_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insert.run(
    id,
    job.repo_url,
    job.base_ref,
    job.branch_name,
    job.worktree_path,
    job.worker_type,
    job.status,
    JSON.stringify(job.spec_json),
    job.result_summary ?? null,
    job.conversation_id ?? null,
    now,
    now
  );

  return {
    ...job,
    id,
    created_at: now,
    updated_at: now,
  };
};

export const getJob = (id: string): Job | null => {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const row = stmt.get(id) as JobRow | undefined;
  if (!row) return null;
  return deserializeJob(row);
};

export const listJobs = (filter?: { status?: JobStatus; worker_type?: string }): Job[] => {
  const db = getDb();
  const conditions: string[] = [];
  const params: Array<string> = [];

  if (filter?.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }

  if (filter?.worker_type) {
    conditions.push('worker_type = ?');
    params.push(filter.worker_type);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT * FROM jobs ${whereClause} ORDER BY datetime(created_at) DESC`;
  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as JobRow[];
  return rows.map(deserializeJob);
};

export const updateJobStatus = (
  id: string,
  status: JobStatus,
  result_summary?: unknown,
  expectedStatus?: JobStatus | JobStatus[],
  conversation_id?: string | null
): void => {
  const db = getDb();
  const now = new Date().toISOString();
  const assignments = ['status = ?', 'updated_at = ?'];
  const params: Array<string | null> = [status, now];

  if (result_summary !== undefined) {
    assignments.push('result_summary = ?');
    params.push(serializeResultSummary(result_summary));
  }

  if (conversation_id !== undefined) {
    assignments.push('conversation_id = ?');
    params.push(conversation_id);
  }

  const whereClauses = ['id = ?'];
  const whereParams: Array<string> = [id];

  if (expectedStatus) {
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const placeholders = statuses.map(() => '?').join(', ');
    whereClauses.push(`status IN (${placeholders})`);
    whereParams.push(...statuses);
  }

  const stmt = db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE ${whereClauses.join(' AND ')}`);
  const result = stmt.run(...params, ...whereParams);
  if (result.changes === 0) {
    if (expectedStatus) {
      throw new Error(`Job ${id} not found or status is not ${expectedStatus}`);
    }
    throw new Error(`Job ${id} not found`);
  }
};

export const claimJob = (worker_type: string): Job | null => {
  const db = getDb();

  const transaction = db.transaction((type: string): Job | null => {
    const selectStmt = db.prepare(
      `SELECT * FROM jobs WHERE status = 'pending' AND worker_type = ? ORDER BY datetime(created_at) ASC LIMIT 1`
    );
    const row = selectStmt.get(type) as JobRow | undefined;
    if (!row) return null;

    const updated_at = new Date().toISOString();
    const updateStmt = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?');
    updateStmt.run('running', updated_at, row.id);

    return deserializeJob({ ...row, status: 'running', updated_at });
  });

  return transaction(worker_type);
};
