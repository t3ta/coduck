import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { OrchestratorClient, type ListJobsFilter } from '../orchestrator-client.js';
import type { Job, JobStatus } from '../../shared/types.js';

const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
type _JobStatusCoverageCheck = Exclude<JobStatus, (typeof JOB_STATUSES)[number]> extends never ? true : never;

const enqueueCodexJobSchema = z.object({
  goal: z.string().min(1, 'A goal is required for every job.'),
  context_files: z.array(z.string().min(1, 'Context file paths cannot be empty.')).min(1, 'Provide at least one context file.'),
  notes: z.string().min(1).optional(),
  base_ref: z.string().min(1).default('origin/main'),
});

const listJobsSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  worker_type: z.string().min(1).optional(),
});

const getJobSchema = z.object({
  id: z.string().min(1, 'Job ID is required.'),
});

const createTextResult = (text: string, structuredContent?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const formatJob = (job: Job): string => {
  const specDetails = [`Goal: ${job.spec_json.goal}`, `Context files: ${job.spec_json.context_files.join(', ') || 'n/a'}`];
  if (job.spec_json.notes) {
    specDetails.push(`Notes: ${job.spec_json.notes}`);
  }

  return [
    `ID: ${job.id}`,
    `Status: ${job.status}`,
    `Worker: ${job.worker_type}`,
    `Repo: ${job.repo_url}`,
    `Base ref: ${job.base_ref}`,
    `Branch: ${job.branch_name}`,
    `Worktree: ${job.worktree_path}`,
    `Result: ${job.result_summary ?? 'n/a'}`,
    ...specDetails,
    `Created: ${job.created_at}`,
    `Updated: ${job.updated_at}`,
  ].join('\n');
};

const summarizeListFilters = (filter?: ListJobsFilter): string => {
  if (!filter || (!filter.status && !filter.worker_type)) {
    return 'none';
  }
  const parts: string[] = [];
  if (filter.status) {
    parts.push(`status=${filter.status}`);
  }
  if (filter.worker_type) {
    parts.push(`worker_type=${filter.worker_type}`);
  }
  return parts.join(', ');
};

const normalizeListFilter = (input: z.infer<typeof listJobsSchema>): ListJobsFilter | undefined => {
  const filter: ListJobsFilter = {
    status: input.status,
    worker_type: input.worker_type?.trim() || undefined,
  };

  if (!filter.status && !filter.worker_type) {
    return undefined;
  }

  return filter;
};

export const registerJobTools = (server: McpServer, orchestratorClient = new OrchestratorClient()): void => {
  server.registerTool('enqueue_codex_job', {
    title: 'Enqueue Codex Job',
    description: 'Enqueue a new Codex worker job via the orchestrator.',
    inputSchema: enqueueCodexJobSchema,
  }, async (args) => {
    const job = await orchestratorClient.enqueueCodexJob({
      goal: args.goal.trim(),
      context_files: args.context_files.map((file) => file.trim()),
      notes: args.notes?.trim() || undefined,
      base_ref: args.base_ref?.trim() || undefined,
    });

    const summary = `Enqueued Codex job ${job.id}\n\n${formatJob(job)}`;
    return createTextResult(summary, { job });
  });

  server.registerTool('list_jobs', {
    title: 'List Jobs',
    description: 'List orchestrator jobs with optional status/worker filters.',
    inputSchema: listJobsSchema,
  }, async (args) => {
    const filter = normalizeListFilter(args);
    const jobs = await orchestratorClient.listJobs(filter);

    const header = `Filters: ${summarizeListFilters(filter)}\nFound ${jobs.length} job(s).`;
    const body = jobs.length ? jobs.map((job) => formatJob(job)).join('\n\n') : 'No jobs matched the provided filters.';
    return createTextResult(`${header}\n\n${body}`, { jobs });
  });

  server.registerTool('get_job', {
    title: 'Get Job',
    description: 'Fetch a single job by ID.',
    inputSchema: getJobSchema,
  }, async (args) => {
    const job = await orchestratorClient.getJob(args.id.trim());
    const summary = `Fetched job ${job.id}\n\n${formatJob(job)}`;
    return createTextResult(summary, { job });
  });
};
