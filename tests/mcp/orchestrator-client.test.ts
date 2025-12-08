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
  feature_id: null,
  feature_part: null,
  spec_json: {
    prompt: 'Implement feature\nContext: src/index.ts',
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
      prompt: 'Implement feature\nContext: src/index.ts\nNotes: Be mindful of edge cases',
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
      prompt: 'Implement feature\nContext: src/index.ts\nNotes: Be mindful of edge cases',
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

  describe('enqueueCodexJob with feature metadata', () => {
    it('sends feature_id and feature_part when provided', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(createJobResponse({ feature_id: 'analytics', feature_part: 'tracking' })),
      });

      const client = new OrchestratorClient({
        baseUrl: 'http://localhost:5555',
        repoUrl: 'https://example.com/repo.git',
        worktreeBaseDir: '/worktrees',
        fetchImpl: fetchMock,
      });

      const job = await client.enqueueCodexJob({
        prompt: 'Add analytics tracking\nContext: src/analytics.ts',
        feature_id: 'analytics',
        feature_part: 'tracking',
      });

      expect(job.feature_id).toBe('analytics');
      expect(job.feature_part).toBe('tracking');

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.feature_id).toBe('analytics');
      expect(body.feature_part).toBe('tracking');
    });

    it('works without feature metadata', async () => {
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
        prompt: 'Regular task\nContext: src/file.ts',
      });

      expect(job.feature_id).toBeNull();
      expect(job.feature_part).toBeNull();
    });
  });

  describe('listJobs with feature_id filter', () => {
    it('adds feature_id to query params when provided', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([createJobResponse({ feature_id: 'search' })]),
      });

      const client = new OrchestratorClient({
        baseUrl: 'http://localhost:5555',
        repoUrl: 'https://example.com/repo.git',
        worktreeBaseDir: '/worktrees',
        fetchImpl: fetchMock,
      });

      await client.listJobs({ feature_id: 'search' });

      const [url] = fetchMock.mock.calls[0];
      expect((url as URL).searchParams.get('feature_id')).toBe('search');
    });

    it('omits feature_id when no filter is provided', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([createJobResponse()]),
      });

      const client = new OrchestratorClient({
        baseUrl: 'http://localhost:5555',
        repoUrl: 'https://example.com/repo.git',
        worktreeBaseDir: '/worktrees',
        fetchImpl: fetchMock,
      });

      await client.listJobs();

      const [url] = fetchMock.mock.calls[0];
      expect((url as URL).searchParams.has('feature_id')).toBe(false);
    });
  });

  describe('enqueueCodexJob with branch_name and push_mode', () => {
    it('uses explicit branch_name when provided', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(createJobResponse({ branch_name: 'feature/my-branch' })),
      });

      const client = new OrchestratorClient({
        baseUrl: 'http://localhost:5555',
        repoUrl: 'https://example.com/repo.git',
        worktreeBaseDir: '/worktrees',
        fetchImpl: fetchMock,
      });

      await client.enqueueCodexJob({
        prompt: 'Implement feature\nContext: src/index.ts',
        branch_name: 'feature/my-branch',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.branch_name).toBe('feature/my-branch');
      expect(body.worktree_path).toContain('feature-my-branch');
    });

    it('generates branch_name from feature_id when only feature_id is provided', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(createJobResponse({ branch_name: 'feature/user-auth' })),
      });

      const client = new OrchestratorClient({
        baseUrl: 'http://localhost:5555',
        repoUrl: 'https://example.com/repo.git',
        worktreeBaseDir: '/worktrees',
        fetchImpl: fetchMock,
      });

      await client.enqueueCodexJob({
        prompt: 'Add authentication\nContext: src/auth.ts',
        feature_id: 'user-auth',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.branch_name).toBe('feature/user-auth');
    });

    it('auto-generates branch_name when neither branch_name nor feature_id is provided', async () => {
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

      await client.enqueueCodexJob({
        prompt: 'Implement feature\nContext: src/index.ts',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.branch_name.startsWith('codex/')).toBe(true);
    });

    it('sanitizes feature_id containing spaces and special characters', async () => {
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

      await client.enqueueCodexJob({
        prompt: 'Add authentication\nContext: src/auth.ts',
        feature_id: 'User Auth?:Test',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.branch_name).toBe('feature/user-auth-test');
    });

    it('falls back to auto-generated branch when feature_id becomes empty after sanitization', async () => {
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

      await client.enqueueCodexJob({
        prompt: 'Implement feature\nContext: src/index.ts',
        feature_id: '🚀',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.branch_name.startsWith('codex/')).toBe(true);
    });

    it('sends push_mode="never" when specified', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(createJobResponse({ push_mode: 'never' })),
      });

      const client = new OrchestratorClient({
        baseUrl: 'http://localhost:5555',
        repoUrl: 'https://example.com/repo.git',
        worktreeBaseDir: '/worktrees',
        fetchImpl: fetchMock,
      });

      await client.enqueueCodexJob({
        prompt: 'Implement feature\nContext: src/index.ts',
        push_mode: 'never',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.push_mode).toBe('never');
    });

    it('defaults to push_mode="always" when not specified', async () => {
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

      await client.enqueueCodexJob({
        prompt: 'Implement feature\nContext: src/index.ts',
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.push_mode).toBe('always');
    });
  });
});
