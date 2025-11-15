import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createHash } from 'node:crypto';

import { OrchestratorClient } from '../mcp/orchestrator-client.js';
import { removeWorktree } from '../worker/worktree.js';
import { appConfig } from '../shared/config.js';
import type { Job, JobStatus } from '../shared/types.js';
import { initDb } from '../orchestrator/db.js';
import { listJobs as listJobsFromDb } from '../orchestrator/models/job.js';

const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'awaiting_input', 'done', 'failed', 'cancelled'];
const DEFAULT_BULK_DELETE_STATUSES: JobStatus[] = ['done', 'failed', 'cancelled'];
const PROTECTED_STATUSES = new Set<JobStatus>(['running', 'awaiting_input']);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const WORKTREE_BASE_DIR = path.resolve(appConfig.worktreeBaseDir);
const REPO_CACHE_DIR = path.join(WORKTREE_BASE_DIR, '_repos');

interface CleanupOptions {
  jobs: boolean;
  statuses: JobStatus[];
  maxAgeDays?: number;
  worktrees: boolean;
  repoCache: boolean;
  dryRun: boolean;
}

interface JobCleanupResult {
  deleted: number;
  worktreesRemoved: number;
}

interface WorktreeCleanupResult {
  removed: number;
  targets: string[];
}

interface RepoCacheCleanupResult {
  removed: number;
  targets: string[];
}

type Operation = 'jobs' | 'worktrees' | 'repo caches';

const USAGE = `
Usage: npm run cleanup -- [options]

Options:
  --jobs               Clean up orchestrator jobs (default statuses: done,failed,cancelled)
  --status=<list>      Comma-separated job statuses to delete (requires --jobs)
  --max-age=<days>     Only delete jobs created at least <days> days ago (requires --jobs)
  --worktrees          Remove orphaned worktrees under ${WORKTREE_BASE_DIR}
  --repo-cache         Remove unused repository caches under ${REPO_CACHE_DIR}
  --all                Run all cleanup tasks (jobs, worktrees, repo cache)
  --dry-run            Show what would be deleted without making changes
  -h, --help           Show this help message
`;

const jobStatusSet = new Set<JobStatus>(JOB_STATUSES);

const sanitizeJobStatuses = (
  statuses?: JobStatus[]
): { effectiveStatuses: JobStatus[]; excludedStatuses: JobStatus[] } => {
  const requested = statuses ?? DEFAULT_BULK_DELETE_STATUSES;
  const effectiveStatuses = requested.filter((status) => !PROTECTED_STATUSES.has(status));
  const excludedStatuses = (statuses ?? []).filter((status) => PROTECTED_STATUSES.has(status));
  return { effectiveStatuses, excludedStatuses };
};

const formatPath = (targetPath: string): string => {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(process.cwd(), resolved);
  if (!relative || !relative.startsWith('..')) {
    return relative || '.';
  }
  return resolved;
};

const logSection = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const parseArgs = (argv: string[]): CleanupOptions => {
  if (!argv.length) {
    console.error('No options provided.');
    console.log(USAGE);
    process.exit(1);
  }

  const options: CleanupOptions = {
    jobs: false,
    statuses: [...DEFAULT_BULK_DELETE_STATUSES],
    worktrees: false,
    repoCache: false,
    dryRun: false,
  };

  let statusExplicitlySet = false;
  let allSelected = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--jobs') {
      options.jobs = true;
      continue;
    }

    if (arg.startsWith('--status')) {
      const { value, consumedNext } = extractOptionValue(arg, argv[i + 1]);
      if (consumedNext) {
        i += 1;
      }
      options.statuses = parseStatusList(value);
      statusExplicitlySet = true;
      continue;
    }

    if (arg.startsWith('--max-age')) {
      const { value, consumedNext } = extractOptionValue(arg, argv[i + 1]);
      if (consumedNext) {
        i += 1;
      }
      options.maxAgeDays = parseMaxAge(value);
      continue;
    }

    if (arg === '--worktrees') {
      options.worktrees = true;
      continue;
    }

    if (arg === '--repo-cache') {
      options.repoCache = true;
      continue;
    }

    if (arg === '--all') {
      allSelected = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }

    console.error(`Unknown option: ${arg}`);
    console.log(USAGE);
    process.exit(1);
  }

  if (allSelected) {
    options.jobs = true;
    options.worktrees = true;
    options.repoCache = true;
  }

  if (!options.jobs && (statusExplicitlySet || options.maxAgeDays !== undefined)) {
    console.error('--status/--max-age options require --jobs.');
    process.exit(1);
  }

  if (!options.jobs && !options.worktrees && !options.repoCache) {
    console.error('Nothing to do. Specify --jobs, --worktrees, --repo-cache, or --all.');
    console.log(USAGE);
    process.exit(1);
  }

  return options;
};

const extractOptionValue = (arg: string, nextValue: string | undefined): { value: string; consumedNext: boolean } => {
  const [, inlineValue] = arg.split('=');
  if (inlineValue !== undefined) {
    return { value: inlineValue, consumedNext: false };
  }
  if (nextValue === undefined) {
    throw new Error(`Option ${arg} requires a value.`);
  }
  return { value: nextValue, consumedNext: true };
};

const parseStatusList = (raw: string): JobStatus[] => {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length);
  if (!parts.length) {
    throw new Error('Status list cannot be empty.');
  }
  const deduped: JobStatus[] = [];
  for (const part of parts) {
    if (!jobStatusSet.has(part as JobStatus)) {
      throw new Error(`Invalid job status: ${part}`);
    }
    if (!deduped.includes(part as JobStatus)) {
      deduped.push(part as JobStatus);
    }
  }
  return deduped;
};

const parseMaxAge = (raw: string): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('--max-age requires a non-negative number.');
  }
  return Math.floor(parsed);
};

const promptForConfirmation = async (operations: Operation[]): Promise<boolean> => {
  const summary = operations.join(', ');
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`About to clean up ${summary}. Continue? (y/N) `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

const filterJobsForCleanup = (jobs: Job[], statuses?: JobStatus[], maxAgeDays?: number): Job[] => {
  const { effectiveStatuses } = sanitizeJobStatuses(statuses);
  if (!effectiveStatuses.length) {
    return [];
  }
  const statusSet = new Set(effectiveStatuses);
  const cutoff = maxAgeDays !== undefined ? Date.now() - maxAgeDays * MILLISECONDS_PER_DAY : undefined;
  return jobs.filter((job) => {
    if (!statusSet.has(job.status)) {
      return false;
    }
    if (cutoff === undefined) {
      return true;
    }
    const createdAt = Date.parse(job.created_at);
    if (Number.isNaN(createdAt)) {
      return false;
    }
    return createdAt <= cutoff;
  });
};

const listJobsSnapshot = (): Job[] => {
  return listJobsFromDb();
};

const formatJobLine = (job: Job): string => {
  return `  - ${job.id} (${job.status}, created ${job.created_at})`;
};

const dedupePaths = (paths: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const normalized = path.resolve(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const removeWorktreeTargets = async (targets: string[], dryRun: boolean, logList = true): Promise<number> => {
  if (!targets.length) {
    return 0;
  }

  if (logList) {
    const printable = targets.map((entry) => `  - ${formatPath(entry)}`).join('\n');
    console.log('Worktrees to remove:');
    console.log(printable);
  }

  if (dryRun) {
    console.log('Dry run: not removing worktrees.');
    return 0;
  }

  const failures: Array<{ path: string; error: unknown }> = [];
  for (const target of targets) {
    try {
      await removeWorktree(target);
      console.log(`Removed ${formatPath(target)}`);
    } catch (error) {
      failures.push({ path: target, error });
    }
  }

  if (failures.length) {
    const messages = failures
      .map(({ path: target, error }) => `${formatPath(target)}: ${error instanceof Error ? error.message : String(error)}`)
      .join('; ');
    throw new Error(`Failed to remove ${failures.length} worktree(s): ${messages}`);
  }

  return targets.length;
};

const cleanupJobWorktrees = async (jobs: Job[], dryRun: boolean): Promise<number> => {
  const paths = dedupePaths(jobs.map((job) => job.worktree_path));
  if (!paths.length) {
    console.log('No worktree paths reported by the orchestrator.');
    return 0;
  }
  console.log(`Cleaning up ${paths.length} worktree(s) referenced by deleted jobs...`);
  return removeWorktreeTargets(paths, dryRun);
};

const cleanupJobs = async (
  client: OrchestratorClient,
  options: CleanupOptions
): Promise<JobCleanupResult> => {
  logSection('Job Cleanup');
  console.log(
    `Filters: status=${options.statuses.join(', ')}${
      options.maxAgeDays !== undefined ? `, maxAge=${options.maxAgeDays} day(s)` : ''
    }`
  );

  const { effectiveStatuses, excludedStatuses } = sanitizeJobStatuses(options.statuses);

  if (excludedStatuses.length) {
    console.log(`Excluded protected statuses: ${excludedStatuses.join(', ')}`);
  }

  if (options.dryRun) {
    if (!effectiveStatuses.length) {
      console.log('No deletable statuses specified (all are protected).');
      console.log('Found 0 job(s) to delete.');
      console.log('Dry run: not deleting jobs.');
      return { deleted: 0, worktreesRemoved: 0 };
    }
    const jobs = listJobsSnapshot();
    const candidates = filterJobsForCleanup(jobs, effectiveStatuses, options.maxAgeDays);
    console.log(`Found ${candidates.length} job(s) to delete.`);
    if (candidates.length) {
      console.log('Jobs:');
      candidates.forEach((job) => console.log(formatJobLine(job)));
      const worktreePaths = dedupePaths(candidates.map((job) => job.worktree_path));
      if (worktreePaths.length) {
        console.log('\nAssociated worktrees:');
        worktreePaths.forEach((target) => console.log(`  - ${formatPath(target)}`));
      }
    }
    console.log('Dry run: not deleting jobs.');
    return { deleted: candidates.length, worktreesRemoved: 0 };
  }

  if (!effectiveStatuses.length) {
    console.log('No deletable statuses specified (all are protected).');
    console.log('Deleted 0 job(s).');
    return { deleted: 0, worktreesRemoved: 0 };
  }

  const response = await client.cleanupJobs({ statuses: effectiveStatuses, maxAgeDays: options.maxAgeDays });
  console.log(`Deleted ${response.deleted} job(s).`);

  const jobs = response.jobs ?? [];
  if (jobs.length) {
    jobs.forEach((job) => console.log(formatJobLine(job)));
  }

  const worktreesRemoved = await cleanupJobWorktrees(jobs, options.dryRun);
  return { deleted: response.deleted, worktreesRemoved };
};

const cleanupOrphanWorktrees = async (dryRun: boolean): Promise<WorktreeCleanupResult> => {
  logSection('Worktree Cleanup');
  const exists = await pathExists(WORKTREE_BASE_DIR);
  if (!exists) {
    console.log(`Worktree directory ${formatPath(WORKTREE_BASE_DIR)} does not exist. Nothing to do.`);
    return { removed: 0, targets: [] };
  }

  const entries = await fs.readdir(WORKTREE_BASE_DIR, { withFileTypes: true });
  const jobs = listJobsSnapshot();
  const activePaths = new Set(jobs.map((job) => path.resolve(job.worktree_path)));

  const orphans = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== '_repos')
    .map((name) => path.join(WORKTREE_BASE_DIR, name))
    .filter((entry) => !activePaths.has(path.resolve(entry)));

  if (!orphans.length) {
    console.log('No orphaned worktrees detected.');
    return { removed: 0, targets: [] };
  }

  console.log(`Found ${orphans.length} orphaned worktree(s):`);
  orphans.forEach((entry) => console.log(`  - ${formatPath(entry)}`));

  if (dryRun) {
    console.log('Dry run: not removing orphaned worktrees.');
    return { removed: 0, targets: orphans };
  }

  const removed = await removeWorktreeTargets(orphans, false, false);
  return { removed, targets: orphans };
};

const sanitizeRepoName = (value: string): string => {
  const hash = createHash('sha1').update(value).digest('hex').slice(0, 12);
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-32).concat('-', hash);
};

const cleanupRepoCaches = async (dryRun: boolean): Promise<RepoCacheCleanupResult> => {
  logSection('Repository Cache Cleanup');
  const exists = await pathExists(REPO_CACHE_DIR);
  if (!exists) {
    console.log(`Repository cache directory ${formatPath(REPO_CACHE_DIR)} does not exist. Nothing to do.`);
    return { removed: 0, targets: [] };
  }

  const entries = await fs.readdir(REPO_CACHE_DIR, { withFileTypes: true });
  if (!entries.length) {
    console.log('Repository cache directory is empty.');
    return { removed: 0, targets: [] };
  }

  const jobs = listJobsSnapshot();
  const referenced = new Set(jobs.map((job) => sanitizeRepoName(job.repo_url)));

  const unused = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, fullPath: path.join(REPO_CACHE_DIR, entry.name) }))
    .filter((entry) => !referenced.has(entry.name));

  if (!unused.length) {
    console.log('No unused repository caches detected.');
    return { removed: 0, targets: [] };
  }

  console.log(`Found ${unused.length} unused repo cache(s):`);
  unused.forEach((entry) => console.log(`  - ${formatPath(entry.fullPath)}`));

  if (dryRun) {
    console.log('Dry run: not deleting repo caches.');
    return { removed: 0, targets: unused.map((entry) => entry.fullPath) };
  }

  const failures: Array<{ path: string; error: unknown }> = [];
  for (const entry of unused) {
    try {
      await fs.rm(entry.fullPath, { recursive: true, force: true });
      console.log(`Removed ${formatPath(entry.fullPath)}`);
    } catch (error) {
      failures.push({ path: entry.fullPath, error });
    }
  }

  if (failures.length) {
    const message = failures
      .map(({ path: target, error }) => `${formatPath(target)}: ${error instanceof Error ? error.message : String(error)}`)
      .join('; ');
    throw new Error(`Failed to remove ${failures.length} repo cache(s): ${message}`);
  }

  return { removed: unused.length, targets: unused.map((entry) => entry.fullPath) };
};

const main = async (): Promise<void> => {
  initDb();
  const options = parseArgs(process.argv.slice(2));

  const operations: Operation[] = [];
  if (options.jobs) operations.push('jobs');
  if (options.worktrees) operations.push('worktrees');
  if (options.repoCache) operations.push('repo caches');

  if (!options.dryRun) {
    const confirmed = await promptForConfirmation(operations);
    if (!confirmed) {
      console.log('Cleanup aborted by user.');
      return;
    }
  } else {
    console.log('Dry run enabled — showing what would be removed.');
  }

  const client = new OrchestratorClient();
  const totals = {
    jobs: 0,
    jobWorktrees: 0,
    orphanWorktrees: 0,
    repoCaches: 0,
  };

  if (options.jobs) {
    const result = await cleanupJobs(client, options);
    totals.jobs = result.deleted;
    totals.jobWorktrees = result.worktreesRemoved;
  }

  if (options.worktrees) {
    const result = await cleanupOrphanWorktrees(options.dryRun);
    totals.orphanWorktrees = result.removed;
  }

  if (options.repoCache) {
    const result = await cleanupRepoCaches(options.dryRun);
    totals.repoCaches = result.removed;
  }

  const totalWorktrees = totals.jobWorktrees + totals.orphanWorktrees;
  console.log(
    `\nTotal cleanup: ${totals.jobs} job(s), ${totalWorktrees} worktree(s), ${totals.repoCaches} repo cache(s)`
  );
  if (options.dryRun) {
    console.log('Dry run complete — no changes were made.');
  }
};

main().catch((error) => {
  console.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
