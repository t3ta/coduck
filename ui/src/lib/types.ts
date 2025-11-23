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
  total_jobs: number;
  pending: number;
  running: number;
  awaiting_input: number;
  done: number;
  failed: number;
  cancelled: number;
}

export interface FeatureDetail extends Feature {
  jobs: Job[];
}

export interface WorktreeInfo {
  path: string;
  status: 'orphaned' | 'in_use' | 'protected' | 'locked' | 'unmanaged';
  jobs: Job[];
}
