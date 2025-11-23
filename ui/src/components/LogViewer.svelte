<script lang="ts">
  import { onMount } from 'svelte';
  import { sseClient } from '../lib/sse';
  import { getJobLogs } from '../lib/api';
  import type { LogEntry } from '../lib/types';

  type Props = {
    jobId: string;
  };

  let { jobId }: Props = $props();

  type StreamFilter = 'all' | 'stdout' | 'stderr';
  let streamFilter = $state<StreamFilter>('all');
  let logLines = $state<LogEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let autoScroll = $state(true);
  let logContainer: HTMLDivElement;

  const filteredLogs = $derived(
    streamFilter === 'all'
      ? logLines
      : logLines.filter((log) => log.stream === streamFilter)
  );

  function scrollToBottom() {
    if (autoScroll && logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  $effect(() => {
    // Trigger scroll when filtered logs change
    filteredLogs;
    setTimeout(scrollToBottom, 0);
  });

  onMount(async () => {
    // Fetch logs on mount
    try {
      loading = true;
      logLines = await getJobLogs(jobId);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load logs';
    } finally {
      loading = false;
    }

    // Listen for new logs via SSE
    const unsubscribe = sseClient.on((event) => {
      if (event.type === 'log_appended' && event.data.jobId === jobId) {
        logLines = [
          ...logLines,
          {
            stream: event.data.stream,
            text: event.data.text,
            timestamp: new Date().toISOString(),
          },
        ];
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="log-viewer">
  <div class="log-header">
    <div class="filter-buttons">
      <button
        class="filter-btn"
        class:active={streamFilter === 'all'}
        onclick={() => (streamFilter = 'all')}
      >
        All
      </button>
      <button
        class="filter-btn"
        class:active={streamFilter === 'stdout'}
        onclick={() => (streamFilter = 'stdout')}
      >
        stdout
      </button>
      <button
        class="filter-btn"
        class:active={streamFilter === 'stderr'}
        onclick={() => (streamFilter = 'stderr')}
      >
        stderr
      </button>
    </div>
    <label class="auto-scroll">
      <input type="checkbox" bind:checked={autoScroll} />
      Auto-scroll
    </label>
  </div>

  <div class="log-container" bind:this={logContainer}>
    {#if loading}
      <div class="empty-message">Loading logs...</div>
    {:else if error}
      <div class="empty-message error">{error}</div>
    {:else if filteredLogs.length === 0}
      <div class="empty-message">No logs available</div>
    {:else}
      {#each filteredLogs as log (log.timestamp + log.text)}
        <div class="log-line" class:stdout={log.stream === 'stdout'} class:stderr={log.stream === 'stderr'}>
          <span class="stream-badge">{log.stream}</span>
          <span class="log-text">{log.text}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .log-viewer {
    display: flex;
    flex-direction: column;
    height: 60vh;
    border: 1px solid #ddd;
    border-radius: 4px;
    overflow: hidden;
  }

  .log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: #f5f5f5;
    border-bottom: 1px solid #ddd;
  }

  .filter-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .filter-btn {
    padding: 0.375rem 0.75rem;
    background: white;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .filter-btn:hover {
    background: #e9ecef;
  }

  .filter-btn.active {
    background: #667eea;
    color: white;
    border-color: #667eea;
  }

  .auto-scroll {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    cursor: pointer;
  }

  .auto-scroll input {
    cursor: pointer;
  }

  .log-container {
    flex: 1;
    overflow-y: auto;
    background: #2d2d2d;
    color: #f8f8f2;
    font-family: 'Courier New', Courier, monospace;
    font-size: 0.875rem;
    padding: 0.5rem;
    line-height: 1.5;
  }

  .empty-message {
    padding: 2rem;
    text-align: center;
    color: #999;
  }

  .empty-message.error {
    color: #f44336;
  }

  .log-line {
    display: flex;
    gap: 0.5rem;
    padding: 0.25rem 0;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  .stream-badge {
    flex-shrink: 0;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
  }

  .log-line.stdout .stream-badge {
    background: #4CAF50;
    color: white;
  }

  .log-line.stderr .stream-badge {
    background: #FF9800;
    color: white;
  }

  .log-text {
    flex: 1;
    word-break: break-all;
  }
</style>
