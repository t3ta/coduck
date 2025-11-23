<script lang="ts">
  import JobList from './components/JobList.svelte';
  import type { Job } from './lib/types';

  let selectedJob = $state<Job | null>(null);

  function handleSelectJob(job: Job) {
    selectedJob = job;
    console.log('Selected job:', job);
  }
</script>

<main>
  <header>
    <h1>Coduck Orchestrator</h1>
    <p class="subtitle">Job Management & Monitoring</p>
  </header>

  <div class="content">
    <JobList onSelectJob={handleSelectJob} />
  </div>
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

  .content {
    flex: 1;
    padding: 2rem;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
  }
</style>
