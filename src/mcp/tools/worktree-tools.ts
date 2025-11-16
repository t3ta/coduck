import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { OrchestratorClient } from '../orchestrator-client.js';
import type { WorktreeInfo } from '../../shared/types.js';
import { createTextResult } from './utils.js';

const deleteWorktreeSchema = z.object({
  path: z.string().min(1, 'Provide the full worktree path to delete.'),
});

const formatJobs = (worktree: WorktreeInfo): string => {
  if (!worktree.jobs.length) {
    return '    (no jobs)';
  }

  return worktree.jobs
    .map(
      (job) =>
        `    - ${job.id} [${job.status}]${job.feature_id ? ` feature=${job.feature_id}${job.feature_part ? `/${job.feature_part}` : ''}` : ''}`
    )
    .join('\n');
};

const formatWorktree = (worktree: WorktreeInfo, index: number): string => {
  const blocked = worktree.blockedReasons.length ? `Blocked: ${worktree.blockedReasons.join('; ')}` : '';
  const lines = [
    `${index + 1}. ${worktree.path}`,
    `   Branch: ${worktree.branch ?? 'n/a'} | Head: ${worktree.head ?? 'n/a'}`,
    `   State: ${worktree.state}${worktree.locked ? ' (locked)' : ''} | Deletable: ${worktree.deletable ? 'yes' : 'no'}`,
    worktree.prunable ? '   Prunable: yes' : '',
    blocked ? `   ${blocked}` : '',
    `   Jobs:\n${formatJobs(worktree)}`,
  ].filter(Boolean);

  return lines.join('\n');
};

export const registerWorktreeTools = (server: McpServer, orchestratorClient = new OrchestratorClient()): void => {
  server.registerTool(
    'list_worktrees',
    {
      title: 'List Worktrees',
      description: 'List managed git worktrees along with their associated orchestrator jobs.',
      inputSchema: z.object({}),
    },
    async () => {
      const worktrees = await orchestratorClient.listWorktrees();
      if (!worktrees.length) {
        return createTextResult('No worktrees reported by the orchestrator.', { worktrees });
      }

      const body = worktrees.map((entry, idx) => formatWorktree(entry, idx)).join('\n\n');
      const summary = [`Found ${worktrees.length} worktree(s).`, '', body].join('\n');
      return createTextResult(summary, { worktrees });
    }
  );

  server.registerTool(
    'cleanup_worktrees',
    {
      title: 'Cleanup Worktrees',
      description: 'Remove orphaned worktrees (no associated jobs). Running/awaiting_input jobs are protected.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await orchestratorClient.cleanupWorktrees();
      const parts = [`Removed ${result.removed.length} worktree(s).`];

      if (result.removed.length) {
        parts.push('Deleted:', ...result.removed.map((path) => `  - ${path}`));
      }

      if (result.skipped.length) {
        parts.push(
          'Skipped:',
          ...result.skipped.map((entry) => `  - ${entry.path}: ${entry.reason}`)
        );
      }

      if (result.failures.length) {
        parts.push(
          'Failures:',
          ...result.failures.map((entry) => `  - ${entry.path}: ${entry.error}`)
        );
      }

      return createTextResult(parts.join('\n'), { result });
    }
  );

  server.registerTool(
    'delete_worktree',
    {
      title: 'Delete Worktree',
      description: 'Delete a specific worktree by absolute path (must not belong to a running/awaiting job).',
      inputSchema: deleteWorktreeSchema,
    },
    async (args) => {
      const result = await orchestratorClient.deleteWorktree(args.path.trim());
      const worktree = result.worktree;
      const text = [
        `Deleted worktree ${worktree.path}`,
        `State before deletion: ${worktree.state}`,
        worktree.jobs.length
          ? `Associated jobs: ${worktree.jobs.map((job) => `${job.id} [${job.status}]`).join(', ')}`
          : 'Associated jobs: none',
      ].join('\n');
      return createTextResult(text, { worktree: result.worktree });
    }
  );
};
