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
  feature_id: string | null;
  feature_part: string | null;
  push_mode: string | null;
  status: JobStatus;
  spec_json: string;
  result_summary: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateJobInput = Omit<Job, 'id' | 'created_at' | 'updated_at'>;

const JOB_COLUMNS = [
  'id',
  'repo_url',
  'base_ref',
  'branch_name',
  'worktree_path',
  'worker_type',
  'feature_id',
  'feature_part',
  'push_mode',
  'status',
  'spec_json',
  'result_summary',
  'conversation_id',
  'created_at',
  'updated_at',
].join(', ');;

const serializeResultSummary = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const deserializeJob = (row: JobRow): Job => {
  const db = getDb();
  const depsStmt = db.prepare('SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?');
  const depsRows = depsStmt.all(row.id) as Array<{ depends_on_job_id: string }>;
  const depends_on = depsRows.length > 0 ? depsRows.map((r) => r.depends_on_job_id) : undefined;

  return {
    id: row.id,
    repo_url: row.repo_url,
    base_ref: row.base_ref,
    branch_name: row.branch_name,
    worktree_path: row.worktree_path,
    worker_type: row.worker_type,
    feature_id: row.feature_id,
    feature_part: row.feature_part,
    push_mode: (row.push_mode as 'always' | 'never') ?? 'always',
    status: row.status,
    spec_json: JSON.parse(row.spec_json),
    result_summary: row.result_summary,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    depends_on,
  };
};

const PROTECTED_STATUSES: ReadonlySet<JobStatus> = new Set(['running', 'awaiting_input']);
const DEFAULT_BULK_DELETE_STATUSES: JobStatus[] = ['done', 'failed', 'cancelled'];
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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
      feature_id,
      feature_part,
      push_mode,
      status,
      spec_json,
      result_summary,
      conversation_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insert.run(
    id,
    job.repo_url,
    job.base_ref,
    job.branch_name,
    job.worktree_path,
    job.worker_type,
    job.feature_id ?? null,
    job.feature_part ?? null,
    job.push_mode ?? 'always',
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
};;

export const getJob = (id: string): Job | null => {
  const db = getDb();
  const stmt = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`);
  const row = stmt.get(id) as JobRow | undefined;
  if (!row) return null;
  return deserializeJob(row);
};

export const listJobs = (filter?: { status?: JobStatus; worker_type?: string; feature_id?: string }): Job[] => {
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

  if (filter?.feature_id) {
    conditions.push('feature_id = ?');
    params.push(filter.feature_id);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT ${JOB_COLUMNS} FROM jobs ${whereClause} ORDER BY datetime(created_at) DESC`;
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

  // If this job failed or was cancelled, recursively cancel all pending jobs that depend on it (cascading cancellation)
  if (status === 'failed' || status === 'cancelled') {
    const dependentJobs = getDependentJobs(id);
    for (const depJobId of dependentJobs) {
      const depJob = getJob(depJobId);
      if (depJob && depJob.status === 'pending') {
        const cancelSummary = {
          error: `Cancelled because dependency job ${id} ${status === 'failed' ? 'failed' : 'was cancelled'}`,
          cancelled_at: now
        };
        // Recursively cancel dependent jobs
        updateJobStatus(depJobId, 'cancelled', cancelSummary, ['pending']);
      }
    }
  }
};

export const claimJob = (worker_type: string): Job | null => {
  const db = getDb();

  const transaction = db.transaction((type: string): Job | null => {
    // Exclude jobs with:
    // 1. Same (branch_name, repo_url) as currently running or awaiting_input jobs (worktree conflict prevention)
    // 2. Unresolved dependencies (all dependencies must be 'done')
    // 3. Failed dependencies (any dependency is 'failed')
    const selectStmt = db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE status = 'pending'
         AND worker_type = ?
         AND NOT EXISTS (
           SELECT 1 FROM jobs AS running_jobs
           WHERE running_jobs.status IN ('running', 'awaiting_input')
             AND running_jobs.branch_name = jobs.branch_name
             AND running_jobs.repo_url = jobs.repo_url
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_dependencies AS dep
           JOIN jobs AS dep_jobs ON dep.depends_on_job_id = dep_jobs.id
           WHERE dep.job_id = jobs.id
             AND dep_jobs.status != 'done'
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_dependencies AS dep
           JOIN jobs AS dep_jobs ON dep.depends_on_job_id = dep_jobs.id
           WHERE dep.job_id = jobs.id
             AND dep_jobs.status = 'failed'
         )
       ORDER BY datetime(created_at) ASC
       LIMIT 1`
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

export const deleteJob = (id: string): Job | null => {
  const db = getDb();
  const transaction = db.transaction((jobId: string): Job | null => {
    const selectStmt = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`);
    const row = selectStmt.get(jobId) as JobRow | undefined;
    if (!row) return null;

    if (PROTECTED_STATUSES.has(row.status)) {
      throw new Error(`Cannot delete job ${jobId} while status is ${row.status}`);
    }

    // Prevent deleting jobs that other jobs depend on
    const dependentJobs = getDependentJobs(jobId);
    if (dependentJobs.length > 0) {
      throw new Error(`Cannot delete job ${jobId} because ${dependentJobs.length} job(s) depend on it: ${dependentJobs.join(', ')}`);
    }

    const deleteStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    deleteStmt.run(jobId);

    return deserializeJob(row);
  });

  return transaction(id);
};

export const deleteJobs = (filter: { statuses?: JobStatus[]; maxAgeDays?: number } = {}): { deleted: Job[]; count: number } => {
  const db = getDb();
  const statuses = (filter.statuses ?? DEFAULT_BULK_DELETE_STATUSES).filter((status) => !PROTECTED_STATUSES.has(status));

  if (statuses.length === 0) {
    return { deleted: [], count: 0 };
  }

  const cutoffIso =
    filter.maxAgeDays !== undefined
      ? new Date(Date.now() - filter.maxAgeDays * MILLISECONDS_PER_DAY).toISOString()
      : undefined;

  const transaction = db.transaction((statusesForDelete: JobStatus[], cutoff?: string) => {
    const conditions = [`status IN (${statusesForDelete.map(() => '?').join(', ')})`];
    const params: Array<string> = [...statusesForDelete];

    if (cutoff) {
      conditions.push('datetime(created_at) <= datetime(?)');
      params.push(cutoff);
    }

    const selectStmt = db.prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE ${conditions.join(' AND ')} ORDER BY datetime(created_at) ASC`
    );
    const rows = selectStmt.all(...params) as JobRow[];

    if (!rows.length) {
      return { deleted: [], count: 0 };
    }

    // Filter out jobs that other jobs depend on
    const deletableRows = rows.filter((row) => {
      const dependentJobs = getDependentJobs(row.id);
      return dependentJobs.length === 0;
    });

    const deleteStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    for (const row of deletableRows) {
      deleteStmt.run(row.id);
    }

    const deleted = deletableRows.map(deserializeJob);
    return { deleted, count: deleted.length };
  });

  return transaction(statuses, cutoffIso);
};

export const isWorktreeInUse = (worktreePath: string, excludeJobIds: string[] = []): boolean => {
  const db = getDb();
  const placeholders = excludeJobIds.map(() => '?').join(', ');
  const whereClause = excludeJobIds.length
    ? `WHERE worktree_path = ? AND id NOT IN (${placeholders})`
    : 'WHERE worktree_path = ?';
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM jobs ${whereClause}`);
  const params = excludeJobIds.length ? [worktreePath, ...excludeJobIds] : [worktreePath];
  const result = stmt.get(...params) as { count: number };
  return result.count > 0;
};

// ========== Job Dependencies Functions (DAG Support) ==========

/**
 * Set job dependencies for a given job.
 * This should be called within a transaction along with createJob.
 */
export const setJobDependencies = (jobId: string, dependsOn: string[]): void => {
  if (!dependsOn || dependsOn.length === 0) return;

  // Deduplicate dependencies to prevent primary key constraint errors
  const uniqueDeps = [...new Set(dependsOn)];

  const db = getDb();
  const insertStmt = db.prepare('INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)');

  for (const depId of uniqueDeps) {
    insertStmt.run(jobId, depId);
  }
};

/**
 * Get job IDs that the given job depends on.
 */
export const getJobDependencies = (jobId: string): string[] => {
  const db = getDb();
  const stmt = db.prepare('SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?');
  const rows = stmt.all(jobId) as Array<{ depends_on_job_id: string }>;
  return rows.map((r) => r.depends_on_job_id);
};

/**
 * Get job IDs that depend on the given job.
 */
export const getDependentJobs = (jobId: string): string[] => {
  const db = getDb();
  const stmt = db.prepare('SELECT job_id FROM job_dependencies WHERE depends_on_job_id = ?');
  const rows = stmt.all(jobId) as Array<{ job_id: string }>;
  return rows.map((r) => r.job_id);
};

/**
 * Check if adding the given dependencies would create a circular dependency.
 * Uses depth-first search to detect cycles.
 */
export const checkCircularDependency = (jobId: string, newDependencies: string[]): boolean => {
  const db = getDb();
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const dfs = (currentJobId: string): boolean => {
    visited.add(currentJobId);
    recursionStack.add(currentJobId);

    // Get dependencies for current job
    const stmt = db.prepare('SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?');
    const rows = stmt.all(currentJobId) as Array<{ depends_on_job_id: string }>;

    // If we're checking the original job, also consider the new dependencies
    const dependencies = currentJobId === jobId ? [...rows.map((r) => r.depends_on_job_id), ...newDependencies] : rows.map((r) => r.depends_on_job_id);

    for (const depId of dependencies) {
      if (!visited.has(depId)) {
        if (dfs(depId)) return true;
      } else if (recursionStack.has(depId)) {
        // Cycle detected
        return true;
      }
    }

    recursionStack.delete(currentJobId);
    return false;
  };

  return dfs(jobId);
};

/**
 * Check if all dependencies for a job are resolved (status = 'done').
 */
export const areDependenciesResolved = (jobId: string): boolean => {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT COUNT(*) as count
     FROM job_dependencies AS dep
     JOIN jobs AS dep_jobs ON dep.depends_on_job_id = dep_jobs.id
     WHERE dep.job_id = ?
       AND dep_jobs.status != 'done'`
  );
  const result = stmt.get(jobId) as { count: number };
  return result.count === 0;
};

/**
 * Check if any dependency for a job has failed.
 */
export const hasFailedDependency = (jobId: string): boolean => {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT COUNT(*) as count
     FROM job_dependencies AS dep
     JOIN jobs AS dep_jobs ON dep.depends_on_job_id = dep_jobs.id
     WHERE dep.job_id = ?
       AND dep_jobs.status = 'failed'`
  );
  const result = stmt.get(jobId) as { count: number };
  return result.count > 0;
};
