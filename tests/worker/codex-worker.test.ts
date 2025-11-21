import { describe, expect, it, jest } from '../utils/jest-lite.js';
import type { Job } from '../../src/shared/types.ts';
import { CodexWorker } from '../../src/worker/codex-worker.ts';

const createJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  repo_url: '/repos/source',
  base_ref: 'origin/main',
  branch_name: 'feature/task',
  worktree_path: '/worktrees/job-1',
  worker_type: 'codex',
  status: 'pending',
  spec_json: {
    goal: 'Do something',
    context_files: [],
  },
  result_summary: null,
  conversation_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

describe('CodexWorker handleJob', () => {
  it('reports successful Codex execution as done (default push_mode=always)', async () => {
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const createWorktree = jest.fn().mockResolvedValue({
      path: '/tmp/worktree',
      branchName: 'feature/task',
      cleanup,
    });
    const executeCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-123' });
    const completeJob = jest.fn().mockResolvedValue(undefined);

    const worker = new CodexWorker({
      fetchImpl: jest.fn(),
      createWorktree,
      executeCodex,
    });

    (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
    (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
    (worker as any).commitChanges = jest.fn().mockResolvedValue('abc123');
    (worker as any).pushBranch = jest.fn().mockResolvedValue(undefined);
    (worker as any).runTests = jest.fn().mockResolvedValue(true);
    (worker as any).completeJob = completeJob;

    await (worker as any).handleJob(createJob());

    expect(createWorktree.mock.calls.length).toBe(1);
    expect(executeCodex.mock.calls[0][1]).toMatchObject({ goal: 'Do something' });
    expect(completeJob.mock.calls.length).toBe(1);
    const [jobId, status, summary, conversationId] = completeJob.mock.calls[0];
    expect(jobId).toBe('job-1');
    expect(status).toBe('done');
    expect(conversationId).toBe('conv-123');
    const codexSummary = summary.codex as Record<string, unknown>;
    expect(codexSummary.success).toBe(true);
    expect(codexSummary.awaiting_input).toBe(false);
    expect(codexSummary.conversation_id).toBe('conv-123');
    expect(summary.tests).toBe('passed');
    expect(summary.commit_hash).toBe('abc123');
    expect(summary.pushed).toBe(true);
    expect(cleanup.mock.calls.length).toBe(1);
  });

  it('reports failures when Codex execution fails', async () => {
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const createWorktree = jest.fn().mockResolvedValue({
      path: '/tmp/worktree',
      branchName: 'feature/task',
      cleanup,
    });
    const executeCodex = jest.fn().mockResolvedValue({ success: false, error: 'Codex crashed', sessionId: 'conv-fail' });
    const completeJob = jest.fn().mockResolvedValue(undefined);

    const worker = new CodexWorker({ fetchImpl: jest.fn(), createWorktree, executeCodex });

    (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
    (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
    (worker as any).commitChanges = jest.fn().mockResolvedValue(undefined);
    (worker as any).pushBranch = jest.fn().mockResolvedValue(undefined);
    (worker as any).runTests = jest.fn().mockResolvedValue(undefined);
    (worker as any).completeJob = completeJob;

    await (worker as any).handleJob(createJob());

    expect(completeJob.mock.calls.length).toBe(1);
    const [, status, summary, conversationId] = completeJob.mock.calls[0];
    expect(status).toBe('failed');
    expect(conversationId).toBe('conv-fail');
    expect(summary.error).toBe('Codex crashed');
    const codexSummary = summary.codex as Record<string, unknown>;
    expect(codexSummary.success).toBe(false);
    expect(codexSummary.awaiting_input).toBe(false);
    expect(codexSummary.conversation_id).toBe('conv-fail');
    expect(cleanup.mock.calls.length).toBe(0);
  });

  it('marks jobs as awaiting input when Codex requests more information', async () => {
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const createWorktree = jest.fn().mockResolvedValue({
      path: '/tmp/worktree',
      branchName: 'feature/task',
      cleanup,
    });
    const executeCodex = jest
      .fn()
      .mockResolvedValue({ success: false, awaitingInput: true, error: 'Need clarification', sessionId: 'conv-await' });
    const completeJob = jest.fn().mockResolvedValue(undefined);

    const worker = new CodexWorker({ fetchImpl: jest.fn(), createWorktree, executeCodex });

    (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
    (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
    (worker as any).commitChanges = jest.fn(() => {
      throw new Error('commitChanges should not be called when awaiting input');
    });
    (worker as any).pushBranch = jest.fn(() => {
      throw new Error('pushBranch should not be called when awaiting input');
    });
    (worker as any).runTests = jest.fn(() => {
      throw new Error('runTests should not be called when awaiting input');
    });
    (worker as any).completeJob = completeJob;

    await (worker as any).handleJob(createJob());

    expect(completeJob.mock.calls.length).toBe(1);
    const [, status, summary, conversationId] = completeJob.mock.calls[0];
    expect(status).toBe('awaiting_input');
    expect(conversationId).toBe('conv-await');
    const codexSummary = summary.codex as Record<string, unknown>;
    expect(codexSummary.awaiting_input).toBe(true);
    expect(codexSummary.conversation_id).toBe('conv-await');
    expect(summary.message).toBe('Codex is awaiting additional input before proceeding.');
    expect(cleanup.mock.calls.length).toBe(0);
  });

  describe('handleJob with push_mode', () => {
    it('skips push and cleanup when push_mode is "never"', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const executeCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-123' });
      const pushBranch = jest.fn().mockResolvedValue(undefined);
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({ fetchImpl: jest.fn(), createWorktree, executeCodex });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue('abc123');
      (worker as any).pushBranch = pushBranch;
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      await (worker as any).handleJob(createJob({ push_mode: 'never' }));

      expect(pushBranch.mock.calls.length).toBe(0);
      expect(cleanup.mock.calls.length).toBe(0);
      expect(completeJob.mock.calls.length).toBe(1);
      const [, status, summary] = completeJob.mock.calls[0];
      expect(status).toBe('done');
      expect(summary.commit_hash).toBe('abc123');
      expect(summary.pushed).toBe(false);
    });

    it('pushes changes and cleans up when push_mode is "always"', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const executeCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-123' });
      const pushBranch = jest.fn().mockResolvedValue(undefined);
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({ fetchImpl: jest.fn(), createWorktree, executeCodex });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue('abc123');
      (worker as any).pushBranch = pushBranch;
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      await (worker as any).handleJob(createJob({ push_mode: 'always' }));

      expect(pushBranch.mock.calls.length).toBe(1);
      expect(cleanup.mock.calls.length).toBe(1);
      expect(completeJob.mock.calls.length).toBe(1);
      const [, status, summary] = completeJob.mock.calls[0];
      expect(status).toBe('done');
      expect(summary.commit_hash).toBe('abc123');
      expect(summary.pushed).toBe(true);
    });

    it('skips push but cleans up when there are no changes (push_mode=always)', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const executeCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-123' });
      const pushBranch = jest.fn().mockResolvedValue(undefined);
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({ fetchImpl: jest.fn(), createWorktree, executeCodex });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue(null);
      (worker as any).pushBranch = pushBranch;
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      await (worker as any).handleJob(createJob({ push_mode: 'always' }));

      expect(pushBranch.mock.calls.length).toBe(0);
      expect(cleanup.mock.calls.length).toBe(1);
      expect(completeJob.mock.calls.length).toBe(1);
      const [, status, summary] = completeJob.mock.calls[0];
      expect(status).toBe('done');
      expect(summary.commit_hash).toBeNull();
      expect(summary.pushed).toBe(false);
    });
  });
});
