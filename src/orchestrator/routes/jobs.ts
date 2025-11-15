import { Router } from 'express';
import { z } from 'zod';

import type { JobStatus, SpecJson } from '../../shared/types.js';
import { claimJob, createJob, deleteJob, deleteJobs, getJob, listJobs, updateJobStatus } from '../models/job.js';

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
});

const listJobsQuerySchema = z.object({
  status: jobStatusEnum.optional(),
  worker_type: z.string().min(1).optional(),
});

const claimJobQuerySchema = z.object({
  worker_type: z.string().min(1),
});

const completeJobSchema = z.object({
  status: z.enum(['done', 'failed', 'awaiting_input']),
  result_summary: z.unknown().optional(),
  conversation_id: z.string().nullable().optional(),
});

const cleanupJobsSchema = z.object({
  statuses: z.array(jobStatusEnum).min(1).optional(),
  maxAgeDays: z.number().int().nonnegative().optional(),
});

const toFilterValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
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
    });
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

router.get('/', (req, res, next) => {
  try {
    const filters = listJobsQuerySchema.parse({
      status: toFilterValue(req.query.status),
      worker_type: toFilterValue(req.query.worker_type),
    });
    const jobs = listJobs(filters);
    res.json(jobs);
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
    res.json(job);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const job = deleteJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.status(200).json(job);
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

    res.status(200).json(job);
  } catch (error) {
    next(error);
  }
});

router.post('/cleanup', (req, res, next) => {
  try {
    const payload = cleanupJobsSchema.parse(req.body ?? {});
    const result = deleteJobs(payload);
    res.status(200).json({ deleted: result.count, jobs: result.deleted });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/complete', (req, res, next) => {
  try {
    const { id } = req.params;
    const body = completeJobSchema.parse(req.body);
    const hasConversationId = Object.hasOwn(body, 'conversation_id');
    updateJobStatus(
      id,
      body.status,
      body.result_summary,
      ['running', 'awaiting_input'],
      hasConversationId ? body.conversation_id ?? null : undefined
    );

    const job = getJob(id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.status(200).json(job);
  } catch (error) {
    next(error);
  }
});

export default router;
