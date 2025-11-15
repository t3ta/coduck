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

export async function createWorktree(
  repoPath: string,
  baseRef: string,
  branchName: string,
  worktreePath: string
): Promise<WorktreeContext> {
  const resolvedRepoPath = path.resolve(repoPath);
  const resolvedWorktreePath = path.resolve(worktreePath);

  const repoExists = await pathExists(resolvedRepoPath);
  if (!repoExists) {
    throw new Error(`Repository path does not exist: ${resolvedRepoPath}`);
  }

  await fs.mkdir(path.dirname(resolvedWorktreePath), { recursive: true });

  await runGit(['fetch', '--all'], { cwd: resolvedRepoPath });
  await runGit(['worktree', 'add', '-B', branchName, resolvedWorktreePath, baseRef], { cwd: resolvedRepoPath });

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
