import { describe, expect, it, jest } from '../utils/jest-lite.js';
import type { Job } from '../../src/shared/types.ts';
import { OrchestratorClient } from '../../src/mcp/orchestrator-client.ts';

const createJobResponse = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-123',
  repo_url: 'https://example.com/repo.git',
  base_ref: 'origin/dev',
  branch_name: 'codex/sample-branch',
  worktree_path: '/worktrees/sample',
  worker_type: 'codex',
  status: 'pending',
  spec_json: {
    goal: 'Implement feature',
    context_files: ['src/index.ts'],
  },
  result_summary: null,
  conversation_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

describe('OrchestratorClient', () => {
  it('sends spec_json and worker_type when enqueuing Codex jobs', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(createJobResponse()),
    });

    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:5555',
      repoUrl: 'https://example.com/repo.git',
      worktreeBaseDir: '/worktrees',
      fetchImpl: fetchMock,
    });

    const job = await client.enqueueCodexJob({
      goal: 'Implement feature',
      context_files: ['src/index.ts'],
      notes: 'Be mindful of edge cases',
      base_ref: 'origin/dev',
    });

    expect(job.id).toBe('job-123');
    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url instanceof URL).toBe(true);
    expect((url as URL).pathname).toBe('/jobs');
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.worker_type).toBe('codex');
    expect(body.repo_url).toBe('https://example.com/repo.git');
    expect(body.base_ref).toBe('origin/dev');
    expect(body.spec_json).toMatchObject({
      goal: 'Implement feature',
      context_files: ['src/index.ts'],
      notes: 'Be mindful of edge cases',
    });
  });

  it('includes filters when listing jobs', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    });

    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:5555',
      repoUrl: 'https://example.com/repo.git',
      worktreeBaseDir: '/worktrees',
      fetchImpl: fetchMock,
    });

    await client.listJobs({ status: 'done', worker_type: 'codex' });

    const [url] = fetchMock.mock.calls[0];
    expect((url as URL).pathname).toBe('/jobs');
    expect((url as URL).searchParams.get('status')).toBe('done');
    expect((url as URL).searchParams.get('worker_type')).toBe('codex');
  });

  it('requires a job id when fetching job details', async () => {
    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:5555',
      repoUrl: 'https://example.com/repo.git',
      worktreeBaseDir: '/worktrees',
      fetchImpl: jest.fn(),
    });

    try {
      await client.getJob('');
      throw new Error('Expected getJob to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('Job ID is required');
    }
  });

  it('sends result summary and conversation id when updating job status', async () => {
    const responseJob = createJobResponse({ status: 'done', result_summary: JSON.stringify({ message: 'ok' }), conversation_id: 'conv-7' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseJob),
    });

    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:5555',
      repoUrl: 'https://example.com/repo.git',
      worktreeBaseDir: '/worktrees',
      fetchImpl: fetchMock,
    });

    const result = await client.updateJobStatus('job-123', 'done', {
      result_summary: { message: 'ok' },
      conversation_id: 'conv-7',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect((url as URL).pathname).toBe('/jobs/job-123/complete');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.status).toBe('done');
    expect(body.result_summary).toMatchObject({ message: 'ok' });
    expect(body.conversation_id).toBe('conv-7');
    expect(result.status).toBe('done');
  });
});
