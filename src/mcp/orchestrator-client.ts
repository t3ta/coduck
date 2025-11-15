import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { appConfig } from '../shared/config.js';
import type { Job, JobStatus, SpecJson } from '../shared/types.js';

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
}

export interface ListJobsFilter {
  status?: JobStatus;
  worker_type?: string;
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
    const metadata = this.generateJobMetadata(args.goal);
    const specPayload: SpecJson = {
      goal: args.goal,
      context_files: args.context_files,
      ...(args.notes ? { notes: args.notes } : {}),
    };

    const body = {
      repo_url: metadata.repoUrl,
      base_ref: baseRef,
      branch_name: metadata.branchName,
      worktree_path: metadata.worktreePath,
      worker_type: WORKER_TYPE_CODEX,
      spec_json: specPayload,
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
    } : undefined);
    return this.request<Job[]>('/jobs', undefined, query ?? undefined);
  }

  async getJob(id: string): Promise<Job> {
    if (!id.trim()) {
      throw new Error('Job ID is required');
    }
    return this.request<Job>(`/jobs/${encodeURIComponent(id)}`);
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
}
