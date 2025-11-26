import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

type ExecOptions = ExecFileOptions;

const execGit = (args: string[], options: ExecOptions = {}): Promise<ExecResult> => {
  return execFilePromise('git', args, { ...options, encoding: 'utf8' }) as Promise<ExecResult>;
};

const runGit = async (args: string[], options: ExecOptions = {}): Promise<ExecResult> => {
  try {
    return await execGit(args, options);
  } catch (error) {
    const stderr = toErrorOutput((error as { stderr?: string | Buffer }).stderr);
    const messageParts = [`git ${args.join(' ')} failed`];
    if (stderr.trim()) {
      messageParts.push(stderr.trim());
    } else if (error instanceof Error) {
      messageParts.push(error.message);
    }
    throw new Error(messageParts.join(': '), { cause: error instanceof Error ? error : undefined });
  }
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolveRepoRootFromWorktree = async (worktreePath: string): Promise<string> => {
  const { stdout } = await runGit(['rev-parse', '--git-common-dir'], { cwd: worktreePath });
  const gitCommonDir = stdout.trim();
  const absoluteGitDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(worktreePath, gitCommonDir);
  return path.dirname(absoluteGitDir);
};

export interface WorktreeContext {
  path: string;
  branchName: string;
  cleanup: () => Promise<void>;
}

export interface CreateWorktreeOptions {
  /**
   * When true, reuse an existing worktree without resetting/cleaning it.
   * This is used for resuming timed-out Codex sessions to keep prior changes intact.
   */
  preserveChanges?: boolean;
}

export async function createWorktree(
  repoPath: string,
  baseRef: string,
  branchName: string,
  worktreePath: string,
  options: CreateWorktreeOptions = {}
): Promise<WorktreeContext> {
  const resolvedRepoPath = path.resolve(repoPath);
  const resolvedWorktreePath = path.resolve(worktreePath);
  const preserveChanges = options.preserveChanges ?? false;

  const repoExists = await pathExists(resolvedRepoPath);
  if (!repoExists) {
    throw new Error(`Repository path does not exist: ${resolvedRepoPath}`);
  }

  await fs.mkdir(path.dirname(resolvedWorktreePath), { recursive: true });

  // Check if worktree already exists
  const worktreeExists = await pathExists(resolvedWorktreePath);
  const gitFileExists = worktreeExists && await pathExists(path.join(resolvedWorktreePath, '.git'));

  if (worktreeExists && gitFileExists) {
    // Reuse existing worktree
    console.log(`Reusing existing worktree at ${resolvedWorktreePath}`);

    if (preserveChanges) {
      console.log(`Preserving existing worktree state for resume; skipping reset/clean.`);
    } else {
      // Clean up any uncommitted changes or untracked files from previous jobs
      await runGit(['reset', '--hard'], { cwd: resolvedWorktreePath });
      await runGit(['clean', '-fd'], { cwd: resolvedWorktreePath });
    }

    await runGit(['fetch', '--all'], { cwd: resolvedWorktreePath });
    await runGit(['checkout', branchName], { cwd: resolvedWorktreePath });

    // Only pull if branch has upstream tracking
    const hasUpstream = await runGit(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: resolvedWorktreePath })
      .then(() => true)
      .catch(() => false);

    if (hasUpstream && !preserveChanges) {
      await runGit(['pull', '--rebase'], { cwd: resolvedWorktreePath });
      console.log(`Pulled latest changes from upstream`);
    } else if (!hasUpstream) {
      console.log(`Branch has no upstream, skipping pull`);
    } else {
      console.log(`Preserving worktree; skipping pull to keep local changes intact`);
    }
  } else {
    // Create new worktree
    await runGit(['fetch', '--all'], { cwd: resolvedRepoPath });

    // Check if branch already exists locally
    const localBranchResult = await runGit(['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: resolvedRepoPath })
      .catch(() => null);
    const localBranchExists = localBranchResult !== null;

    // Check if branch exists on remote
    const remoteBranchResult = await runGit(['show-ref', '--verify', `refs/remotes/origin/${branchName}`], { cwd: resolvedRepoPath })
      .catch(() => null);
    const remoteBranchExists = remoteBranchResult !== null;

    if (localBranchExists) {
      // Local branch exists - checkout without resetting
      console.log(`Local branch ${branchName} exists, creating worktree from existing branch`);
      await runGit(['worktree', 'add', resolvedWorktreePath, branchName], { cwd: resolvedRepoPath });
    } else if (remoteBranchExists) {
      // Remote branch exists but no local - create local tracking branch
      console.log(`Remote branch origin/${branchName} exists, creating worktree with tracking branch`);
      await runGit(['worktree', 'add', '-b', branchName, resolvedWorktreePath, `origin/${branchName}`], { cwd: resolvedRepoPath });
    } else {
      // Branch doesn't exist anywhere - create from baseRef
      console.log(`Branch ${branchName} doesn't exist, creating from ${baseRef}`);
      await runGit(['worktree', 'add', '-B', branchName, resolvedWorktreePath, baseRef], { cwd: resolvedRepoPath });
    }
  }

  const cleanup = async () => {
    await removeWorktree(resolvedWorktreePath);
  };

  return { path: resolvedWorktreePath, branchName, cleanup };
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const exists = await pathExists(resolvedWorktreePath);
  if (!exists) {
    return;
  }

  try {
    const repoRoot = await resolveRepoRootFromWorktree(resolvedWorktreePath);
    await runGit(['worktree', 'remove', '--force', resolvedWorktreePath], { cwd: repoRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) {
      return;
    }
    throw error;
  }
}

const toErrorOutput = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  return '';
};
