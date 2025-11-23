import { Router } from 'express';
import { z } from 'zod';

import type { JobStatus, SpecJson } from '../../shared/types.js';
import { claimJob, createJob, deleteJob, deleteJobs, getJob, listJobs, updateJobStatus, isWorktreeInUse } from '../models/job.js';
import { removeWorktree } from '../../worker/worktree.js';
import { orchestratorEvents } from '../events.js';

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
  worktree_path: z.string().min(1),
  worker_type: z.string().min(1),
  spec_json: specJsonSchema,
  result_summary: z.unknown().optional(),
  conversation_id: z.string().nullable().optional(),
  feature_id: z.string().min(1).optional(),
  feature_part: z.string().min(1).optional(),
  push_mode: z.enum(['always', 'never']).optional(),
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

const toFilterValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
};

const stripLogsFromJob = (job: any): any => {
  const jobWithoutLogs = { ...job };
  if (jobWithoutLogs.result_summary) {
    try {
      const summary = JSON.parse(jobWithoutLogs.result_summary);
      if (summary.logs) {
        delete summary.logs;
        jobWithoutLogs.result_summary = JSON.stringify(summary);
      }
    } catch {
      // Keep original if JSON parsing fails
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
    const resultSummary = serializeJsonText(payload.result_summary);
    const job = createJob({
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
    });
    orchestratorEvents.emit({ type: 'job_created', data: stripLogsFromJob(job) });
    res.status(201).json(stripLogsFromJob(job));
  } catch (error) {
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

router.get('/:id/logs', (req, res, next) => {
  try {
    const job = getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Extract logs from result_summary
    if (!job.result_summary) {
      return res.json([]);
    }

    try {
      const summary = JSON.parse(job.result_summary);
      const logs = summary.logs || [];
      res.json(logs);
    } catch {
      // If result_summary is not valid JSON (e.g., old jobs), return empty array
      return res.json([]);
    }
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
    // Only remove worktree if no other jobs reference it
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
    const worktreePaths = [...new Set(result.deleted.map((job) => job.worktree_path))];
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

    // Append log to result_summary
    let currentSummary: Record<string, unknown> = {};
    if (job.result_summary) {
      try {
        currentSummary = JSON.parse(job.result_summary);
      } catch {
        // If result_summary is not valid JSON (e.g., old jobs), start fresh
        currentSummary = {};
      }
    }
    if (!currentSummary.logs) {
      currentSummary.logs = [];
    }
    (currentSummary.logs as Array<Record<string, unknown>>).push({
      stream: body.stream,
      text: body.text,
      timestamp: new Date().toISOString(),
    });

    // Update job with new logs
    updateJobStatus(id, job.status as JobStatus, currentSummary, [job.status as JobStatus]);

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

    // Preserve logs from the existing result_summary
    const existingJob = getJob(id);
    let finalSummary = body.result_summary;
    if (existingJob?.result_summary) {
      try {
        const existing = JSON.parse(existingJob.result_summary);
        if (existing.logs && Array.isArray(existing.logs)) {
          finalSummary = { ...(body.result_summary || {}), logs: existing.logs };
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    updateJobStatus(
      id,
      body.status,
      finalSummary,
      ['running', 'awaiting_input'],
      hasConversationId ? body.conversation_id ?? null : undefined
    );

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

export default router;
