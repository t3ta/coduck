import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../utils/jest-lite.js';

type JobModule = typeof import('../../src/orchestrator/models/job.ts');
type DbModule = typeof import('../../src/orchestrator/db.ts');

const dbPath = path.join(os.tmpdir(), 'orchestrator-model-tests.sqlite');
process.env.ORCHESTRATOR_DB_PATH = dbPath;

let dbModule: DbModule;
let jobModule: JobModule;

const createJobPayload = (overrides: Partial<JobModule['CreateJobInput']> = {}): JobModule['CreateJobInput'] => ({
  repo_url: 'https://example.com/repo.git',
  base_ref: 'origin/main',
  branch_name: 'feature/test',
  worktree_path: '/tmp/worktree',
  worker_type: 'codex',
  status: 'pending',
  spec_json: {
    goal: 'Test job',
    context_files: ['README.md'],
  },
  result_summary: null,
  conversation_id: null,
  ...overrides,
});

describe('orchestrator job model', () => {
  beforeAll(async () => {
    dbModule = (await import('../../src/orchestrator/db.ts')) as DbModule;
    dbModule.initDb();
    jobModule = (await import('../../src/orchestrator/models/job.ts')) as JobModule;
  });

  afterAll(() => {
    if (fs.existsSync(dbPath)) {
      try {
        fs.rmSync(dbPath);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  beforeEach(() => {
    const db = dbModule.getDb();
    db.exec('DELETE FROM jobs');
  });

  it('claims the oldest pending Codex job and marks it as running', () => {
    const codexJob = jobModule.createJob(createJobPayload());
    const otherJob = jobModule.createJob(createJobPayload({ worker_type: 'other', branch_name: 'feature/other' }));

    const claimed = jobModule.claimJob('codex');

    expect(claimed).toBeDefined();
    expect(claimed?.id).toBe(codexJob.id);
    expect(claimed?.status).toBe('running');

    const storedCodex = jobModule.getJob(codexJob.id);
    const storedOther = jobModule.getJob(otherJob.id);

    expect(storedCodex?.status).toBe('running');
    expect(storedOther?.status).toBe('pending');

    const nextClaim = jobModule.claimJob('codex');
    expect(nextClaim).toBeNull();
  });

  it('persists job completion details with status done', () => {
    const job = jobModule.createJob(createJobPayload());

    const runningJob = jobModule.claimJob('codex');
    expect(runningJob?.status).toBe('running');

    const summary = { message: 'All good', commit: 'abc123' };
    jobModule.updateJobStatus(job.id, 'done', summary, 'running', 'conversation-1');

    const updated = jobModule.getJob(job.id);
    expect(updated?.status).toBe('done');
    expect(updated?.conversation_id).toBe('conversation-1');
    expect(updated?.result_summary).toBeDefined();
    const parsed = JSON.parse(updated!.result_summary!);
    expect(parsed).toMatchObject(summary);
  });

  it('throws when updating a job with unexpected current status', () => {
    const job = jobModule.createJob(createJobPayload());

    const update = () => jobModule.updateJobStatus(job.id, 'failed', { error: 'boom' }, 'running');

    expect(update).toThrow();
  });
});
