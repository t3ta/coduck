import http from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '../utils/jest-lite.js';
import type { Job } from '../../src/shared/types.ts';

const dbModulePromise = import('../../src/orchestrator/db.ts');
const jobModulePromise = import('../../src/orchestrator/models/job.ts');
const serverModulePromise = import('../../src/orchestrator/server.ts');

const createJobPayload = (overrides: Record<string, unknown> = {}) => ({
  repo_url: 'https://example.com/repo.git',
  base_ref: 'origin/main',
  branch_name: 'feature/http-test',
  worktree_path: '/tmp/worktree-http',
  worker_type: 'codex',
  spec_json: {
    prompt: 'Verify route behaviour\nContext: README.md',
  },
  ...overrides,
});

describe('orchestrator job routes', () => {
  let dbModule: typeof import('../../src/orchestrator/db.ts');
  let jobModule: typeof import('../../src/orchestrator/models/job.ts');
  let serverModule: typeof import('../../src/orchestrator/server.ts');
  let server: http.Server | null = null;
  let baseUrl: string = '';

  beforeAll(async () => {
    dbModule = await dbModulePromise;
    jobModule = await jobModulePromise;
    serverModule = await serverModulePromise;
    dbModule.initDb();
  });

  beforeEach(() => {
    const db = dbModule.getDb();
    db.exec('DELETE FROM jobs');

    const app = serverModule.createApp();
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it('claims pending Codex jobs without touching other worker types', async () => {
    const createResponse = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createJobPayload()),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const otherResponse = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createJobPayload({ worker_type: 'other', branch_name: 'feature/other-worker' })),
    });
    expect(otherResponse.status).toBe(201);

    const claimResponse = await fetch(`${baseUrl}/jobs/claim?worker_type=codex`, { method: 'POST' });
    expect(claimResponse.status).toBe(200);
    const claimed = await claimResponse.json();
    expect(claimed.id).toBe(created.id);
    expect(claimed.status).toBe('running');

    const stored = jobModule.getJob(created.id);
    expect(stored?.status).toBe('running');

    const secondClaim = await fetch(`${baseUrl}/jobs/claim?worker_type=codex`, { method: 'POST' });
    expect(secondClaim.status).toBe(404);
  });

  it('completes jobs and persists status transitions through HTTP API', async () => {
    const createResponse = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createJobPayload()),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const claimResponse = await fetch(`${baseUrl}/jobs/claim?worker_type=codex`, { method: 'POST' });
    expect(claimResponse.status).toBe(200);

    const completionSummary = { message: 'Completed via HTTP', commit: 'def456' };
    const completeResponse = await fetch(`${baseUrl}/jobs/${created.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', result_summary: completionSummary, conversation_id: 'conv-42' }),
    });
    expect(completeResponse.status).toBe(200);
    const completedJob = await completeResponse.json();

    expect(completedJob.status).toBe('done');
    expect(completedJob.result_summary).toBeDefined();
    const parsedSummary = JSON.parse(completedJob.result_summary);
    expect(parsedSummary).toMatchObject(completionSummary);

    const stored = jobModule.getJob(created.id);
    expect(stored?.status).toBe('done');
    expect(stored?.conversation_id).toBe('conv-42');
  });

  describe('POST /jobs with feature metadata', () => {
    it('creates jobs with feature_id and feature_part', async () => {
      const payload = createJobPayload({
        feature_id: 'user-auth',
        feature_part: 'frontend',
      });
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as Job;
      expect(job.feature_id).toBe('user-auth');
      expect(job.feature_part).toBe('frontend');
    });

    it('creates jobs without feature metadata', async () => {
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload()),
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as Job;
      expect(job.feature_id).toBeNull();
      expect(job.feature_part).toBeNull();
    });

    it('rejects empty feature_id strings', async () => {
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload({ feature_id: '' })),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('GET /jobs with feature_id filter', () => {
    it('filters jobs by feature_id', async () => {
      await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload({ feature_id: 'feature-x' })),
      });
      await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload({ feature_id: 'feature-y' })),
      });
      await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload({ feature_id: 'feature-x' })),
      });

      const response = await fetch(`${baseUrl}/jobs?feature_id=feature-x`);
      expect(response.status).toBe(200);
      const jobs = (await response.json()) as Job[];
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => job.feature_id === 'feature-x')).toBe(true);
    });

    it('returns all jobs when feature_id filter is absent', async () => {
      await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload({ feature_id: 'feature-z' })),
      });
      await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createJobPayload()),
      });

      const response = await fetch(`${baseUrl}/jobs`);
      expect(response.status).toBe(200);
      const jobs = (await response.json()) as Job[];
      expect(jobs).toHaveLength(2);
    });
  });

  describe('POST /jobs with push_mode', () => {
    it('creates jobs with push_mode="always"', async () => {
      const payload = createJobPayload({ push_mode: 'always' });
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as Job;
      expect(job.push_mode).toBe('always');
    });

    it('creates jobs with push_mode="never"', async () => {
      const payload = createJobPayload({ push_mode: 'never' });
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as Job;
      expect(job.push_mode).toBe('never');
    });

    it('defaults to push_mode="always" when not specified', async () => {
      const payload = createJobPayload();
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(201);
      const job = (await response.json()) as Job;
      expect(job.push_mode).toBe('always');
    });
  });

  describe('POST /jobs/:id/continue', () => {
    it('successfully continues a failed job with valid prompt and conversation_id', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      // Set job to failed with conversation_id
      jobModule.updateJobStatus(
        job.id,
        'failed',
        JSON.stringify({ error: 'Original error' }),
        undefined,
        'conv-123'
      );

      const continueResponse = await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Fix the bug' }),
      });

      expect(continueResponse.status).toBe(200);
      const result = await continueResponse.json();
      expect(result.success).toBe(true);

      const updatedJob = jobModule.getJob(job.id);
      expect(updatedJob?.status).toBe('pending');
      const summary = JSON.parse(updatedJob?.result_summary || '{}');
      expect(summary.continue_prompt).toBe('Fix the bug');
      expect(summary.continue_requested_at).toBeDefined();
    });

    it('returns 404 when job not found', async () => {
      const response = await fetch(`${baseUrl}/jobs/nonexistent-id/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Test' }),
      });

      expect(response.status).toBe(404);
      const error = await response.json();
      expect(error.error).toContain('Job not found');
    });

    it('returns 400 when job status is not failed', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      // Job is in 'pending' status
      const response = await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Test' }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('not in failed status');
    });

    it('returns 400 when job has no conversation_id', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      // Set job to failed but without conversation_id
      jobModule.updateJobStatus(job.id, 'failed', JSON.stringify({ error: 'Test error' }), undefined, null);

      const response = await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Test' }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('no conversation_id');
    });

    it('returns 400 when job is timed out (should use /resume)', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      // Set job to failed with timed_out flag
      jobModule.updateJobStatus(
        job.id,
        'failed',
        JSON.stringify({ codex: { timed_out: true } }),
        undefined,
        'conv-timeout'
      );

      const response = await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Test' }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('timed out');
      expect(error.error).toContain('/resume');
    });

    it('returns 400 when prompt is empty', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      jobModule.updateJobStatus(job.id, 'failed', JSON.stringify({}), undefined, 'conv-123');

      const response = await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '' }),
      });

      expect(response.status).toBe(400);
    });

    it('trims whitespace from prompt using schema validation', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      jobModule.updateJobStatus(job.id, 'failed', JSON.stringify({}), undefined, 'conv-123');

      const response = await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '  Fix the bug  ' }),
      });

      expect(response.status).toBe(200);
      const updatedJob = jobModule.getJob(job.id);
      const summary = JSON.parse(updatedJob?.result_summary || '{}');
      expect(summary.continue_prompt).toBe('Fix the bug');
    });

    it('updates job status from failed to pending', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      jobModule.updateJobStatus(job.id, 'failed', JSON.stringify({}), undefined, 'conv-123');
      expect(jobModule.getJob(job.id)?.status).toBe('failed');

      await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Continue' }),
      });

      expect(jobModule.getJob(job.id)?.status).toBe('pending');
    });

    it('preserves existing result_summary while adding continue fields', async () => {
      const payload = createJobPayload();
      const createResponse = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const job = (await createResponse.json()) as Job;

      const existingSummary = {
        error: 'Previous error',
        codex: { success: false },
        continuations: [{ prompt: 'First try', response: 'Failed' }],
      };
      jobModule.updateJobStatus(job.id, 'failed', JSON.stringify(existingSummary), undefined, 'conv-123');

      await fetch(`${baseUrl}/jobs/${job.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Second try' }),
      });

      const updatedJob = jobModule.getJob(job.id);
      const summary = JSON.parse(updatedJob?.result_summary || '{}');
      expect(summary.error).toBe('Previous error');
      expect(summary.codex).toEqual({ success: false });
      expect(summary.continuations).toEqual([{ prompt: 'First try', response: 'Failed' }]);
      expect(summary.continue_prompt).toBe('Second try');
      expect(summary.continue_requested_at).toBeDefined();
    });
  });
});
