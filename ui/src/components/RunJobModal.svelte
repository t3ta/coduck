<script lang="ts">
  import { createJob } from '../lib/api';

  interface Props {
    onClose: () => void;
    onSuccess: () => void;
  }

  let { onClose, onSuccess }: Props = $props();

  let prompt = $state('');
  let repoUrl = $state('');
  let branchName = $state('');
  let baseRef = $state('main');
  let useWorktree = $state(true);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!prompt || !repoUrl || !branchName) return;

    try {
      loading = true;
      error = null;

      await createJob({
        repo_url: repoUrl,
        base_ref: baseRef,
        branch_name: branchName,
        worktree_path: useWorktree ? `worktree-${Date.now()}-${Math.random().toString(36).substring(2, 8)}` : '',
        worker_type: 'codex', // Default per plan
        spec_json: { prompt },
        push_mode: 'always',
        use_worktree: useWorktree,
      });

      onSuccess();
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create job';
    } finally {
      loading = false;
    }
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleEscape} />

<div class="modal-backdrop" onclick={onClose}>
  <div class="modal-content" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
    <header>
      <h2>Run Agent</h2>
      <button class="close-btn" onclick={onClose}>&times;</button>
    </header>

    <form onsubmit={handleSubmit}>
      <div class="form-group">
        <label for="repo-url">Repository URL *</label>
        <input
          id="repo-url"
          type="text"
          bind:value={repoUrl}
          placeholder="/absolute/path/to/repo"
          required
        />
        <small>Absolute path to local repo or git URL</small>
      </div>

      <div class="form-row">
        <div class="form-group half">
          <label for="branch-name">Branch Name *</label>
          <input
            id="branch-name"
            type="text"
            bind:value={branchName}
            placeholder="feature/new-feature"
            required
          />
        </div>
        <div class="form-group half">
          <label for="base-ref">Base Ref</label>
          <input
            id="base-ref"
            type="text"
            bind:value={baseRef}
            placeholder="main"
          />
        </div>
      </div>

      <div class="form-group checkbox">
        <label>
          <input type="checkbox" bind:checked={useWorktree} />
          Use Worktree (Safe Mode)
        </label>
      </div>

      <div class="form-group">
        <label for="prompt">Goal / Prompt *</label>
        <textarea
          id="prompt"
          bind:value={prompt}
          rows="6"
          placeholder="Describe what the agent should do..."
          required
        ></textarea>
      </div>

      {#if error}
        <div class="error-message">{error}</div>
      {/if}

      <div class="actions">
        <button type="button" class="btn-secondary" onclick={onClose} disabled={loading}>
          Cancel
        </button>
        <button type="submit" class="btn-primary" disabled={loading}>
          {loading ? 'Starting...' : 'Run Agent'}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }

  .modal-content {
    background: white;
    border-radius: 8px;
    width: 90%;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #eee;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    color: #333;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #666;
    padding: 0;
    line-height: 1;
  }

  form {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-row {
    display: flex;
    gap: 1rem;
  }

  .half {
    flex: 1;
  }

  label {
    font-weight: 500;
    color: #444;
    font-size: 0.9rem;
  }

  input[type="text"],
  textarea {
    padding: 0.75rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
    transition: border-color 0.2s;
  }

  input[type="text"]:focus,
  textarea:focus {
    border-color: #667eea;
    outline: none;
  }

  small {
    color: #777;
    font-size: 0.8rem;
  }

  .checkbox label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: normal;
  }

  .error-message {
    color: #dc2626;
    background: #fee2e2;
    padding: 0.75rem;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    margin-top: 0.5rem;
  }

  .btn-primary,
  .btn-secondary {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .btn-primary {
    background: #667eea;
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: #5a67d8;
  }

  .btn-secondary {
    background: #e2e8f0;
    color: #4a5568;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #cbd5e0;
  }

  button:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
</style>
