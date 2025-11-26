import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Router } from 'express';

import { appConfig } from '../../shared/config.js';
import type {
  Job,
  JobStatus,
  WorktreeCleanupResponse,
  WorktreeDeletionResponse,
  WorktreeInfo,
  WorktreeJobSummary,
} from '../../shared/types.js';
import { listJobs } from '../models/job.js';
import { removeWorktree } from '../../worker/worktree.js';
import { orchestratorEvents } from '../events.js';

const execFileAsync = promisify(execFile);
const WORKTREE_BASE_DIR = path.resolve(appConfig.worktreeBaseDir);
const GIT_COMMAND = appConfig.gitPath;
const PROTECTED_STATUSES = new Set<JobStatus>(['running', 'awaiting_input']);

interface GitWorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
}

const runGit = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(GIT_COMMAND, args, { cwd: process.cwd(), encoding: 'utf8' });
    return stdout;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      throw new Error(`Git executable not found (configured path: ${GIT_COMMAND}). Install git or set GIT_PATH.`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${GIT_COMMAND} ${args.join(' ')} failed: ${message}`);
  }
};

const parseGitWorktreeList = (output: string): GitWorktreeEntry[] => {
  const entries: GitWorktreeEntry[] = [];
  const lines = output.split('\n');
  let current: GitWorktreeEntry | null = null;

  const pushCurrent = () => {
    if (current) {
      entries.push(current);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('worktree ')) {
      pushCurrent();
      current = {
        path: line.slice('worktree '.length).trim(),
        branch: null,
        head: null,
        locked: false,
        prunable: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const branch = line.slice('branch '.length).trim();
      current.branch = branch === '(detached)' ? branch : branch.replace(/^refs\/heads\//, '');
      continue;
    }

    if (line === 'detached') {
      current.branch = '(detached)';
      continue;
    }

    if (line.startsWith('locked')) {
      current.locked = true;
      continue;
    }

    if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }

  pushCurrent();
  return entries;
};

const isManagedWorktree = (targetPath: string): boolean => {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(WORKTREE_BASE_DIR, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const toJobSummary = (job: Job): WorktreeJobSummary => ({
  id: job.id,
  status: job.status,
  feature_id: job.feature_id ?? null,
  feature_part: job.feature_part ?? null,
  updated_at: job.updated_at,
});

const worktreeState = (info: {
  managed: boolean;
  locked: boolean;
  jobs: WorktreeJobSummary[];
}): WorktreeInfo['state'] => {
  if (!info.managed) return 'unmanaged';
  if (info.locked) return 'locked';
  if (info.jobs.some((job) => PROTECTED_STATUSES.has(job.status))) return 'protected';
  if (info.jobs.length) return 'in_use';
  return 'orphaned';
};

const buildBlockedReasons = (info: {
  managed: boolean;
  locked: boolean;
  jobs: WorktreeJobSummary[];
}): string[] => {
  const reasons: string[] = [];
  if (!info.managed) {
    reasons.push(`Worktree is outside managed directory ${WORKTREE_BASE_DIR}`);
  }
  if (info.locked) {
    reasons.push('Worktree is locked by git');
  }
  if (info.jobs.some((job) => PROTECTED_STATUSES.has(job.status))) {
    reasons.push('Worktree is used by a running or awaiting_input job');
  }
  return reasons;
};

const collectWorktreeInfo = async (): Promise<WorktreeInfo[]> => {
  const gitOutput = await runGit(['worktree', 'list', '--porcelain']);
  const entries = parseGitWorktreeList(gitOutput);
  const jobs = listJobs();
  const jobMap = new Map<string, WorktreeJobSummary[]>();

  for (const job of jobs) {
    const resolvedPath = path.resolve(job.worktree_path);
    const summaries = jobMap.get(resolvedPath) ?? [];
    summaries.push(toJobSummary(job));
    jobMap.set(resolvedPath, summaries);
  }

  const infos = entries.map<WorktreeInfo>((entry) => {
    const resolvedPath = path.resolve(entry.path);
    const managed = isManagedWorktree(resolvedPath);
    const jobsForWorktree = jobMap.get(resolvedPath) ?? [];
    const state = worktreeState({ managed, locked: entry.locked, jobs: jobsForWorktree });
    const blockedReasons = buildBlockedReasons({ managed, locked: entry.locked, jobs: jobsForWorktree });
    const deletable = blockedReasons.length === 0;

    return {
      path: resolvedPath,
      branch: entry.branch,
      head: entry.head,
      locked: entry.locked,
      prunable: entry.prunable,
      managed,
      jobs: jobsForWorktree,
      state,
      deletable,
      blockedReasons,
    };
  });

  infos.sort((a, b) => a.path.localeCompare(b.path));
  return infos;
};

export const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const worktrees = await collectWorktreeInfo();
    res.json(worktrees);
  } catch (error) {
    next(error);
  }
});

router.delete('/cleanup', async (_req, res, next) => {
  try {
    const worktrees = await collectWorktreeInfo();
    const candidates = worktrees.filter((entry) => entry.managed && entry.jobs.length === 0);
    const removable = candidates.filter((entry) => entry.deletable);
    const skipped = candidates
      .filter((entry) => !entry.deletable)
      .map((entry) => ({
        path: entry.path,
        reason: entry.blockedReasons.join('; ') || 'Worktree is not deletable',
      }));

    const removed: string[] = [];
    const failures: Array<{ path: string; error: string }> = [];
    for (const entry of removable) {
      try {
        await removeWorktree(entry.path);
        removed.push(entry.path);
      } catch (error) {
        failures.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Emit SSE event if any worktrees were removed
    if (removed.length > 0) {
      orchestratorEvents.emit({ type: 'worktree_changed' });
    }

    const payload: WorktreeCleanupResponse = { removed, failures, skipped };
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.delete('/:encodedPath', async (req, res, next) => {
  try {
    const decodedPath = path.resolve(decodeURIComponent(req.params.encodedPath));
    const worktrees = await collectWorktreeInfo();
    const target = worktrees.find((entry) => path.resolve(entry.path) === decodedPath);

    if (!target) {
      return res.status(404).json({ error: 'Worktree not found' });
    }
    if (!target.deletable) {
      return res.status(400).json({
        error: target.blockedReasons.join('; ') || 'Worktree cannot be deleted',
        worktree: target,
      });
    }

    try {
      await removeWorktree(target.path);
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Emit SSE event on successful deletion
    orchestratorEvents.emit({ type: 'worktree_changed' });

    const payload: WorktreeDeletionResponse = { removed: true, worktree: target };
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

export default router;
