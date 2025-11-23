// Re-export types from shared
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
  feature_id: string | null;
  feature_part: string | null;
  push_mode: 'always' | 'never';
  status: JobStatus;
  spec_json: SpecJson;
  result_summary: unknown | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Feature {
  feature_id: string;
  job_count: number;
  status_counts: Record<string, number>;
  parts: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface FeatureDetail {
  feature_id: string;
  jobs: Job[];
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
