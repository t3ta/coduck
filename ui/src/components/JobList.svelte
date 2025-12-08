<script lang="ts">
  import { onMount } from 'svelte';
  import { listJobs, deleteJob } from '../lib/api';
  import { sseClient } from '../lib/sse';
  import type { Job, JobStatus } from '../lib/types';

  type Props = {
    onSelectJob?: (job: Job) => void;
  };

  let { onSelectJob = undefined }: Props = $props();

  let jobs = $state<Job[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let activeTab = $state<JobStatus | 'all'>('all');
  let selectedIds = $state<Set<string>>(new Set());
  let deleting = $state(false);

  const statusTabs: { label: string; value: JobStatus | 'all'; color: string }[] = [
    { label: 'All', value: 'all', color: '#666' },
    { label: 'Pending', value: 'pending', color: '#999' },
    { label: 'Running', value: 'running', color: '#2196F3' },
    { label: 'Done', value: 'done', color: '#4CAF50' },
    { label: 'Failed', value: 'failed', color: '#f44336' },
    { label: 'Awaiting Input', value: 'awaiting_input', color: '#FF9800' },
  ];

  async function fetchJobs() {
    try {
      loading = true;
      jobs = await listJobs();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch jobs';
    } finally {
      loading = false;
    }
  }

  const filteredJobs = $derived(
    activeTab === 'all' ? jobs : jobs.filter((j) => j.status === activeTab)
  );

  const deletableSelectedIds = $derived(
    new Set([...selectedIds].filter((id) => {
      const job = jobs.find((j) => j.id === id);
      return job && job.status !== 'running' && job.status !== 'awaiting_input';
    }))
  );

  const allFilteredSelected = $derived(
    filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id))
  );

  function handleJobClick(job: Job) {
    onSelectJob?.(job);
  }

  function toggleSelect(event: MouseEvent, jobId: string) {
    event.stopPropagation();
    const newSet = new Set(selectedIds);
    if (newSet.has(jobId)) {
      newSet.delete(jobId);
    } else {
      newSet.add(jobId);
    }
    selectedIds = newSet;
  }

  function toggleSelectAll() {
    if (allFilteredSelected) {
      const newSet = new Set(selectedIds);
      for (const job of filteredJobs) {
        newSet.delete(job.id);
      }
      selectedIds = newSet;
    } else {
      const newSet = new Set(selectedIds);
      for (const job of filteredJobs) {
        newSet.add(job.id);
      }
      selectedIds = newSet;
    }
  }

  function clearSelection() {
    selectedIds = new Set();
  }

  async function handleBulkDelete() {
    const ids = [...deletableSelectedIds];
    if (ids.length === 0) return;

    const undeletableCount = selectedIds.size - ids.length;
    let message = `${ids.length}件のジョブを削除しますか？`;
    if (undeletableCount > 0) {
      message += `\n（実行中/入力待ちの${undeletableCount}件は削除されません）`;
    }

    if (!confirm(message)) return;

    deleting = true;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        await deleteJob(id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `Failed to delete ${id}`);
      }
    }

    deleting = false;
    clearSelection();

    if (errors.length > 0) {
      alert(`${errors.length}件の削除に失敗しました:\n${errors.join('\n')}`);
    }
  }

  async function handleDeleteJob(event: MouseEvent, job: Job) {
    event.stopPropagation();
    if (!confirm(`ジョブ "${job.spec_json.prompt.slice(0, 50)}..." を削除しますか？`)) {
      return;
    }
    try {
      await deleteJob(job.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : '削除に失敗しました');
    }
  }

  function getStatusColor(status: JobStatus): string {
    const tab = statusTabs.find((t) => t.value === status);
    return tab?.color || '#666';
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  onMount(() => {
    fetchJobs();
    sseClient.connect();

    const unsubscribe = sseClient.on((event) => {
      if (event.type === 'job_created') {
        jobs = [event.data, ...jobs];
      } else if (event.type === 'job_updated') {
        const index = jobs.findIndex((j) => j.id === event.data.id);
        if (index !== -1) {
          jobs[index] = event.data;
          jobs = [...jobs];
        }
      } else if (event.type === 'job_deleted') {
        jobs = jobs.filter((j) => j.id !== event.data.id);
        if (selectedIds.has(event.data.id)) {
          const newSet = new Set(selectedIds);
          newSet.delete(event.data.id);
          selectedIds = newSet;
        }
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="job-list">
  <div class="tabs">
    {#each statusTabs as tab}
      <button
        class="tab"
        class:active={activeTab === tab.value}
        style="--tab-color: {tab.color}"
        onclick={() => (activeTab = tab.value)}
      >
        {tab.label}
        {#if tab.value === 'all'}
          ({jobs.length})
        {:else}
          ({jobs.filter((j) => j.status === tab.value).length})
        {/if}
      </button>
    {/each}
  </div>

  {#if selectedIds.size > 0}
    <div class="selection-bar">
      <span class="selection-count">{selectedIds.size}件選択中</span>
      <div class="selection-actions">
        <button class="select-all-btn" onclick={toggleSelectAll}>
          {allFilteredSelected ? '選択解除' : '全て選択'}
        </button>
        <button class="clear-btn" onclick={clearSelection}>クリア</button>
        <button
          class="bulk-delete-btn"
          onclick={handleBulkDelete}
          disabled={deleting || deletableSelectedIds.size === 0}
        >
          {deleting ? '削除中...' : `削除 (${deletableSelectedIds.size})`}
        </button>
      </div>
    </div>
  {/if}

  {#if loading}
    <p class="message">Loading jobs...</p>
  {:else if error}
    <p class="message error">{error}</p>
  {:else if filteredJobs.length === 0}
    <p class="message">No jobs found</p>
  {:else}
    <div class="jobs">
      {#each filteredJobs as job (job.id)}
        <div class="job-card" class:selected={selectedIds.has(job.id)} onclick={() => handleJobClick(job)}>
          <div class="job-header">
            <div class="job-header-left">
              <input
                type="checkbox"
                class="job-checkbox"
                checked={selectedIds.has(job.id)}
                onclick={(e) => toggleSelect(e, job.id)}
              />
              <span
                class="status-badge"
                style="background-color: {getStatusColor(job.status)}"
              >
                {job.status}
              </span>
            </div>
            <div class="job-header-right">
              <span class="job-id">{job.id.slice(0, 8)}</span>
              <button
                class="delete-btn"
                onclick={(e) => handleDeleteJob(e, job)}
                title="削除"
              >
                ×
              </button>
            </div>
          </div>
          <div class="job-goal">{job.spec_json.prompt}</div>
          <div class="job-meta">
            <span>Branch: {job.branch_name}</span>
            {#if job.feature_id}
              <span>Feature: {job.feature_id}</span>
            {/if}
          </div>
          <div class="job-time">Created: {formatDate(job.created_at)}</div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .job-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    border-bottom: 2px solid #ddd;
    padding-bottom: 0.5rem;
  }

  .tab {
    padding: 0.5rem 1rem;
    background: white;
    border: 1px solid #ddd;
    border-radius: 4px 4px 0 0;
    cursor: pointer;
    transition: all 0.2s;
  }

  .tab:hover {
    background: #f5f5f5;
  }

  .tab.active {
    background: var(--tab-color);
    color: white;
    border-color: var(--tab-color);
  }

  .selection-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: #e3f2fd;
    border-radius: 8px;
    border: 1px solid #90caf9;
  }

  .selection-count {
    font-weight: 500;
    color: #1976d2;
  }

  .selection-actions {
    display: flex;
    gap: 0.5rem;
  }

  .select-all-btn,
  .clear-btn {
    padding: 0.375rem 0.75rem;
    background: white;
    border: 1px solid #90caf9;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    color: #1976d2;
    transition: all 0.2s;
  }

  .select-all-btn:hover,
  .clear-btn:hover {
    background: #e3f2fd;
  }

  .bulk-delete-btn {
    padding: 0.375rem 0.75rem;
    background: #f44336;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    color: white;
    transition: all 0.2s;
  }

  .bulk-delete-btn:hover:not(:disabled) {
    background: #d32f2f;
  }

  .bulk-delete-btn:disabled {
    background: #ccc;
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

  .jobs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 1rem;
  }

  .job-card {
    background: white;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 1rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .job-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    transform: translateY(-2px);
  }

  .job-card.selected {
    border-color: #2196F3;
    background: #f3f9ff;
  }

  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .job-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .job-checkbox {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: #2196F3;
  }

  .status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .job-id {
    font-family: monospace;
    color: #666;
    font-size: 0.875rem;
  }

  .job-header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .delete-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    color: #999;
    font-size: 1rem;
    line-height: 1;
    transition: all 0.2s;
  }

  .delete-btn:hover {
    background: #f44336;
    border-color: #f44336;
    color: white;
  }

  .job-goal {
    font-weight: 500;
    margin-bottom: 0.5rem;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .job-meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: #666;
    margin-bottom: 0.5rem;
  }

  .job-time {
    font-size: 0.75rem;
    color: #999;
  }
</style>
