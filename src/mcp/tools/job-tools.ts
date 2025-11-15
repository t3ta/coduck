import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { OrchestratorClient, type CleanupJobsOptions, type ListJobsFilter } from '../orchestrator-client.js';
import type { Job, JobStatus } from '../../shared/types.js';
import {
  callCodex,
  collectTextContent,
  codexResultIndicatesError,
  extractCodexStatus,
  extractConversationId,
  extractLatestSessionId,
} from '../../shared/codex-mcp.js';
import { removeWorktree } from '../../worker/worktree.js';

const JOB_STATUSES = ['pending', 'running', 'awaiting_input', 'done', 'failed', 'cancelled'] as const;
type _JobStatusCoverageCheck = Exclude<JobStatus, (typeof JOB_STATUSES)[number]> extends never ? true : never;
const PROTECTED_STATUSES = new Set<JobStatus>(['running', 'awaiting_input']);

const enqueueCodexJobSchema = z.object({
  goal: z.string().min(1, 'A goal is required for every job.'),
  context_files: z.array(z.string().min(1, 'Context file paths cannot be empty.')).min(1, 'Provide at least one context file.'),
  notes: z.string().min(1).optional(),
  base_ref: z.string().min(1).default('origin/main'),
  feature_id: z.string().min(1, 'Feature ID cannot be empty.').optional(),
  feature_part: z.string().min(1, 'Feature part cannot be empty.').optional(),
});

const listJobsSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  worker_type: z.string().min(1).optional(),
  feature_id: z.string().min(1).optional(),
});

const getJobSchema = z.object({
  id: z.string().min(1, 'Job ID is required.'),
});

const deleteJobSchema = z.object({
  id: z.string().min(1, 'Job ID is required.'),
});

const cleanupJobsSchema = z.object({
  statuses: z.array(z.enum(JOB_STATUSES)).min(1).optional(),
  maxAgeDays: z.number().int().nonnegative().optional(),
});

const continueCodexJobSchema = z.object({
  id: z.string().min(1, 'Job ID is required.'),
  prompt: z.string().min(1, 'Provide a follow-up prompt.'),
});

const createTextResult = (text: string, structuredContent?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const parseResultSummary = (value: string | null): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { previous_summary: value };
  }
  return { previous_summary: value };
};

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
    `Conversation: ${job.conversation_id ?? 'n/a'}`,
    `Result: ${job.result_summary ?? 'n/a'}`,
    ...specDetails,
    `Created: ${job.created_at}`,
    `Updated: ${job.updated_at}`,
  ].join('\n');
};

const summarizeListFilters = (filter?: ListJobsFilter): string => {
  if (!filter || (!filter.status && !filter.worker_type && !filter.feature_id)) {
    return 'none';
  }
  const parts: string[] = [];
  if (filter.status) {
    parts.push(`status=${filter.status}`);
  }
  if (filter.worker_type) {
    parts.push(`worker_type=${filter.worker_type}`);
  }
  if (filter.feature_id) {
    parts.push(`feature_id=${filter.feature_id}`);
  }
  return parts.join(', ');
};

const normalizeListFilter = (input: z.infer<typeof listJobsSchema>): ListJobsFilter | undefined => {
  const filter: ListJobsFilter = {
    status: input.status,
    worker_type: input.worker_type?.trim() || undefined,
    feature_id: input.feature_id?.trim() || undefined,
  };

  if (!filter.status && !filter.worker_type && !filter.feature_id) {
    return undefined;
  }

  return filter;
};

const sanitizeCleanupOptions = (options: z.infer<typeof cleanupJobsSchema>): CleanupJobsOptions => {
  const sanitized: CleanupJobsOptions = {};

  if (options.statuses?.length) {
    const allowed = options.statuses.filter((status) => !PROTECTED_STATUSES.has(status));
    sanitized.statuses = allowed;
  }

  if (typeof options.maxAgeDays === 'number') {
    sanitized.maxAgeDays = options.maxAgeDays;
  }

  return sanitized;
};

const buildConversationHistory = (job: Job): string => {
  const summary = parseResultSummary(job.result_summary);
  const continuations = Array.isArray(summary.continuations)
    ? (summary.continuations as Array<{ prompt: string; response: string }>)
    : [];

  if (continuations.length === 0) {
    return '(No previous conversation)';
  }

  return continuations
    .map(({ prompt, response }) => `User: ${prompt}\n\nAssistant: ${response}`)
    .join('\n\n---\n\n');
};

export const registerJobTools = (server: McpServer, orchestratorClient = new OrchestratorClient()): void => {
  server.registerTool('enqueue_codex_job', {
    title: 'Enqueue Codex Job',
    description: 'Enqueue a new Codex worker job via the orchestrator (optionally tagging it with feature metadata).',
    inputSchema: enqueueCodexJobSchema,
  }, async (args) => {
    const job = await orchestratorClient.enqueueCodexJob({
      goal: args.goal.trim(),
      context_files: args.context_files.map((file) => file.trim()),
      notes: args.notes?.trim() || undefined,
      base_ref: args.base_ref?.trim() || undefined,
      feature_id: args.feature_id?.trim() || undefined,
      feature_part: args.feature_part?.trim() || undefined,
    });

    const summary = `Enqueued Codex job ${job.id}\n\n${formatJob(job)}`;
    return createTextResult(summary, { job });
  });

  server.registerTool('list_jobs', {
    title: 'List Jobs',
    description: 'List orchestrator jobs with optional status/worker/feature filters.',
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

  server.registerTool('delete_job', {
    title: 'Delete Job',
    description: 'Delete a single job by ID. Cannot delete jobs that are running or awaiting input.',
    inputSchema: deleteJobSchema,
  }, async (args) => {
    const jobId = args.id.trim();
    const targetJob = await orchestratorClient.getJob(jobId);
    if (PROTECTED_STATUSES.has(targetJob.status)) {
      throw new Error(`Job ${jobId} is ${targetJob.status} and cannot be deleted.`);
    }

    const job = await orchestratorClient.deleteJob(jobId);
    try {
      await removeWorktree(job.worktree_path);
    } catch (error) {
      console.warn(`Failed to remove worktree ${job.worktree_path}:`, error);
    }
    const summary = `Deleted job ${job.id}\n\n${formatJob(job)}`;
    return createTextResult(summary, { job });
  });

  server.registerTool('cleanup_jobs', {
    title: 'Cleanup Jobs',
    description: 'Delete multiple jobs based on status and age filters. Protected statuses (running, awaiting_input) are automatically excluded.',
    inputSchema: cleanupJobsSchema,
  }, async (args) => {
    const sanitizedOptions = sanitizeCleanupOptions(args);
    const excludedStatuses = args.statuses?.filter((status) => PROTECTED_STATUSES.has(status)) ?? [];

    const result = await orchestratorClient.cleanupJobs(sanitizedOptions);
    const jobList = result.jobs.length ? result.jobs.map((job) => formatJob(job)).join('\n\n') : 'No jobs deleted.';
    const worktreePaths = [...new Set(result.jobs.map((job) => job.worktree_path))];
    for (const worktreePath of worktreePaths) {
      try {
        await removeWorktree(worktreePath);
      } catch (error) {
        console.warn(`Failed to remove worktree ${worktreePath}:`, error);
      }
    }

    const parts = [`Deleted ${result.deleted} job(s).`];
    if (excludedStatuses.length) {
      parts.push(`Excluded protected statuses: ${excludedStatuses.join(', ')}`);
    }
    parts.push('', jobList);

    return createTextResult(parts.join('\n\n'), { deleted: result.deleted, jobs: result.jobs });
  });

  server.registerTool('continue_codex_job', {
    title: 'Continue Codex Job',
    description: 'Respond to Codex when a job is awaiting additional user input.',
    inputSchema: continueCodexJobSchema,
  }, async (args) => {
    const jobId = args.id.trim();
    const prompt = args.prompt.trim();
    const job = await orchestratorClient.getJob(jobId);

    if (job.status !== 'awaiting_input') {
      throw new Error(`Job ${jobId} is not awaiting input (current status: ${job.status}).`);
    }

    // Build conversation history from previous continuations
    const conversationHistory = buildConversationHistory(job);

    // Create full prompt with context
    const fullPrompt = [
      '# Original Goal',
      job.spec_json.goal,
      '',
      '# Context Files',
      job.spec_json.context_files.map((file) => `- ${file}`).join('\n'),
      '',
      job.spec_json.notes ? `# Notes\n${job.spec_json.notes}\n` : '',
      '# Previous Conversation',
      conversationHistory,
      '',
      '# New Request',
      prompt,
    ].filter(line => line !== '').join('\n');

    // Execute with callCodex (new session with conversation history in prompt)
    const beforeTimestamp = Math.floor(Date.now() / 1000);
    const codexResult = await callCodex({
      prompt: fullPrompt,
      worktreePath: job.worktree_path,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });

    const responseText = collectTextContent(codexResult);
    const followUpError = codexResultIndicatesError(codexResult);
    const codexStatus = extractCodexStatus(codexResult);

    // Extract new conversationId from session files
    let nextConversationId: string | null | undefined = extractConversationId(codexResult);
    if (!nextConversationId) {
      nextConversationId = extractLatestSessionId(beforeTimestamp) ?? job.conversation_id;
    }

    const summaryObject = parseResultSummary(job.result_summary);
    const timestamp = new Date().toISOString();
    const continuations = Array.isArray(summaryObject.continuations)
      ? (summaryObject.continuations as Array<Record<string, unknown>>)
      : [];
    continuations.push({ at: timestamp, prompt, response: responseText });
    summaryObject.continuations = continuations;
    summaryObject.last_continuation = { at: timestamp, prompt };

    let newStatus: JobStatus;
    if (followUpError) {
      newStatus = 'failed';
      summaryObject.error = followUpError;
    } else if (codexStatus === 'awaiting_input') {
      newStatus = 'awaiting_input';
    } else {
      newStatus = 'done';
      summaryObject.message = 'Codex conversation continued successfully (via new session with conversation history).';
    }

    const updatedJob = await orchestratorClient.updateJobStatus(jobId, newStatus, {
      result_summary: summaryObject,
      conversation_id: nextConversationId,
    });

    const textSummary = [
      `Continued Codex job ${jobId}`,
      `Prompt:\n${prompt}`,
      responseText ? `Response:\n${responseText}` : 'Response: (no text output)',
      `New conversationId: ${nextConversationId ?? 'n/a'}`,
      `New status: ${newStatus}`,
    ].join('\n\n');

    return createTextResult(textSummary, { job: updatedJob, codexResult });
  });
};
