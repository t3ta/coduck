import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    prompt: 'Do something',
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
    expect(executeCodex.mock.calls[0][1]).toMatchObject({ prompt: 'Do something' });
    expect(completeJob.mock.calls.length).toBe(1);
    const [jobId, status, summary, conversationId] = completeJob.mock.calls[0];
    expect(jobId).toBe('job-1');
    expect(status).toBe('done');
    expect(conversationId).toBe('conv-123');
    const codexSummary = summary.codex as Record<string, unknown>;
    expect(codexSummary.success).toBe(true);
    expect(codexSummary.awaiting_input).toBe(false);
    expect(codexSummary.conversation_id).toBe('conv-123');
    expect(summary.tests_passed).toBe(true);
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

  it('should not delete working directory in no-worktree mode', async () => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-worker-noworktree-'));
    const createWorktree = jest.fn(() => {
      throw new Error('createWorktree should not be called in no-worktree mode');
    });
    const executeCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-noworktree' });
    const completeJob = jest.fn().mockResolvedValue(undefined);
    const commitChanges = jest.fn(() => {
      throw new Error('commitChanges should not be called in no-worktree mode');
    });
    const pushBranch = jest.fn(() => {
      throw new Error('pushBranch should not be called in no-worktree mode');
    });

    const worker = new CodexWorker({ fetchImpl: jest.fn(), createWorktree, executeCodex });

    (worker as any).runTests = jest.fn().mockResolvedValue(true);
    (worker as any).completeJob = completeJob;
    (worker as any).commitChanges = commitChanges;
    (worker as any).pushBranch = pushBranch;

    try {
      await (worker as any).handleJob(createJob({
        use_worktree: false,
        repo_url: workingDir,
        worktree_path: '',
        push_mode: 'never',
      }));

      await fs.access(workingDir);
      // Verify createWorktree was not called
      expect(createWorktree.mock.calls.length).toBe(0);
      // Verify Git operations were not called
      expect(commitChanges.mock.calls.length).toBe(0);
      expect(pushBranch.mock.calls.length).toBe(0);
      // Verify executeCodex was called with correct working directory
      expect(executeCodex.mock.calls[0][0]).toBe(workingDir);
      expect(completeJob.mock.calls.length).toBe(1);
      const [, status, summary] = completeJob.mock.calls[0];
      expect(status).toBe('done');
      expect(summary.working_directory).toBe(workingDir);
      expect(summary.worktree_path).toBe(undefined);
      // Verify git_skipped flag is set
      expect(summary.git_skipped).toBe(true);
    } finally {
      await fs.rm(workingDir, { recursive: true, force: true });
    }
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

  describe('Job continuation with continue_prompt', () => {
    it('continues a failed job with continuePrompt and conversation_id', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const executeCodex = jest.fn();
      const continueCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-continued' });
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({
        fetchImpl: jest.fn(),
        createWorktree,
        executeCodex,
        continueCodex,
      });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue('def456');
      (worker as any).pushBranch = jest.fn().mockResolvedValue(undefined);
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      const jobWithContinuation = createJob({
        conversation_id: 'conv-123',
        result_summary: JSON.stringify({
          continue_prompt: 'Fix the bug',
          continue_requested_at: '2024-01-01T00:00:00.000Z',
        }),
      });

      await (worker as any).handleJob(jobWithContinuation);

      expect(continueCodex.mock.calls.length).toBe(1);
      expect(continueCodex.mock.calls[0][1]).toBe('conv-123');
      expect(continueCodex.mock.calls[0][2]).toBe('Fix the bug');
      expect(executeCodex.mock.calls.length).toBe(0);
      expect(completeJob.mock.calls.length).toBe(1);
      const [, status, summary, conversationId] = completeJob.mock.calls[0];
      expect(status).toBe('done');
      expect(conversationId).toBe('conv-continued');
      expect(summary.continuations).toBeDefined();
      expect(summary.continuations.length).toBe(1);
      expect(summary.continuations[0].prompt).toBe('Fix the bug');
      expect(cleanup.mock.calls.length).toBe(1);
    });

    it('falls back to fresh execution when continuePrompt exists but conversation_id is missing', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const executeCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-fresh' });
      const continueCodex = jest.fn();
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({
        fetchImpl: jest.fn(),
        createWorktree,
        executeCodex,
        continueCodex,
      });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue('ghi789');
      (worker as any).pushBranch = jest.fn().mockResolvedValue(undefined);
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      const jobWithoutConversationId = createJob({
        conversation_id: null,
        result_summary: JSON.stringify({
          continue_prompt: 'Try again',
        }),
      });

      await (worker as any).handleJob(jobWithoutConversationId);

      expect(continueCodex.mock.calls.length).toBe(0);
      expect(executeCodex.mock.calls.length).toBe(1);
      expect(executeCodex.mock.calls[0][1]).toMatchObject({ prompt: 'Do something' });
      expect(completeJob.mock.calls.length).toBe(1);
      const [, status, , conversationId] = completeJob.mock.calls[0];
      expect(status).toBe('done');
      expect(conversationId).toBe('conv-fresh');
      expect(cleanup.mock.calls.length).toBe(1);
    });

    it('records continuationContext in result summary when continuing', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const continueCodex = jest.fn().mockResolvedValue({
        success: true,
        sessionId: 'conv-with-context',
      });
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({
        fetchImpl: jest.fn(),
        createWorktree,
        executeCodex: jest.fn(),
        continueCodex,
      });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue('jkl012');
      (worker as any).pushBranch = jest.fn().mockResolvedValue(undefined);
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      const requestedAt = '2024-02-01T12:00:00.000Z';
      const jobWithContext = createJob({
        conversation_id: 'conv-456',
        result_summary: JSON.stringify({
          continue_prompt: 'Add tests',
          continue_requested_at: requestedAt,
        }),
      });

      await (worker as any).handleJob(jobWithContext);

      expect(completeJob.mock.calls.length).toBe(1);
      const [, , summary] = completeJob.mock.calls[0];
      expect(summary.last_continuation).toBeDefined();
      expect(summary.last_continuation.prompt).toBe('Add tests');
      expect(summary.last_continuation.at).toBe(requestedAt);
      expect(summary.continuations).toBeDefined();
      expect(summary.continuations.length).toBe(1);
      expect(summary.continuations[0].prompt).toBe('Add tests');
      expect(summary.continuations[0].at).toBe(requestedAt);
      expect(summary.continuations[0].response).toBe('Continuation executed.');
      expect(cleanup.mock.calls.length).toBe(1);
    });

    it('uses resume_requested for timed-out jobs', async () => {
      const cleanup = jest.fn().mockResolvedValue(undefined);
      const createWorktree = jest.fn().mockResolvedValue({
        path: '/tmp/worktree',
        branchName: 'feature/task',
        cleanup,
      });
      const continueCodex = jest.fn().mockResolvedValue({ success: true, sessionId: 'conv-resumed' });
      const completeJob = jest.fn().mockResolvedValue(undefined);

      const worker = new CodexWorker({
        fetchImpl: jest.fn(),
        createWorktree,
        executeCodex: jest.fn(),
        continueCodex,
      });

      (worker as any).ensureRepoPath = jest.fn().mockResolvedValue('/tmp/repo');
      (worker as any).resolveWorktreePath = jest.fn().mockResolvedValue('/tmp/worktree');
      (worker as any).commitChanges = jest.fn().mockResolvedValue('mno345');
      (worker as any).pushBranch = jest.fn().mockResolvedValue(undefined);
      (worker as any).runTests = jest.fn().mockResolvedValue(true);
      (worker as any).completeJob = completeJob;

      const timedOutJob = createJob({
        conversation_id: 'conv-timeout',
        resume_requested: true,
        result_summary: null,
      });

      await (worker as any).handleJob(timedOutJob);

      expect(continueCodex.mock.calls.length).toBe(1);
      expect(continueCodex.mock.calls[0][1]).toBe('conv-timeout');
      expect(continueCodex.mock.calls[0][2]).toBe('続きを実行して');
      expect(completeJob.mock.calls.length).toBe(1);
      expect(cleanup.mock.calls.length).toBe(1);
    });
  });
});
