import { execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

import { appConfig } from '../shared/config.js';
import type {
  Job,
  JobStatus,
  SpecJson,
  WorktreeCleanupResponse,
  WorktreeDeletionResponse,
  WorktreeInfo,
} from '../shared/types.js';

const WORKER_TYPE_CODEX = 'codex';
const DEFAULT_BASE_REF = 'origin/main';

const detectRepoUrl = (): string => {
  const envRepo = process.env.REPO_URL?.trim();
  if (envRepo) {
    return envRepo;
  }

  try {
    const remote = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    if (remote) {
      return remote;
    }
  } catch {
    // Ignore errors; we'll fall back to the local path.
  }

  return process.cwd();
};

const toQueryParams = (params?: Record<string, string | undefined>): URLSearchParams | undefined => {
  if (!params) return undefined;
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      searchParams.set(key, value);
    }
  });
  return searchParams;
};

const parseJson = (payload: string): unknown => {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
};

const extractErrorMessage = (data: unknown): string | undefined => {
  if (!data) return undefined;
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const maybeError = (data as Record<string, unknown>).error;
    if (typeof maybeError === 'string') {
      return maybeError;
    }
    const maybeMessage = (data as Record<string, unknown>).message;
    if (typeof maybeMessage === 'string') {
      return maybeMessage;
    }
  }
  return undefined;
};

export interface EnqueueCodexJobArgs {
  goal: string;
  context_files: string[];
  notes?: string;
  base_ref?: string;
  branch_name?: string;
  feature_id?: string;
  feature_part?: string;
  push_mode?: 'always' | 'never';
  use_worktree?: boolean;
  depends_on?: string[];
}

export interface ListJobsFilter {
  status?: JobStatus;
  worker_type?: string;
  feature_id?: string;
}

export interface CleanupJobsOptions {
  statuses?: JobStatus[];
  maxAgeDays?: number;
}

export interface OrchestratorClientOptions {
  baseUrl?: string;
  worktreeBaseDir?: string;
  repoUrl?: string;
  fetchImpl?: typeof fetch;
}

interface JobMetadata {
  repoUrl: string;
  branchName: string;
  worktreePath: string;
}

export class OrchestratorClient {
  private readonly baseUrl: string;
  private readonly worktreeBaseDir: string;
  private readonly repoUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OrchestratorClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? appConfig.orchestratorUrl;
    if (!this.baseUrl) {
      throw new Error('ORCHESTRATOR_URL is not configured.');
    }

    this.worktreeBaseDir = path.resolve(options.worktreeBaseDir ?? appConfig.worktreeBaseDir);
    this.repoUrl = options.repoUrl ?? detectRepoUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async enqueueCodexJob(args: EnqueueCodexJobArgs): Promise<Job> {
    const baseRef = args.base_ref?.trim() || DEFAULT_BASE_REF;
    const specPayload: SpecJson = {
      goal: args.goal,
      context_files: args.context_files,
      ...(args.notes ? { notes: args.notes } : {}),
    };

    // No-worktree mode: use current working directory
    let repoUrl: string;
    let worktreePath: string;
    let branchName: string;

    if (args.use_worktree === false) {
      const cwd = process.cwd();
      repoUrl = cwd;
      worktreePath = ''; // Empty string to prevent worktree deletion
      branchName = `no-worktree-${randomUUID().slice(0, 8)}`; // Unique branch name for no-worktree jobs
      console.log(`Using no-worktree mode with working directory: ${cwd}`);
    } else {
      // Determine branch_name: explicit > feature_id > auto-generated
      if (args.branch_name?.trim()) {
        branchName = args.branch_name.trim();
      } else if (args.feature_id?.trim()) {
        // Sanitize feature_id for use as git ref (same logic as generateJobMetadata)
        const sanitizedFeatureId = args.feature_id
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        // Fall back to auto-generated branch if sanitized feature_id is empty
        branchName = sanitizedFeatureId ? `feature/${sanitizedFeatureId}` : this.generateJobMetadata(args.goal).branchName;
      } else {
        branchName = this.generateJobMetadata(args.goal).branchName;
      }

      repoUrl = this.repoUrl;
      worktreePath = this.resolveWorktreePath(branchName);
    }

    const body = {
      repo_url: repoUrl,
      base_ref: baseRef,
      branch_name: branchName,
      worktree_path: worktreePath,
      worker_type: WORKER_TYPE_CODEX,
      spec_json: specPayload,
      feature_id: args.feature_id,
      feature_part: args.feature_part,
      push_mode: args.use_worktree === false ? 'never' : (args.push_mode ?? 'always'),
      use_worktree: args.use_worktree,
      depends_on: args.depends_on,
    };

    return this.request<Job>('/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async listJobs(filter?: ListJobsFilter): Promise<Job[]> {
    const query = toQueryParams(filter ? {
      status: filter.status,
      worker_type: filter.worker_type,
      feature_id: filter.feature_id,
    } : undefined);
    return this.request<Job[]>('/jobs', undefined, query ?? undefined);
  }

  async getJob(id: string): Promise<Job> {
    if (!id.trim()) {
      throw new Error('Job ID is required');
    }
    return this.request<Job>(`/jobs/${encodeURIComponent(id)}`);
  }

  async getJobDependencies(id: string): Promise<{ depends_on: string[]; depended_by: string[] }> {
    if (!id.trim()) {
      throw new Error('Job ID is required');
    }
    return this.request<{ depends_on: string[]; depended_by: string[] }>(`/jobs/${encodeURIComponent(id)}/dependencies`);
  }

  async deleteJob(id: string): Promise<Job> {
    const trimmedId = id.trim();
    if (!trimmedId) {
      throw new Error('Job ID is required');
    }

    return this.request<Job>(`/jobs/${encodeURIComponent(trimmedId)}`, {
      method: 'DELETE',
    });
  }

  async updateJobStatus(
    id: string,
    status: JobStatus,
    options?: { result_summary?: unknown; conversation_id?: string | null }
  ): Promise<Job> {
    const trimmedId = id.trim();
    if (!trimmedId) {
      throw new Error('Job ID is required');
    }

    const body: Record<string, unknown> = { status };
    if (options && Object.hasOwn(options, 'result_summary')) {
      body.result_summary = options.result_summary;
    }
    if (options && Object.hasOwn(options, 'conversation_id')) {
      body.conversation_id = options.conversation_id;
    }

    return this.request<Job>(`/jobs/${encodeURIComponent(trimmedId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async cleanupJobs(options?: CleanupJobsOptions): Promise<{ deleted: number; jobs: Job[] }> {
    const body: Record<string, unknown> = {};

    if (options?.statuses !== undefined) {
      body.statuses = options.statuses;
    }

    if (typeof options?.maxAgeDays === 'number') {
      body.maxAgeDays = options.maxAgeDays;
    }

    return this.request<{ deleted: number; jobs: Job[] }>(`/jobs/cleanup`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}, searchParams?: URLSearchParams): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (searchParams) {
      searchParams.forEach((value, key) => {
        url.searchParams.set(key, value);
      });
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };

    const response = await this.fetchImpl(url, {
      ...init,
      headers,
    });

    const raw = await response.text();
    const data = raw ? parseJson(raw) : null;

    if (!response.ok) {
      const message = extractErrorMessage(data) ?? response.statusText;
      throw new Error(`Orchestrator request failed (${response.status}): ${message}`);
    }

    return (data ?? null) as T;
  }

  private resolveWorktreePath(branchName: string): string {
    // Include repo hash to namespace worktrees by repository
    const repoHash = createHash('sha1').update(this.repoUrl).digest('hex').slice(0, 8);
    // Include branch hash to avoid collisions between branches that differ only in slashes vs dashes
    const branchHash = createHash('sha1').update(branchName).digest('hex').slice(0, 8);
    const sanitizedBranch = branchName.replace(/[\\/]/g, '-').slice(0, 64);
    const worktreeDir = `${repoHash}-${sanitizedBranch}-${branchHash}`;
    return path.resolve(this.worktreeBaseDir, worktreeDir);
  }

  private generateJobMetadata(goal: string): JobMetadata {
    const normalizedGoal = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const slug = normalizedGoal.slice(0, 32);
    const timestamp = Date.now().toString(36);
    const randomSuffix = randomUUID().slice(0, 8);
    const branchName = slug ? `codex/${slug}-${timestamp}-${randomSuffix}` : `codex/task-${timestamp}-${randomSuffix}`;
    const worktreeDir = branchName.replace(/[\\/]/g, '-');
    const worktreePath = path.resolve(this.worktreeBaseDir, worktreeDir);

    return {
      repoUrl: this.repoUrl,
      branchName,
      worktreePath,
    };
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    return this.request<WorktreeInfo[]>('/worktrees');
  }

  async cleanupWorktrees(): Promise<WorktreeCleanupResponse> {
    return this.request<WorktreeCleanupResponse>('/worktrees/cleanup', { method: 'DELETE' });
  }

  async deleteWorktree(worktreePath: string): Promise<WorktreeDeletionResponse> {
    const trimmed = worktreePath.trim();
    if (!trimmed) {
      throw new Error('Worktree path is required.');
    }
    return this.request<WorktreeDeletionResponse>(`/worktrees/${encodeURIComponent(trimmed)}`, { method: 'DELETE' });
  }
}
