<script lang="ts">
  import JobList from './components/JobList.svelte';
  import FeatureView from './components/FeatureView.svelte';
  import WorktreeManager from './components/WorktreeManager.svelte';
  import JobDetailModal from './components/JobDetailModal.svelte';
  import type { Job } from './lib/types';

  type Tab = 'jobs' | 'features' | 'worktrees';

  let activeTab = $state<Tab>('jobs');
  let selectedJob = $state<Job | null>(null);

  function handleSelectJob(job: Job) {
    selectedJob = job;
  }

  function closeModal() {
    selectedJob = null;
  }
</script>

<main>
  <header>
    <h1>Coduck Orchestrator</h1>
    <p class="subtitle">Job Management & Monitoring</p>
  </header>

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
      onclick={() => (activeTab === 'worktrees')}
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
</style>
