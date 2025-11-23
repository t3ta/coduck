<script lang="ts">
  import { onMount } from 'svelte';
  import { listJobs } from '../lib/api';
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
      const result = await listJobs();
      jobs = result.jobs;
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

  function handleJobClick(job: Job) {
    onSelectJob?.(job);
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

  {#if loading}
    <p class="message">Loading jobs...</p>
  {:else if error}
    <p class="message error">{error}</p>
  {:else if filteredJobs.length === 0}
    <p class="message">No jobs found</p>
  {:else}
    <div class="jobs">
      {#each filteredJobs as job (job.id)}
        <div class="job-card" onclick={() => handleJobClick(job)}>
          <div class="job-header">
            <span
              class="status-badge"
              style="background-color: {getStatusColor(job.status)}"
            >
              {job.status}
            </span>
            <span class="job-id">{job.id.slice(0, 8)}</span>
          </div>
          <div class="job-goal">{job.spec_json.goal}</div>
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

  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
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
