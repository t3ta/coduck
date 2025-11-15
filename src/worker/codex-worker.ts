import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import type { Job } from '../shared/types.js';
import { appConfig } from '../shared/config.js';
import { createWorktree, WorktreeContext } from './worktree.js';
import { executeCodex } from './executor.js';

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

type JobCompletionStatus = 'done' | 'failed';

type ResultSummary = Record<string, unknown>;

export class CodexWorker {
  private readonly baseUrl: string;
  private readonly pollInterval: number;
  private readonly worktreeBaseDir: string;
  private readonly repoCacheDir: string;
  private shouldStop = false;

  constructor() {
    this.baseUrl = appConfig.orchestratorUrl.replace(/\/+$/, '');
    this.pollInterval = appConfig.workerPollIntervalMs;
    this.worktreeBaseDir = path.resolve(appConfig.worktreeBaseDir);
    this.repoCacheDir = path.join(this.worktreeBaseDir, '_repos');
  }

  public stop(): void {
    this.shouldStop = true;
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.worktreeBaseDir, { recursive: true });
    await fs.mkdir(this.repoCacheDir, { recursive: true });

    console.log(
      `Codex worker started. Connecting to ${this.baseUrl} every ${this.pollInterval}ms as ${WORKER_TYPE}`
    );

    while (!this.shouldStop) {
      let claimedJob = false;
      try {
        claimedJob = await this.pollOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Worker cycle error: ${message}`);
        await wait(this.pollInterval);
        continue;
      }

      if (!claimedJob) {
        await wait(this.pollInterval);
      }
    }

    console.log('Codex worker stopped.');
  }

  private async pollOnce(): Promise<boolean> {
    const job = await this.claimJob();
    if (!job) {
      return false;
    }

    await this.handleJob(job);
    return true;
  }

  private async claimJob(): Promise<Job | null> {
    const url = new URL(`/jobs/claim?worker_type=${WORKER_TYPE}`, `${this.baseUrl}/`);
    const response = await fetch(url, { method: 'POST' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to claim job: ${response.status} ${body}`);
    }

    const job = (await response.json()) as Job;
    console.log(`Claimed job ${job.id} (${job.branch_name})`);
    return job;
  }

  private async completeJob(jobId: string, status: JobCompletionStatus, summary: ResultSummary): Promise<void> {
    const url = new URL(`/jobs/${jobId}/complete`, `${this.baseUrl}/`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status, result_summary: summary }),
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

    try {
      const repoPath = await this.ensureRepoPath(job.repo_url);
      const worktreePath = await this.resolveWorktreePath(job.worktree_path);
      summary.worktree_path = worktreePath;

      worktreeContext = await createWorktree(repoPath, job.base_ref, job.branch_name, worktreePath);

      const execution = await executeCodex(worktreeContext.path, job.spec_json);
      if (!execution.success) {
        throw new Error(execution.error ?? 'Codex CLI reported failure');
      }
      summary.codex = { success: execution.success };

      const commitHash = await this.commitChanges(worktreeContext.path, job.id);
      summary.commit_hash = commitHash ?? null;

      if (commitHash) {
        await this.pushBranch(worktreeContext.path, job.branch_name);
        summary.pushed = true;
      } else {
        summary.pushed = false;
        console.log(`Job ${job.id}: No changes detected, skipping push.`);
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
      console.error(`Job ${job.id} failed: ${message}`);
    }

    try {
      if (success) {
        await this.completeJob(job.id, 'done', summary);
        if (worktreeContext) {
          await worktreeContext.cleanup();
        }
        console.log(`Job ${job.id} completed.`);
      } else {
        await this.completeJob(job.id, 'failed', summary);
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
    await fs.mkdir(this.repoCacheDir, { recursive: true });

    const repoExists = await pathExists(path.join(repoPath, '.git'));
    if (repoExists) {
      return repoPath;
    }

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
