<script lang="ts">
  import { onMount } from 'svelte';
  import { listFeatures, getFeature } from '../lib/api';
  import { sseClient } from '../lib/sse';
  import type { Feature, FeatureDetail, Job } from '../lib/types';
  import DagGraph from './DagGraph.svelte';

  type Props = {
    onSelectJob?: (job: Job) => void;
  };

  let { onSelectJob = undefined }: Props = $props();

  let features = $state<Feature[]>([]);
  let expandedFeature = $state<string | null>(null);
  let featureDetails = $state<Map<string, FeatureDetail>>(new Map());
  let viewModes = $state<Record<string, 'dag' | 'list'>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function fetchFeatures() {
    try {
      loading = true;
      const result = await listFeatures();
      features = result;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to fetch features';
    } finally {
      loading = false;
    }
  }

  async function toggleFeature(featureId: string) {
    if (expandedFeature === featureId) {
      expandedFeature = null;
      return;
    }

    expandedFeature = featureId;
    if (!featureDetails.has(featureId)) {
      try {
        const detail = await getFeature(featureId);
        featureDetails.set(featureId, detail);
        featureDetails = new Map(featureDetails);
      } catch (err) {
        console.error('Failed to fetch feature details:', err);
      }
    }
  }

  function setViewMode(featureId: string, mode: 'dag' | 'list') {
    viewModes = { ...viewModes, [featureId]: mode };
  }

  function getViewMode(featureId: string): 'dag' | 'list' {
    return viewModes[featureId] ?? 'dag';
  }

  function getStatusCount(feature: Feature, status: string): number {
    return feature.status_counts[status] || 0;
  }

  function getProgressPercent(feature: Feature): number {
    if (feature.job_count === 0) return 0;
    return Math.round((getStatusCount(feature, 'done') / feature.job_count) * 100);
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function getStatusColor(status: string): string {
    const colors: Record<string, string> = {
      pending: '#999',
      running: '#2196F3',
      done: '#4CAF50',
      failed: '#f44336',
      awaiting_input: '#FF9800',
      cancelled: '#757575',
    };
    return colors[status] || '#666';
  }

  function handleNodeClick(featureId: string, jobId: string) {
    const detail = featureDetails.get(featureId);
    const job = detail?.jobs.find((item) => item.id === jobId);
    if (job) {
      onSelectJob?.(job);
    }
  }

  function handleJobKeyDown(event: KeyboardEvent, job: Job) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectJob?.(job);
    }
  }

  onMount(() => {
    fetchFeatures();
    sseClient.connect();

    const unsubscribe = sseClient.on((event) => {
      if (event.type === 'job_created' || event.type === 'job_updated') {
        fetchFeatures(); // Refresh feature list
        if (event.data.feature_id && featureDetails.has(event.data.feature_id)) {
          getFeature(event.data.feature_id).then((detail) => {
            featureDetails.set(event.data.feature_id!, detail);
            featureDetails = new Map(featureDetails);
          });
        }
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="feature-view">
  {#if loading}
    <p class="message">Loading features...</p>
  {:else if error}
    <p class="message error">{error}</p>
  {:else if features.length === 0}
    <p class="message">No features found</p>
  {:else}
    <div class="features">
      {#each features as feature (feature.feature_id)}
        <div class="feature-card">
          <button class="feature-header" onclick={() => toggleFeature(feature.feature_id)}>
            <div class="feature-title">
              <h3>{feature.feature_id}</h3>
              <span class="job-count">{feature.job_count} jobs</span>
            </div>
            <div class="feature-stats">
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  style="width: {getProgressPercent(feature)}%"
                ></div>
              </div>
              <div class="stat-badges">
                {#if getStatusCount(feature, 'pending') > 0}
                  <span class="badge pending">{getStatusCount(feature, 'pending')} pending</span>
                {/if}
                {#if getStatusCount(feature, 'running') > 0}
                  <span class="badge running">{getStatusCount(feature, 'running')} running</span>
                {/if}
                {#if getStatusCount(feature, 'awaiting_input') > 0}
                  <span class="badge awaiting">{getStatusCount(feature, 'awaiting_input')} awaiting</span>
                {/if}
                <span class="badge done">{getStatusCount(feature, 'done')} done</span>
                {#if getStatusCount(feature, 'failed') > 0}
                  <span class="badge failed">{getStatusCount(feature, 'failed')} failed</span>
                {/if}
              </div>
            </div>
            <span class="expand-icon">{expandedFeature === feature.feature_id ? '▼' : '▶'}</span>
          </button>

          {#if expandedFeature === feature.feature_id}
            <div class="feature-details">
              {#if featureDetails.has(feature.feature_id)}
                {@const detail = featureDetails.get(feature.feature_id)!}
                {@const currentViewMode = getViewMode(feature.feature_id)}
                <div class="view-toggle" role="tablist" aria-label="View mode toggle">
                  <button
                    type="button"
                    class="toggle-button"
                    class:active={currentViewMode === 'dag'}
                    role="tab"
                    aria-selected={currentViewMode === 'dag'}
                    onclick={() => setViewMode(feature.feature_id, 'dag')}
                  >
                    DAGグラフ
                  </button>
                  <button
                    type="button"
                    class="toggle-button"
                    class:active={currentViewMode === 'list'}
                    role="tab"
                    aria-selected={currentViewMode === 'list'}
                    onclick={() => setViewMode(feature.feature_id, 'list')}
                  >
                    リスト
                  </button>
                </div>

                {#if currentViewMode === 'dag'}
                  <DagGraph
                    jobs={detail.jobs}
                    onNodeClick={(jobId) => handleNodeClick(feature.feature_id, jobId)}
                  />
                {:else}
                  <div class="jobs-list">
                    {#each detail.jobs as job (job.id)}
                      <div
                        class="job-item"
                        role="button"
                        tabindex="0"
                        onclick={() => onSelectJob?.(job)}
                        onkeydown={(event) => handleJobKeyDown(event, job)}
                      >
                        <span class="job-status" style="background-color: {getStatusColor(job.status)}">
                          {job.status}
                        </span>
                        <span class="job-part">{job.feature_part || 'N/A'}</span>
                        <span class="job-goal">{job.spec_json.prompt}</span>
                        <span class="job-time">{formatDate(job.created_at)}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              {:else}
                <p class="loading-details">Loading details...</p>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .feature-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .message {
    padding: 2rem;
    text-align: center;
    color: #666;
  }

  .message.error {
    color: #f44336;
  }

  .features {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .feature-card {
    background: white;
    border: 1px solid #ddd;
    border-radius: 8px;
    overflow: hidden;
  }

  .feature-header {
    width: 100%;
    padding: 1.5rem;
    background: white;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 1rem;
    transition: background 0.2s;
  }

  .feature-header:hover {
    background: #f5f5f5;
  }

  .feature-title {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .feature-title h3 {
    margin: 0;
    font-size: 1.125rem;
    color: #333;
  }

  .job-count {
    font-size: 0.875rem;
    color: #666;
  }

  .feature-stats {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .progress-bar {
    height: 8px;
    background: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4CAF50, #8BC34A);
    transition: width 0.3s;
  }

  .stat-badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 500;
    color: white;
  }

  .badge.pending {
    background: #999;
  }

  .badge.running {
    background: #2196F3;
  }

  .badge.awaiting {
    background: #FF9800;
  }

  .badge.done {
    background: #4CAF50;
  }

  .badge.failed {
    background: #f44336;
  }

  .expand-icon {
    color: #666;
    font-size: 0.875rem;
  }

  .feature-details {
    border-top: 1px solid #ddd;
    padding: 1rem;
    background: #fafafa;
  }

  .view-toggle {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.25rem;
    background: #f4f6fb;
    border: 1px solid #dce3f0;
    border-radius: 10px;
    margin-bottom: 1rem;
  }

  .toggle-button {
    padding: 0.45rem 0.9rem;
    border: none;
    background: transparent;
    color: #4a5568;
    font-size: 0.9rem;
    font-weight: 700;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s, color 0.2s, box-shadow 0.2s;
  }

  .toggle-button:hover {
    background: #e4edfb;
    color: #1f7aee;
  }

  .toggle-button.active {
    background: #1f7aee;
    color: #fff;
    box-shadow: 0 4px 10px rgba(31, 122, 238, 0.25);
  }

  .loading-details {
    text-align: center;
    color: #666;
    padding: 1rem;
  }

  .jobs-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .job-item {
    display: grid;
    grid-template-columns: 120px 150px 1fr 120px;
    gap: 1rem;
    padding: 0.75rem;
    background: white;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
    align-items: center;
  }

  .job-item:hover {
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    transform: translateX(4px);
  }

  .job-status {
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    color: white;
    font-size: 0.75rem;
    font-weight: 500;
    text-align: center;
  }

  .job-part {
    font-weight: 500;
    color: #666;
    font-size: 0.875rem;
  }

  .job-goal {
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-time {
    font-size: 0.75rem;
    color: #999;
    text-align: right;
  }
</style>
