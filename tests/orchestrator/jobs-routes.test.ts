import http from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '../utils/jest-lite.js';

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
    goal: 'Verify route behaviour',
    context_files: ['README.md'],
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
});
