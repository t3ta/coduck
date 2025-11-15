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
  status: JobStatus;
  spec_json: SpecJson;
  result_summary: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}
