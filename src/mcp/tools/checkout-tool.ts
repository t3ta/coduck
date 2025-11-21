import { z } from 'zod';
import { access, cp, readdir, rm, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { OrchestratorClient } from '../orchestrator-client.js';
import { createTextResult } from './utils.js';

const checkoutJobWorktreeSchema = z.object({
  job_id: z.string().min(1, 'Job ID is required.'),
  target_path: z.string().min(1).optional(),
});

const normalizePathForComparison = async (inputPath: string): Promise<string> => {
  const resolvedPath = resolve(inputPath);

  // realpath canonicalizes and resolves symlinks; fallback is fine when the target does not yet exist.
  let canonicalPath = resolvedPath;
  try {
    canonicalPath = await realpath(resolvedPath);
  } catch {
    // noop
  }

  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
};

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
      const resolvedWorktreePath = resolve(job.worktree_path);
      const normalizedTargetPath = await normalizePathForComparison(resolvedTargetPath);
      const normalizedWorktreePath = await normalizePathForComparison(resolvedWorktreePath);

      // Prevent copying into the source worktree or its subdirectories (cross-platform)
      if (
        normalizedTargetPath === normalizedWorktreePath ||
        normalizedTargetPath.startsWith(normalizedWorktreePath + sep)
      ) {
        throw new Error(
          `Cannot checkout into the source worktree itself or its subdirectory.\n` +
          `Target: ${normalizedTargetPath}\n` +
          `Worktree: ${normalizedWorktreePath}`
        );
      }

      // Clean target directory before copying (excluding .git)
      try {
        const entries = await readdir(resolvedTargetPath);
        for (const entry of entries) {
          if (entry !== '.git') {
            await rm(join(resolvedTargetPath, entry), { recursive: true, force: true });
          }
        }
      } catch (error) {
        // Target directory might not exist yet, which is fine
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      // Copy worktree contents to target path, excluding .git
      await cp(job.worktree_path, resolvedTargetPath, {
        recursive: true,
        filter: (source) => {
          // Exclude .git file/directory (cross-platform)
          const name = basename(source);
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
        'Note: Target directory was cleaned (excluding .git) before copying.',
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
