<script lang="ts">
  import { onMount } from 'svelte';
  import JobList from './components/JobList.svelte';
  import FeatureView from './components/FeatureView.svelte';
  import WorktreeManager from './components/WorktreeManager.svelte';
  import JobDetailModal from './components/JobDetailModal.svelte';
  import { sseClient } from './lib/sse';
  import { notificationManager } from './lib/notifications';
  import type { Job } from './lib/types';

  type Tab = 'jobs' | 'features' | 'worktrees';

  let activeTab = $state<Tab>('jobs');
  let selectedJob = $state<Job | null>(null);
  let showNotificationPrompt = $state(false);
  let previousJobStatuses = new Map<string, string>();

  function handleSelectJob(job: Job) {
    selectedJob = job;
  }

  function closeModal() {
    selectedJob = null;
  }

  async function enableNotifications() {
    const granted = await notificationManager.requestPermission();
    showNotificationPrompt = false;
    if (granted) {
      console.log('Notifications enabled');
    }
  }

  function dismissNotificationPrompt() {
    showNotificationPrompt = false;
    localStorage.setItem('notification-prompt-dismissed', 'true');
  }

  onMount(() => {
    // Show notification prompt if not dismissed before
    const dismissed = localStorage.getItem('notification-prompt-dismissed');
    if (!dismissed && Notification.permission === 'default') {
      setTimeout(() => {
        showNotificationPrompt = true;
      }, 2000);
    } else if (Notification.permission === 'granted') {
      notificationManager.requestPermission();
    }

    // Listen to SSE events for notifications
    sseClient.connect();
    const unsubscribe = sseClient.on((event) => {
      if (event.type === 'job_updated') {
        const job = event.data;
        const previousStatus = previousJobStatuses.get(job.id);

        // Notify on status change to done or failed
        if (previousStatus && previousStatus !== job.status) {
          if (job.status === 'done') {
            notificationManager.notify(job, 'completed');
          } else if (job.status === 'failed') {
            notificationManager.notify(job, 'failed');
          }
        }

        previousJobStatuses.set(job.id, job.status);
      }
    });

    return () => {
      unsubscribe();
    };
  });
</script>

<main>
  <header>
    <h1>Coduck Orchestrator</h1>
    <p class="subtitle">Job Management & Monitoring</p>
  </header>

  {#if showNotificationPrompt}
    <div class="notification-prompt">
      <div class="prompt-content">
        <span class="prompt-icon">🔔</span>
        <p>ジョブの完了や失敗をブラウザ通知で受け取りますか？</p>
        <div class="prompt-actions">
          <button class="btn-primary" onclick={enableNotifications}>有効にする</button>
          <button class="btn-secondary" onclick={dismissNotificationPrompt}>後で</button>
        </div>
      </div>
    </div>
  {/if}

  <nav class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'jobs'}
      onclick={() => (activeTab = 'jobs')}
    >
      ジョブ一覧
    </button>
    <button
      class="tab"
      class:active={activeTab === 'features'}
      onclick={() => (activeTab = 'features')}
    >
      Feature別
    </button>
    <button
      class="tab"
      class:active={activeTab === 'worktrees'}
      onclick={() => (activeTab = 'worktrees')}
    >
      Worktree管理
    </button>
  </nav>

  <div class="content">
    {#if activeTab === 'jobs'}
      <JobList onSelectJob={handleSelectJob} />
    {:else if activeTab === 'features'}
      <FeatureView onSelectJob={handleSelectJob} />
    {:else if activeTab === 'worktrees'}
      <WorktreeManager />
    {/if}
  </div>

  <JobDetailModal job={selectedJob} onClose={closeModal} />
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background-color: #f5f5f5;
  }

  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 2rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
    font-weight: 600;
  }

  .subtitle {
    margin: 0;
    opacity: 0.9;
    font-size: 1rem;
  }

  .tabs {
    display: flex;
    gap: 0;
    background: white;
    border-bottom: 2px solid #ddd;
    padding: 0 2rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  }

  .tab {
    padding: 1rem 2rem;
    background: transparent;
    border: none;
    border-bottom: 3px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
    color: #666;
    transition: all 0.2s;
    position: relative;
  }

  .tab:hover {
    color: #667eea;
    background: #f5f5f5;
  }

  .tab.active {
    color: #667eea;
    border-bottom-color: #667eea;
  }

  .content {
    flex: 1;
    padding: 2rem;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
  }

  .notification-prompt {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 1rem 2rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    animation: slideDown 0.3s ease-out;
  }

  @keyframes slideDown {
    from {
      transform: translateY(-100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .prompt-content {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .prompt-icon {
    font-size: 1.5rem;
  }

  .prompt-content p {
    flex: 1;
    margin: 0;
    font-size: 0.95rem;
  }

  .prompt-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-primary,
  .btn-secondary {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .btn-primary {
    background: white;
    color: #667eea;
  }

  .btn-primary:hover {
    background: #f5f5f5;
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .btn-secondary {
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }

  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.3);
  }
</style>
