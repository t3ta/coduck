import { z } from 'zod';
import { access, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { OrchestratorClient } from '../orchestrator-client.js';
import { createTextResult } from './utils.js';

const checkoutJobWorktreeSchema = z.object({
  job_id: z.string().min(1, 'Job ID is required.'),
  target_path: z.string().min(1).optional(),
});

export const registerCheckoutTool = (
  server: McpServer,
  orchestratorClient = new OrchestratorClient()
): void => {
  server.registerTool(
    'checkout_job_worktree',
    {
      title: 'Checkout Job Worktree',
      description: "Copy a job's worktree to Claude Code's working directory for review and editing.",
      inputSchema: checkoutJobWorktreeSchema,
    },
    async (args) => {
      const jobId = args.job_id.trim();
      const job = await orchestratorClient.getJob(jobId);

      if (!job.worktree_path) {
        throw new Error(`Job ${jobId} does not have a worktree path assigned yet.`);
      }

      // Verify worktree exists
      try {
        await access(job.worktree_path);
      } catch {
        throw new Error(`Worktree path ${job.worktree_path} does not exist or is not accessible.`);
      }

      // Determine target path
      const targetPath = args.target_path?.trim() || process.cwd();
      const resolvedTargetPath = resolve(targetPath);

      // Copy worktree contents to target path, excluding .git
      await cp(job.worktree_path, resolvedTargetPath, {
        recursive: true,
        filter: (source) => {
          // Exclude .git file/directory
          const name = source.split('/').pop();
          return name !== '.git';
        },
        force: true,
      });

      const summary = [
        `Checked out worktree for job ${jobId}`,
        `From: ${job.worktree_path}`,
        `To: ${resolvedTargetPath}`,
        `Branch: ${job.branch_name}`,
        `Status: ${job.status}`,
        '',
        'Note: .git was excluded from the copy.',
      ].join('\n');

      return createTextResult(summary, {
        job_id: job.id,
        worktree_path: job.worktree_path,
        target_path: resolvedTargetPath,
        branch: job.branch_name,
      });
    }
  );
};
