<script lang="ts">
  import type { Job } from '../lib/types';
  import { continueJob, resumeJob } from '../lib/api';
  import LogViewer from './LogViewer.svelte';

  type Props = {
    job: Job | null;
    onClose: () => void;
  };

  let { job, onClose }: Props = $props();

  type TabType = 'details' | 'logs';
  let activeTab = $state<TabType>('details');
  let resuming = $state(false);
  let resumeError = $state<string | null>(null);
  let continuePrompt = $state('');
  let continuing = $state(false);
  let continueError = $state<string | null>(null);

  // Reset continuation and resume state when job changes
  $effect(() => {
    if (job) {
      continuePrompt = '';
      continuing = false;
      continueError = null;
      resumeError = null;
    }
  });

  // Check if job is resumable (failed + timed_out + has conversation_id)
  function isResumable(job: Job | null): boolean {
    if (!job || job.status !== 'failed' || !job.conversation_id) return false;
    try {
      const summary = typeof job.result_summary === 'string'
        ? JSON.parse(job.result_summary)
        : job.result_summary;
      return summary?.codex?.timed_out === true;
    } catch {
      return false;
    }
  }

  function isContinuable(job: Job | null): boolean {
    if (!job || job.status !== 'failed' || !job.conversation_id) return false;
    try {
      const summary = typeof job.result_summary === 'string'
        ? JSON.parse(job.result_summary)
        : job.result_summary;
      return summary?.codex?.timed_out !== true;
    } catch {
      return false;
    }
  }

  async function handleResume() {
    if (!job) return;
    resuming = true;
    resumeError = null;
    try {
      await resumeJob(job.id);
      onClose();
    } catch (err) {
      resumeError = err instanceof Error ? err.message : String(err);
    } finally {
      resuming = false;
    }
  }

  async function handleContinue() {
    if (!job) return;
    if (!continuePrompt.trim()) {
      continueError = 'プロンプトを入力してください。';
      return;
    }
    continuing = true;
    continueError = null;
    try {
      await continueJob(job.id, continuePrompt.trim());
      onClose();
    } catch (err) {
      continueError = err instanceof Error ? err.message : String(err);
    } finally {
      continuing = false;
    }
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
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
</script>

<svelte:window onkeydown={handleEscape} />

{#if job}
  <div
    class="modal-backdrop"
    onclick={handleBackdropClick}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="ジョブ詳細"
    >
      <div class="modal-header">
        <div class="header-top">
          <h2>ジョブ詳細</h2>
          <button class="close-btn" onclick={onClose}>✕</button>
        </div>
        <div class="header-info">
          <span class="status-badge" style="background-color: {getStatusColor(job.status)}">
            {job.status}
          </span>
          <code class="job-id">{job.id}</code>
        </div>
      </div>

      <div class="tab-navigation">
        <button
          class="tab-btn"
          class:active={activeTab === 'details'}
          onclick={() => (activeTab = 'details')}
        >
          詳細
        </button>
        <button
          class="tab-btn"
          class:active={activeTab === 'logs'}
          onclick={() => (activeTab = 'logs')}
        >
          ログ
        </button>
      </div>

      <div class="modal-body">
        {#if activeTab === 'details'}
          <section class="section">
            <h3>基本情報</h3>
            <dl class="info-grid">
              <dt>Branch:</dt>
              <dd><code>{job.branch_name}</code></dd>

              <dt>Base Ref:</dt>
              <dd><code>{job.base_ref}</code></dd>

              <dt>Repo URL:</dt>
              <dd><code class="url">{job.repo_url}</code></dd>

              <dt>Worktree Path:</dt>
              <dd><code class="url">{job.worktree_path}</code></dd>

              <dt>Worker Type:</dt>
              <dd>{job.worker_type}</dd>

              <dt>Push Mode:</dt>
              <dd>{job.push_mode}</dd>

              {#if job.feature_id}
                <dt>Feature ID:</dt>
                <dd>{job.feature_id}</dd>
              {/if}

              {#if job.feature_part}
                <dt>Feature Part:</dt>
                <dd>{job.feature_part}</dd>
              {/if}

              <dt>Created:</dt>
              <dd>{formatDate(job.created_at)}</dd>

              <dt>Updated:</dt>
              <dd>{formatDate(job.updated_at)}</dd>
            </dl>
          </section>

          <section class="section">
            <h3>プロンプト</h3>
            <pre class="prompt">{job.spec_json.prompt}</pre>
          </section>

          {#if job.conversation_id}
            <section class="section">
              <h3>Conversation ID</h3>
              <code>{job.conversation_id}</code>
            </section>
          {/if}

          {#if job.result_summary}
            <section class="section">
              <h3>実行結果</h3>
              <pre class="json">{(() => {
                try {
                  const parsed = typeof job.result_summary === 'string'
                    ? JSON.parse(job.result_summary)
                    : job.result_summary;
                  return JSON.stringify(parsed, null, 2);
                } catch {
                  return job.result_summary;
                }
              })()}</pre>
            </section>
          {/if}

          {#if isContinuable(job)}
            <section class="section">
              <h3>ジョブ継続</h3>
              <p class="continue-description">このジョブは失敗しましたが、追加の指示で継続できます。</p>
              {#if continueError}
                <p class="continue-error">{continueError}</p>
              {/if}
              <textarea
                class="continue-textarea"
                bind:value={continuePrompt}
                placeholder="継続するための指示を入力"
                rows="4"
              ></textarea>
              <button
                class="continue-btn"
                onclick={handleContinue}
                disabled={continuing || !continuePrompt.trim()}
              >
                {continuing ? '送信中...' : '継続実行'}
              </button>
            </section>
          {/if}

          {#if isResumable(job)}
            <section class="section">
              <h3>タイムアウト継続</h3>
              <p class="resume-description">このジョブはタイムアウトしました。続きを実行できます。</p>
              {#if resumeError}
                <p class="resume-error">{resumeError}</p>
              {/if}
              <button class="resume-btn" onclick={handleResume} disabled={resuming}>
                {resuming ? '処理中...' : '続きを実行'}
              </button>
            </section>
          {/if}
        {:else if activeTab === 'logs'}
          <LogViewer jobId={job.id} />
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 2rem;
    animation: fadeIn 0.2s;
  }

  .tab-navigation {
    display: flex;
    gap: 0.5rem;
    padding: 1rem 2rem 0 2rem;
    background: white;
    border-bottom: 1px solid #ddd;
  }

  .tab-btn {
    padding: 0.75rem 1.5rem;
    background: transparent;
    border: none;
    border-bottom: 3px solid transparent;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
    color: #666;
    transition: all 0.2s;
  }

  .tab-btn:hover {
    color: #667eea;
    background: rgba(102, 126, 234, 0.05);
  }

  .tab-btn.active {
    color: #667eea;
    border-bottom-color: #667eea;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .modal {
    background: white;
    border-radius: 12px;
    max-width: 900px;
    width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    animation: slideUp 0.3s;
  }

  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .modal-header {
    padding: 1.5rem 2rem;
    border-bottom: 1px solid #ddd;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border-radius: 12px 12px 0 0;
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .header-top h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }

  .close-btn {
    background: rgba(255, 255, 255, 0.2);
    border: none;
    color: white;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .status-badge {
    padding: 0.375rem 0.75rem;
    border-radius: 12px;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .job-id {
    font-family: monospace;
    font-size: 0.875rem;
    background: rgba(255, 255, 255, 0.2);
    padding: 0.375rem 0.75rem;
    border-radius: 4px;
  }

  .modal-body {
    padding: 2rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section h3 {
    margin: 0;
    font-size: 1.125rem;
    color: #333;
    padding-bottom: 0.5rem;
    border-bottom: 2px solid #667eea;
  }

  .info-grid {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 0.75rem 1rem;
    margin: 0;
  }

  .info-grid dt {
    font-weight: 500;
    color: #666;
  }

  .info-grid dd {
    margin: 0;
    color: #333;
  }

  .info-grid code {
    background: #f5f5f5;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .info-grid code.url {
    display: block;
    overflow-x: auto;
    white-space: nowrap;
  }

  .prompt {
    margin: 0;
    padding: 1rem;
    background: #f5f5f5;
    border-left: 4px solid #667eea;
    border-radius: 4px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.875rem;
  }

  .json {
    margin: 0;
    padding: 1rem;
    background: #2d2d2d;
    color: #f8f8f2;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .continue-description {
    margin: 0 0 0.75rem 0;
    color: #555;
  }

  .continue-error {
    margin: 0 0 0.75rem 0;
    color: #d32f2f;
    padding: 0.5rem;
    background: #ffebee;
    border-radius: 4px;
  }

  .continue-textarea {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 0.95rem;
    font-family: inherit;
    resize: vertical;
    min-height: 120px;
    background: #fafafa;
  }

  .continue-btn {
    margin-top: 0.5rem;
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #2196f3 0%, #21cbf3 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .continue-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(33, 150, 243, 0.35);
  }

  .continue-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .resume-description {
    margin: 0 0 1rem 0;
    color: #666;
  }

  .resume-error {
    margin: 0 0 1rem 0;
    color: #f44336;
    padding: 0.5rem;
    background: #ffebee;
    border-radius: 4px;
  }

  .resume-btn {
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .resume-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .resume-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
