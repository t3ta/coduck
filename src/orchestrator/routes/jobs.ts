import { Router } from 'express';
import { z } from 'zod';
import path from 'node:path';

import type { JobStatus, SpecJson } from '../../shared/types.js';
import { claimJob, createJob, deleteJob, deleteJobs, getJob, listJobs, updateJobStatus, isWorktreeInUse, setJobDependencies, getJobDependencies, getDependentJobs, checkCircularDependency, addJobLog, getJobLogs, sanitizeResultSummaryValue, touchJobUpdatedAt, resumeJob } from '../models/job.js';
import { removeWorktree } from '../../worker/worktree.js';
import { orchestratorEvents } from '../events.js';
import { getDb } from '../db.js';

const jobStatusEnum = z.enum(['pending', 'running', 'awaiting_input', 'done', 'failed', 'cancelled']);

const specJsonSchema: z.ZodType<SpecJson> = z.object({
  goal: z.string().min(1),
  context_files: z.array(z.string()),
  notes: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
});

// status is controlled by the orchestrator and always starts at 'pending'
const createJobSchema = z.object({
  repo_url: z.string().min(1),
  base_ref: z.string().min(1),
  branch_name: z.string().min(1),
  worktree_path: z.string(), // Allow empty string for no-worktree mode
  worker_type: z.string().min(1),
  spec_json: specJsonSchema,
  result_summary: z.unknown().optional(),
  conversation_id: z.string().nullable().optional(),
  feature_id: z.string().min(1).optional(),
  feature_part: z.string().min(1).optional(),
  push_mode: z.enum(['always', 'never']).optional(),
  use_worktree: z.boolean().optional(),
  depends_on: z.array(z.string().uuid()).optional(),
}).refine((data) => {
  if (data.use_worktree !== false) {
    return data.worktree_path.length > 0;
  }
  return true;
}, {
  message: 'worktree_path must be non-empty when use_worktree=true',
  path: ['worktree_path'],
});;

const listJobsQuerySchema = z.object({
  status: jobStatusEnum.optional(),
  worker_type: z.string().min(1).optional(),
  feature_id: z.string().min(1).optional(),
});

const claimJobQuerySchema = z.object({
  worker_type: z.string().min(1),
});

const completeJobSchema = z.object({
  status: z.enum(['done', 'failed', 'awaiting_input']),
  result_summary: z.unknown().optional(),
  conversation_id: z.string().nullable().optional(),
});

const appendLogSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
});

const cleanupJobsSchema = z.object({
  statuses: z.array(jobStatusEnum).optional(),
  maxAgeDays: z.number().int().nonnegative().optional(),
});

type LogEntry = { stream: 'stdout' | 'stderr'; text: string; timestamp?: string };

const toFilterValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
};

const extractLogsFromSummary = (value: unknown): LogEntry[] => {
  if (!value) return [];

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const maybeLogs = (parsed as Record<string, unknown>).logs;
  if (!Array.isArray(maybeLogs)) return [];

  const logs: LogEntry[] = [];
  for (const entry of maybeLogs) {
    if (!entry || typeof entry !== 'object') continue;
    const stream = (entry as Record<string, unknown>).stream === 'stderr' ? 'stderr' : 'stdout';
    const text = typeof (entry as Record<string, unknown>).text === 'string' ? (entry as Record<string, unknown>).text as string : '';
    if (text) {
      const timestamp = typeof (entry as Record<string, unknown>).timestamp === 'string'
        ? (entry as Record<string, unknown>).timestamp as string
        : undefined;
      logs.push({ stream, text, timestamp });
    }
  }
  return logs;
};

const stripLogsFromJob = (job: any): any => {
  const jobWithoutLogs = { ...job };
  if (jobWithoutLogs.result_summary) {
    const sanitized = sanitizeResultSummaryValue(jobWithoutLogs.result_summary);
    if (sanitized === undefined || sanitized === null) {
      jobWithoutLogs.result_summary = null;
    } else if (typeof sanitized === 'string') {
      jobWithoutLogs.result_summary = sanitized;
    } else {
      jobWithoutLogs.result_summary = JSON.stringify(sanitized);
    }
  }
  return jobWithoutLogs;
};

const serializeJsonText = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
};

const router = Router();

router.post('/', (req, res, next) => {
  try {
    const payload = createJobSchema.parse(req.body);
    const trimmedWorktreePath = payload.worktree_path?.trim();

    // Validate and auto-configure no-worktree mode
    if (payload.use_worktree === false) {
      // Force push_mode to 'never' for no-worktree mode
      payload.push_mode = 'never';

      // In no-worktree mode, repo_url is used as the working directory
      // Validate that repo_url is an absolute path
      if (!path.isAbsolute(payload.repo_url)) {
        return res.status(400).json({
          error: 'repo_url must be an absolute path when use_worktree=false',
        });
      }

      if (trimmedWorktreePath && trimmedWorktreePath !== '' && !path.isAbsolute(trimmedWorktreePath)) {
        return res.status(400).json({
          error: 'worktree_path must be absolute when use_worktree=false',
        });
      }

      // worktree_path must remain empty for no-worktree mode (working directory is in repo_url)
      if (trimmedWorktreePath && trimmedWorktreePath !== '') {
        return res.status(400).json({
          error: 'worktree_path must be empty when use_worktree=false',
        });
      }
    }

    // Validate dependencies exist and are not failed/cancelled
    if (payload.depends_on && payload.depends_on.length > 0) {
      for (const depId of payload.depends_on) {
        const depJob = getJob(depId);
        if (!depJob) {
          return res.status(400).json({ error: `Dependency job ${depId} not found` });
        }
        if (depJob.status === 'failed' || depJob.status === 'cancelled') {
          return res.status(400).json({ error: `Dependency job ${depId} is ${depJob.status} and cannot be depended on` });
        }
      }
    }

    const resultSummary = serializeJsonText(payload.result_summary);

    // Use transaction to create job and set dependencies atomically
    const db = getDb();
    const job = db.transaction(() => {
      const newJob = createJob({
        repo_url: payload.repo_url,
        base_ref: payload.base_ref,
        branch_name: payload.branch_name,
        worktree_path: payload.worktree_path,
        worker_type: payload.worker_type,
        status: 'pending' as JobStatus,
        spec_json: payload.spec_json,
        result_summary: resultSummary,
        conversation_id: payload.conversation_id ?? null,
        feature_id: payload.feature_id ?? null,
        feature_part: payload.feature_part ?? null,
        push_mode: payload.push_mode ?? 'always',
        use_worktree: payload.use_worktree,
      });

      // Check for circular dependencies before setting
      if (payload.depends_on && payload.depends_on.length > 0) {
        const hasCycle = checkCircularDependency(newJob.id, payload.depends_on);
        if (hasCycle) {
          throw new Error('Circular dependency detected');
        }
        setJobDependencies(newJob.id, payload.depends_on);
        // Include depends_on in the returned job
        newJob.depends_on = payload.depends_on;
      }

      return newJob;
    })();

    orchestratorEvents.emit({ type: 'job_created', data: stripLogsFromJob(job) });
    res.status(201).json(stripLogsFromJob(job));
  } catch (error) {
    if (error instanceof Error && error.message === 'Circular dependency detected') {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

router.get('/', (req, res, next) => {
  try {
    const validatedQuery = listJobsQuerySchema.parse({
      status: toFilterValue(req.query.status),
      worker_type: toFilterValue(req.query.worker_type),
      feature_id: toFilterValue(req.query.feature_id),
    });
    const filter: Parameters<typeof listJobs>[0] = {};
    if (validatedQuery.status) filter.status = validatedQuery.status as JobStatus;
    if (validatedQuery.worker_type) filter.worker_type = validatedQuery.worker_type;
    if (validatedQuery.feature_id) filter.feature_id = validatedQuery.feature_id;
    const jobs = listJobs(filter);
    const jobsWithoutLogs = jobs.map(stripLogsFromJob);
    res.json(jobsWithoutLogs);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const job = getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(stripLogsFromJob(job));
  } catch (error) {
    next(error);
  }
});

router.get('/:id/dependencies', (req, res, next) => {
  try {
    const jobId = req.params.id;
    const job = getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const dependsOn = getJobDependencies(jobId);
    const dependedBy = getDependentJobs(jobId);

    res.json({
      depends_on: dependsOn,
      depended_by: dependedBy,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/logs', (req, res, next) => {
  try {
    const job = getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const dbLogs = getJobLogs(job.id).map((log) => ({
      stream: log.stream,
      text: log.text,
      timestamp: log.created_at,
    }));

    const legacyLogs = extractLogsFromSummary(job.result_summary);

    const merged: Array<{ stream: 'stdout' | 'stderr'; text: string; timestamp?: string }> = [];
    const seen = new Set<string>();
    let seq = 0;

    for (const log of [...dbLogs, ...legacyLogs]) {
      const key = log.timestamp
        ? `${log.stream}:${log.text}:${log.timestamp}`
        : `${log.stream}:${log.text}:seq:${seq++}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(log);
    }

    // Sort by timestamp when available to produce stable order
    merged.sort((a, b) => {
      if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp);
      if (a.timestamp) return -1;
      if (b.timestamp) return 1;
      return 0;
    });

    return res.json(merged);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const job = deleteJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    // Only remove worktrees that the worker created.
    // Safety guard: require use_worktree=true and a non-empty worktree_path to avoid deleting user directories from legacy no-worktree jobs.
    const usedWorktreeMode = job.use_worktree !== false;
    const hasWorktreePath = job.worktree_path && job.worktree_path.trim() !== '';
    if (usedWorktreeMode && hasWorktreePath) {
      const worktreeStillInUse = isWorktreeInUse(job.worktree_path, [job.id]);
      if (!worktreeStillInUse) {
        try {
          await removeWorktree(job.worktree_path);
        } catch (error) {
          console.warn(`Failed to remove worktree ${job.worktree_path}:`, error);
        }
      } else {
        console.log(`Worktree ${job.worktree_path} still in use by other jobs, skipping removal`);
      }
    }
    orchestratorEvents.emit({ type: 'job_deleted', data: { id: job.id } });
    res.status(200).json(stripLogsFromJob(job));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot delete job')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

router.post('/claim', (req, res, next) => {
  try {
    const { worker_type } = claimJobQuerySchema.parse(req.query);
    const job = claimJob(worker_type);

    if (!job) {
      return res.status(404).json({ error: 'No pending jobs available for this worker type' });
    }

    orchestratorEvents.emit({ type: 'job_updated', data: stripLogsFromJob(job) });
    res.status(200).json(stripLogsFromJob(job));
  } catch (error) {
    next(error);
  }
});

router.post('/cleanup', async (req, res, next) => {
  try {
    const payload = cleanupJobsSchema.parse(req.body ?? {});
    const result = deleteJobs(payload);
    const deletedJobIds = result.deleted.map((job) => job.id);
    // Only delete worker-managed worktrees: require use_worktree=true and a non-empty worktree_path to avoid removing user directories or legacy no-worktree jobs.
    const worktreePaths = [...new Set(result.deleted
      .filter((job) => {
        const usedWorktreeMode = job.use_worktree !== false;
        const hasWorktreePath = job.worktree_path && job.worktree_path.trim() !== '';
        return usedWorktreeMode && hasWorktreePath;
      })
      .map((job) => job.worktree_path))];
    for (const worktreePath of worktreePaths) {
      // Only remove worktree if no other jobs (outside of deleted set) reference it
      const worktreeStillInUse = isWorktreeInUse(worktreePath, deletedJobIds);
      if (!worktreeStillInUse) {
        try {
          await removeWorktree(worktreePath);
        } catch (error) {
          console.warn(`Failed to remove worktree ${worktreePath}:`, error);
        }
      } else {
        console.log(`Worktree ${worktreePath} still in use by other jobs, skipping removal`);
      }
    }
    res.status(200).json({ deleted: result.count, jobs: result.deleted });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/logs', (req, res, next) => {
  try {
    const { id } = req.params;
    const body = appendLogSchema.parse(req.body);

    const job = getJob(id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Append log and touch updated_at
    addJobLog(id, body.stream, body.text);
    try {
      touchJobUpdatedAt(id);
    } catch (error) {
      console.warn(`Failed to update job timestamp for ${id}:`, error);
    }

    // Emit SSE event
    orchestratorEvents.emit({
      type: 'log_appended',
      data: { jobId: id, stream: body.stream, text: body.text },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/complete', (req, res, next) => {
  try {
    const { id } = req.params;
    const body = completeJobSchema.parse(req.body);
    const hasConversationId = Object.hasOwn(body, 'conversation_id');

    // Backfill legacy embedded logs into job_logs (once) before stripping them from result_summary
    const existingJob = getJob(id);
    if (!existingJob) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const existingDbLogs = getJobLogs(id);
    const logsToPersist: LogEntry[] = [];

    // Migrate any embedded legacy logs (dedupe later against DB)
    if (existingJob.result_summary) {
      logsToPersist.push(...extractLogsFromSummary(existingJob.result_summary));
    }

    // Always persist logs provided in the completion payload (workers that only send final logs)
    if (body.result_summary) {
      logsToPersist.push(...extractLogsFromSummary(body.result_summary));
    }

    // Sanitize summary (remove logs) before update
    const finalSummary = body.result_summary === undefined ? undefined : sanitizeResultSummaryValue(body.result_summary);

    updateJobStatus(
      id,
      body.status,
      finalSummary,
      ['running', 'awaiting_input'],
      hasConversationId ? body.conversation_id ?? null : undefined
    );

    if (logsToPersist.length) {
      const makeKey = (log: { stream: 'stdout' | 'stderr'; text: string; timestamp?: string }, seq?: number): string => {
        if (log.timestamp) return `${log.stream}:${log.text}:${log.timestamp}`;
        if (seq !== undefined) return `${log.stream}:${log.text}:seq:${seq}`;
        return `${log.stream}:${log.text}`;
      };

      const seen = new Set<string>();
      // Seed with existing DB logs (prevents double-write when completion repeats streamed logs)
      for (const existingLog of existingDbLogs) {
        seen.add(makeKey({ stream: existingLog.stream, text: existingLog.text, timestamp: existingLog.created_at }));
        seen.add(makeKey({ stream: existingLog.stream, text: existingLog.text })); // fallback for logs without timestamp
      }

      let seq = 0;
      for (const log of logsToPersist) {
        const key = makeKey(log, seq);
        if (seen.has(key)) {
          seq += 1;
          continue;
        }
        seen.add(key);
        addJobLog(id, log.stream, log.text, log.timestamp);
        seq += 1;
      }
    }

    const job = getJob(id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    orchestratorEvents.emit({ type: 'job_updated', data: stripLogsFromJob(job) });
    res.status(200).json(stripLogsFromJob(job));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/resume', (req, res, next) => {
  try {
    const { id } = req.params;
    const job = getJob(id);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if job is resumable (failed + timed_out + has conversation_id)
    let summary: { codex?: { timed_out?: boolean } } = {};
    if (job.result_summary) {
      try {
        summary = JSON.parse(job.result_summary);
      } catch {
        // ignore parse error
      }
    }

    if (job.status !== 'failed') {
      return res.status(400).json({ error: `Job is not in failed status (current: ${job.status})` });
    }

    if (!summary?.codex?.timed_out) {
      return res.status(400).json({ error: 'Job did not time out' });
    }

    if (!job.conversation_id) {
      return res.status(400).json({ error: 'Job has no conversation_id to resume' });
    }

    // Set job back to pending with resume_requested flag
    resumeJob(id);

    const updatedJob = getJob(id);
    if (!updatedJob) {
      return res.status(404).json({ error: 'Job not found after resume' });
    }

    orchestratorEvents.emit({ type: 'job_updated', data: stripLogsFromJob(updatedJob) });
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
