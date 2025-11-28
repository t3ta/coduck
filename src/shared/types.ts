export type JobStatus = 'pending' | 'running' | 'awaiting_input' | 'done' | 'failed' | 'cancelled';

export interface SpecJson {
  goal: string;
  context_files: string[];
  notes?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
}

export interface Job {
  id: string;
  repo_url: string;
  base_ref: string;
  branch_name: string;
  worktree_path: string;
  worker_type: string;
  feature_id?: string | null;
  feature_part?: string | null;
  push_mode?: 'always' | 'never';
  use_worktree?: boolean; // Default: true
  status: JobStatus;
  spec_json: SpecJson;
  result_summary: string | null;
  conversation_id: string | null;
  resume_requested?: boolean;
  created_at: string;
  updated_at: string;
  depends_on?: string[]; // Job IDs this job depends on
}

export interface JobDependency {
  job_id: string;
  depends_on_job_id: string;
}

export interface ResultSummary extends Record<string, unknown> {
  git_skipped?: boolean;
  working_directory?: string;
  worktree_path?: string;
  commit_hash?: string | null;
  tests_passed?: boolean;
  message?: string;
  error?: string;
}

export type WorktreeState = 'orphaned' | 'in_use' | 'protected' | 'locked' | 'unmanaged';

export interface WorktreeJobSummary {
  id: string;
  status: JobStatus;
  feature_id: string | null;
  feature_part: string | null;
  updated_at: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
  managed: boolean;
  jobs: WorktreeJobSummary[];
  state: WorktreeState;
  deletable: boolean;
  blockedReasons: string[];
}

export interface WorktreeCleanupResponse {
  removed: string[];
  failures: Array<{ path: string; error: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

export interface WorktreeDeletionResponse {
  removed: boolean;
  worktree: WorktreeInfo;
}
