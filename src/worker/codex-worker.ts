import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import type { Job } from '../shared/types.js';
import { appConfig } from '../shared/config.js';
import { createWorktree, WorktreeContext } from './worktree.js';
import { executeCodex, continueCodex } from './executor.js';

const execFilePromise = promisify(execFile);

const execFileAsync = (
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> => {
  return execFilePromise(command, args, {
    ...options,
    encoding: 'utf8',
  }) as Promise<{ stdout: string; stderr: string }>;
};

const WORKER_TYPE = 'codex';
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

type CommandResult = { stdout: string; stderr: string };

type JobCompletionStatus = 'done' | 'failed' | 'awaiting_input';

type ResultSummary = Record<string, unknown>;

type CodexWorkerDependencies = {
  /**
   * Dependency injection hook for tests to supply a fake fetch implementation.
   */
  fetchImpl?: typeof fetch;
  /**
   * Dependency injection hook for tests to bypass real git operations.
   */
  createWorktree?: typeof createWorktree;
  /**
   * Dependency injection hook for tests to stub Codex execution behaviour.
   */
  executeCodex?: typeof executeCodex;
};

export class CodexWorker {
  private readonly baseUrl: string;
  private readonly pollInterval: number;
  private readonly concurrency: number;
  private readonly worktreeBaseDir: string;
  private readonly repoCacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createWorktreeImpl: typeof createWorktree;
  private readonly executeCodexImpl: typeof executeCodex;
  private readonly cloneLocks = new Map<string, Promise<string>>();
  private shouldStop = false;

  constructor(deps: CodexWorkerDependencies = {}) {
    this.baseUrl = appConfig.orchestratorUrl.replace(/\/+$/, '');
    this.pollInterval = appConfig.workerPollIntervalMs;
    this.concurrency = appConfig.workerConcurrency;
    this.worktreeBaseDir = path.resolve(appConfig.worktreeBaseDir);
    this.repoCacheDir = path.join(this.worktreeBaseDir, '_repos');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.createWorktreeImpl = deps.createWorktree ?? createWorktree;
    this.executeCodexImpl = deps.executeCodex ?? executeCodex;
  }

  public stop(): void {
    this.shouldStop = true;
  }

  public async start(): Promise<void> {
    console.log(`Starting Codex Worker with concurrency: ${this.concurrency}`);
    console.log(`Orchestrator URL: ${this.baseUrl}`);
    console.log(`Worktree base dir: ${this.worktreeBaseDir}`);
    console.log(`Poll interval: ${this.pollInterval}ms`);

    await fs.mkdir(this.worktreeBaseDir, { recursive: true });
    await fs.mkdir(this.repoCacheDir, { recursive: true });

    const workers = Array.from({ length: this.concurrency }, (_, i) => this.workerLoop(i));
    await Promise.allSettled(workers);
  }

  private async workerLoop(workerId: number): Promise<void> {
    while (!this.shouldStop) {
      let claimedJob = false;
      try {
        claimedJob = await this.pollOnce(workerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Worker ${workerId}] Worker cycle error: ${message}`);
        await wait(this.pollInterval);
        continue;
      }

      if (!claimedJob) {
        await wait(this.pollInterval);
      }
    }
  }

  private async pollOnce(workerId: number): Promise<boolean> {
    const job = await this.claimJob(workerId);
    if (!job) {
      return false;
    }

    await this.handleJob(job);
    return true;
  }

  private async claimJob(workerId: number): Promise<Job | null> {
    const url = new URL(`/jobs/claim?worker_type=${WORKER_TYPE}`, `${this.baseUrl}/`);
    const response = await this.fetchImpl(url, { method: 'POST' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to claim job: ${response.status} ${body}`);
    }

    const job = (await response.json()) as Job;
    console.log(`[Worker ${workerId}] Claimed job ${job.id} (${job.branch_name})`);
    return job;
  }

  private async completeJob(
    jobId: string,
    status: JobCompletionStatus,
    summary: ResultSummary,
    conversationId?: string | null
  ): Promise<void> {
    const url = new URL(`/jobs/${jobId}/complete`, `${this.baseUrl}/`);
    const body: Record<string, unknown> = { status, result_summary: summary };
    if (conversationId !== undefined) {
      body.conversation_id = conversationId;
    }
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to complete job ${jobId}: ${response.status} ${body}`);
    }
  }

  private async handleJob(job: Job): Promise<void> {
    const summary: ResultSummary = {
      jobId: job.id,
      repo_url: job.repo_url,
      branch: job.branch_name,
      base_ref: job.base_ref,
    };

    let worktreeContext: WorktreeContext | null = null;
    let success = false;
    // sessionId is the Codex session identifier (stored as conversation_id in DB for compatibility)
    let sessionId: string | null = job.conversation_id ?? null;

    try {
      const repoPath = await this.ensureRepoPath(job.repo_url);
      const worktreePath = await this.resolveWorktreePath(job.worktree_path);
      summary.worktree_path = worktreePath;

      worktreeContext = await this.createWorktreeImpl(repoPath, job.base_ref, job.branch_name, worktreePath);

      // Check if this is a resume request (timed-out job being continued)
      let execution;
      if (job.resume_requested && job.conversation_id) {
        console.log(`Job ${job.id}: Resuming timed-out session ${job.conversation_id}`);
        execution = await continueCodex(worktreeContext.path, job.conversation_id, '続きを実行して', job.id);
      } else {
        execution = await this.executeCodexImpl(worktreeContext.path, job.spec_json, job.id);
      }
      if (execution.sessionId) {
        sessionId = execution.sessionId;
      }
      summary.codex = {
        success: execution.success,
        conversation_id: sessionId,
        awaiting_input: execution.awaitingInput ?? false,
        duration_ms: execution.durationMs,
        timed_out: execution.timedOut,
      };
      summary.conversation_id = sessionId;

      if (execution.awaitingInput) {
        summary.message = 'Codex is awaiting additional input before proceeding.';
        await this.completeJob(job.id, 'awaiting_input', summary, sessionId);
        console.log(`Job ${job.id} is awaiting additional input.`);
        return;
      }

      if (!execution.success) {
        throw new Error(execution.error ?? 'Codex execution failed');
      }

      const commitHash = await this.commitChanges(worktreeContext.path, job.id);
      summary.commit_hash = commitHash ?? null;

      if (commitHash && job.push_mode !== 'never') {
        await this.pushBranch(worktreeContext.path, job.branch_name);
        summary.pushed = true;
      } else {
        summary.pushed = false;
        if (!commitHash) {
          console.log(`Job ${job.id}: No changes detected, skipping push.`);
        } else if (job.push_mode === 'never') {
          console.log(`Job ${job.id}: push_mode is 'never', skipping push.`);
        }
      }

      const testsPassed = await this.runTests(worktreeContext.path);
      summary.tests = testsPassed === undefined ? 'skipped' : testsPassed ? 'passed' : 'failed';

      if (testsPassed === false) {
        throw new Error('Tests failed');
      }

      summary.message = 'Codex job completed successfully';
      success = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.error = message;
      summary.conversation_id = sessionId;
      console.error(`Job ${job.id} failed: ${message}`);
    }

    try {
      if (success) {
        // Clean up worktree BEFORE marking job as done to prevent race conditions
        if (worktreeContext && job.push_mode !== 'never') {
          try {
            await worktreeContext.cleanup();
            console.log(`Job ${job.id}: Worktree cleaned up.`);
          } catch (cleanupError) {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            console.warn(`Job ${job.id}: Worktree cleanup failed - ${message}`);
            summary.cleanup_error = message;
          }
        }

        await this.completeJob(job.id, 'done', summary, sessionId);

        if (worktreeContext && job.push_mode === 'never') {
          console.log(`Job ${job.id} completed. Worktree preserved (push_mode='never').`);
        } else {
          console.log(`Job ${job.id} completed.`);
        }
      } else {
        await this.completeJob(job.id, 'failed', summary, sessionId);
        console.log(`Job ${job.id} reported as failed.`);
      }
    } catch (completionError) {
      const message = completionError instanceof Error ? completionError.message : String(completionError);
      console.error(`Job ${job.id}: failed to report completion - ${message}`);
      throw completionError;
    }
  }

  private async ensureRepoPath(repoLocation: string): Promise<string> {
    const resolved = path.resolve(repoLocation);
    const gitDir = path.join(resolved, '.git');
    if (await pathExists(gitDir)) {
      return resolved;
    }

    const repoPath = path.join(this.repoCacheDir, this.sanitizeRepoName(repoLocation));

    const existingLock = this.cloneLocks.get(repoPath);
    if (existingLock) {
      return existingLock;
    }

    const clonePromise = (async () => {
      const repoExists = await pathExists(path.join(repoPath, '.git'));
      if (repoExists) {
        return repoPath;
      }

      return this.performClone(repoLocation, repoPath);
    })();

    this.cloneLocks.set(repoPath, clonePromise);

    try {
      return await clonePromise;
    } finally {
      this.cloneLocks.delete(repoPath);
    }
  }

  private async performClone(repoLocation: string, repoPath: string): Promise<string> {
    await fs.mkdir(this.repoCacheDir, { recursive: true });
    console.log(`Cloning repository ${repoLocation} into ${repoPath}`);
    await this.runCommand('git', ['clone', repoLocation, repoPath], { cwd: this.repoCacheDir });
    return repoPath;
  }

  private sanitizeRepoName(value: string): string {
    const hash = createHash('sha1').update(value).digest('hex').slice(0, 12);
    return value
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-32)
      .concat('-', hash);
  }

  private async resolveWorktreePath(requestedPath: string): Promise<string> {
    const resolved = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.join(this.worktreeBaseDir, requestedPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  private async commitChanges(worktreePath: string, jobId: string): Promise<string | undefined> {
    const status = await this.runGit(['status', '--porcelain'], worktreePath);
    if (!status.stdout.trim()) {
      return undefined;
    }

    await this.runGit(['add', '--all'], worktreePath);
    const commitMessage = `Codex job ${jobId}`;
    await this.runGit(['commit', '-m', commitMessage], worktreePath);
    const { stdout } = await this.runGit(['rev-parse', 'HEAD'], worktreePath);
    return stdout.trim();
  }

  private async pushBranch(worktreePath: string, branchName: string): Promise<void> {
    await this.runGit(['push', '--set-upstream', 'origin', branchName], worktreePath);
  }

  private async runTests(worktreePath: string): Promise<boolean | undefined> {
    const packageJsonPath = path.join(worktreePath, 'package.json');
    if (!(await pathExists(packageJsonPath))) {
      return undefined;
    }

    try {
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(packageJsonContent) as { scripts?: Record<string, string> };
      if (!parsed.scripts?.test || parsed.scripts.test.trim() === '') {
        return undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to read package.json for tests: ${message}`);
      return undefined;
    }

    try {
      await this.runCommand('npm', ['test'], {
        cwd: worktreePath,
        env: {
          ...process.env,
          CI: '1',
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Tests failed: ${message}`);
      return false;
    }
  }

  private async runGit(args: string[], cwd: string): Promise<CommandResult> {
    return this.runCommand('git', args, { cwd });
  }

  private async runCommand(
    command: string,
    args: string[],
    options: ExecFileOptions = {}
  ): Promise<CommandResult> {
    const finalOptions: ExecFileOptions = {
      ...options,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    };

    try {
      const { stdout, stderr } = await execFileAsync(command, args, finalOptions);
      return { stdout, stderr };
    } catch (error) {
      const stderr = toErrorOutput((error as { stderr?: string | Buffer }).stderr);
      const stdout = toErrorOutput((error as { stdout?: string | Buffer }).stdout);
      const messageParts = [`${command} ${args.join(' ')}`];
      if (stderr.trim()) {
        messageParts.push(stderr.trim());
      } else if (stdout.trim()) {
        messageParts.push(stdout.trim());
      } else if (error instanceof Error) {
        messageParts.push(error.message);
      }
      throw new Error(messageParts.join(': '), { cause: error instanceof Error ? error : undefined });
    }
  }
}

const toErrorOutput = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  return '';
};
