<script lang="ts">
  import { onMount } from 'svelte';
  import { listWorktrees, deleteWorktree, cleanupWorktrees } from '../lib/api';
  import { sseClient } from '../lib/sse';
  import type { WorktreeInfo } from '../lib/types';

  let worktrees = $state<WorktreeInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let deleting = $state<Set<string>>(new Set());

  async function fetchWorktrees() {
    try {
      loading = true;
      const result = await listWorktrees();
      worktrees = result.worktrees;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch worktrees';
    } finally {
      loading = false;
    }
  }

  async function handleDelete(path: string) {
    if (!confirm(`本当にこのworktreeを削除しますか？\n${path}`)) {
      return;
    }

    try {
      deleting.add(path);
      deleting = new Set(deleting);

      const encodedPath = encodeURIComponent(path);
      await deleteWorktree(encodedPath);

      await fetchWorktrees();
    } catch (err) {
      alert(`削除に失敗しました: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      deleting.delete(path);
      deleting = new Set(deleting);
    }
  }

  async function handleCleanup() {
    if (!confirm('未使用のworktreeをすべて削除しますか？')) {
      return;
    }

    try {
      loading = true;
      const result = await cleanupWorktrees();
      alert(`${result.deleted.length}個のworktreeを削除しました`);
      await fetchWorktrees();
    } catch (err) {
      alert(`クリーンアップに失敗しました: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      loading = false;
    }
  }

  function getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      orphaned: '未使用',
      in_use: '使用中',
      protected: '保護中',
      locked: 'ロック中',
      unmanaged: '管理外',
    };
    return labels[status] || status;
  }

  function getStatusColor(status: string): string {
    const colors: Record<string, string> = {
      orphaned: '#999',
      in_use: '#2196F3',
      protected: '#FF9800',
      locked: '#f44336',
      unmanaged: '#757575',
    };
    return colors[status] || '#666';
  }

  function canDelete(status: string): boolean {
    return status === 'orphaned' || status === 'unmanaged';
  }

  onMount(() => {
    fetchWorktrees();
    sseClient.connect();

    const unsubscribe = sseClient.on((event) => {
      if (event.type === 'worktree_changed') {
        fetchWorktrees();
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="worktree-manager">
  <div class="header">
    <h2>Worktree管理</h2>
    <button class="cleanup-btn" onclick={handleCleanup} disabled={loading}>
      未使用を一括削除
    </button>
  </div>

  {#if loading}
    <p class="message">Loading worktrees...</p>
  {:else if error}
    <p class="message error">{error}</p>
  {:else if worktrees.length === 0}
    <p class="message">No worktrees found</p>
  {:else}
    <div class="worktrees">
      {#each worktrees as worktree (worktree.path)}
        <div class="worktree-card">
          <div class="worktree-header">
            <span class="status-badge" style="background-color: {getStatusColor(worktree.status)}">
              {getStatusLabel(worktree.status)}
            </span>
            <code class="path">{worktree.path}</code>
            {#if canDelete(worktree.status)}
              <button
                class="delete-btn"
                onclick={() => handleDelete(worktree.path)}
                disabled={deleting.has(worktree.path)}
              >
                {deleting.has(worktree.path) ? '削除中...' : '削除'}
              </button>
            {/if}
          </div>

          {#if worktree.jobs.length > 0}
            <div class="jobs-info">
              <h4>関連ジョブ ({worktree.jobs.length})</h4>
              <ul class="job-list">
                {#each worktree.jobs as job}
                  <li>
                    <span class="job-id">{job.id.slice(0, 8)}</span>
                    <span class="job-status" style="color: {getStatusColor(job.status)}">
                      {job.status}
                    </span>
                    <span class="job-branch">{job.branch_name}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .worktree-manager {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: #333;
  }

  .cleanup-btn {
    padding: 0.5rem 1rem;
    background: #f44336;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
  }

  .cleanup-btn:hover:not(:disabled) {
    background: #d32f2f;
  }

  .cleanup-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .message {
    padding: 2rem;
    text-align: center;
    color: #666;
  }

  .message.error {
    color: #f44336;
  }

  .worktrees {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .worktree-card {
    background: white;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 1.5rem;
  }

  .worktree-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .path {
    flex: 1;
    font-family: monospace;
    font-size: 0.875rem;
    color: #333;
    background: #f5f5f5;
    padding: 0.5rem;
    border-radius: 4px;
    overflow-x: auto;
  }

  .delete-btn {
    padding: 0.5rem 1rem;
    background: #f44336;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .delete-btn:hover:not(:disabled) {
    background: #d32f2f;
  }

  .delete-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .jobs-info {
    border-top: 1px solid #eee;
    padding-top: 1rem;
  }

  .jobs-info h4 {
    margin: 0 0 0.5rem 0;
    font-size: 0.875rem;
    color: #666;
  }

  .job-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .job-list li {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem;
    background: #fafafa;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .job-id {
    font-family: monospace;
    color: #666;
  }

  .job-status {
    font-weight: 500;
  }

  .job-branch {
    flex: 1;
    color: #333;
  }
</style>
