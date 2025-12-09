import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, it, expect, beforeAll, afterAll } from '../utils/jest-lite.js';
import { createWorktree, removeWorktree } from '../../src/worker/worktree.js';

const execFilePromise = promisify(execFile);

// Integration tests using real git commands
describe('worktree', () => {
  let tempDir: string;
  let repoPath: string;
  let worktreesDir: string;

  beforeAll(async () => {
    // Create temporary directory for test repositories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coduck-worktree-test-'));
    repoPath = path.join(tempDir, 'repo');
    worktreesDir = path.join(tempDir, 'worktrees');

    await fs.mkdir(repoPath);
    await fs.mkdir(worktreesDir);

    // Initialize git repository
    await execFilePromise('git', ['init'], { cwd: repoPath });
    await execFilePromise('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
    await execFilePromise('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });

    // Create initial commit
    await fs.writeFile(path.join(repoPath, 'README.md'), '# Test Repo');
    await execFilePromise('git', ['add', 'README.md'], { cwd: repoPath });
    await execFilePromise('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
  });

  afterAll(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createWorktree', () => {
    it('creates worktree with new branch', async () => {
      const worktreePath = path.join(worktreesDir, 'feature-new');
      const branchName = 'feature-new';

      const result = await createWorktree(repoPath, 'HEAD', branchName, worktreePath);

      expect(result.path).toBe(worktreePath);
      expect(result.branchName).toBe(branchName);
      expect(typeof result.cleanup).toBe('function');

      // Verify worktree was created
      const gitFile = await fs.readFile(path.join(worktreePath, '.git'), 'utf-8');
      expect(gitFile).toContain('gitdir:');

      // Verify files exist in worktree
      const readme = await fs.readFile(path.join(worktreePath, 'README.md'), 'utf-8');
      expect(readme).toContain('# Test Repo');

      // Clean up
      await result.cleanup();
    });

    it('reuses existing worktree (preserveChanges=false)', async () => {
      const worktreePath = path.join(worktreesDir, 'feature-reuse');
      const branchName = 'feature-reuse';

      // Create worktree first time
      await createWorktree(repoPath, 'HEAD', branchName, worktreePath);

      // Make some changes
      await fs.writeFile(path.join(worktreePath, 'test.txt'), 'test content');

      // Reuse worktree (should clean changes)
      const result2 = await createWorktree(repoPath, 'HEAD', branchName, worktreePath, { preserveChanges: false });

      expect(result2.path).toBe(worktreePath);

      // Verify changes were cleaned
      try {
        await fs.access(path.join(worktreePath, 'test.txt'));
        throw new Error('test.txt should have been cleaned');
      } catch (error) {
        // Expected: file should not exist
      }

      // Clean up
      await result2.cleanup();
    });

    it('reuses existing worktree (preserveChanges=true)', async () => {
      const worktreePath = path.join(worktreesDir, 'feature-preserve');
      const branchName = 'feature-preserve';

      // Create worktree first time
      await createWorktree(repoPath, 'HEAD', branchName, worktreePath);

      // Make some changes
      await fs.writeFile(path.join(worktreePath, 'preserved.txt'), 'preserved content');

      // Reuse worktree (should preserve changes)
      const result = await createWorktree(repoPath, 'HEAD', branchName, worktreePath, { preserveChanges: true });

      expect(result.path).toBe(worktreePath);

      // Verify changes were preserved
      const content = await fs.readFile(path.join(worktreePath, 'preserved.txt'), 'utf-8');
      expect(content).toBe('preserved content');

      // Clean up
      await result.cleanup();
    });

    it('throws error for non-existent repository path', async () => {
      const nonexistentPath = path.join(tempDir, 'nonexistent-repo');
      const worktreePath = path.join(worktreesDir, 'feature-error');

      let errorThrown = false;
      try {
        await createWorktree(nonexistentPath, 'HEAD', 'feature', worktreePath);
      } catch (error) {
        errorThrown = true;
        expect((error as Error).message).toContain('Repository path does not exist');
      }

      expect(errorThrown).toBe(true);
    });
  });

  describe('removeWorktree', () => {
    it('removes existing worktree', async () => {
      const worktreePath = path.join(worktreesDir, 'feature-remove');
      const branchName = 'feature-remove';

      // Create worktree
      await createWorktree(repoPath, 'HEAD', branchName, worktreePath);

      // Verify it exists
      await fs.access(worktreePath);

      // Remove it
      await removeWorktree(worktreePath);

      // Verify it's gone
      let errorThrown = false;
      try {
        await fs.access(worktreePath);
      } catch (error) {
        errorThrown = true;
      }
      expect(errorThrown).toBe(true);
    });

    it('completes without error when removing non-existent worktree', async () => {
      const nonexistentPath = path.join(worktreesDir, 'nonexistent-worktree');

      // Should not throw
      await removeWorktree(nonexistentPath);
    });
  });
});
