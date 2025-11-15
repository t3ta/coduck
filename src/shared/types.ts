export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

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
  status: JobStatus;
  spec_json: SpecJson;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}
