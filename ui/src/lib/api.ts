import type { Job, Feature, FeatureDetail, WorktreeInfo } from './types';

const API_BASE = '';

export async function listJobs(params?: {
  status?: string;
  worker_type?: string;
  feature_id?: string;
}): Promise<{ jobs: Job[] }> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.worker_type) query.set('worker_type', params.worker_type);
  if (params?.feature_id) query.set('feature_id', params.feature_id);

  const url = `${API_BASE}/jobs${query.toString() ? '?' + query.toString() : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.statusText}`);
  return res.json();
}

export async function getJob(id: string): Promise<{ job: Job }> {
  const res = await fetch(`${API_BASE}/jobs/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch job: ${res.statusText}`);
  return res.json();
}

export async function deleteJob(id: string): Promise<{ job: Job }> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete job: ${res.statusText}`);
  return res.json();
}

export async function listFeatures(): Promise<{ features: Feature[] }> {
  const res = await fetch(`${API_BASE}/features`);
  if (!res.ok) throw new Error(`Failed to fetch features: ${res.statusText}`);
  return res.json();
}

export async function getFeature(featureId: string): Promise<FeatureDetail> {
  const res = await fetch(`${API_BASE}/features/${featureId}`);
  if (!res.ok) throw new Error(`Failed to fetch feature: ${res.statusText}`);
  return res.json();
}

export async function listWorktrees(): Promise<{ worktrees: WorktreeInfo[] }> {
  const res = await fetch(`${API_BASE}/worktrees`);
  if (!res.ok) throw new Error(`Failed to fetch worktrees: ${res.statusText}`);
  return res.json();
}

export async function deleteWorktree(encodedPath: string): Promise<void> {
  const res = await fetch(`${API_BASE}/worktrees/${encodedPath}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete worktree: ${res.statusText}`);
}

export async function cleanupWorktrees(): Promise<{ deleted: string[] }> {
  const res = await fetch(`${API_BASE}/worktrees/cleanup`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to cleanup worktrees: ${res.statusText}`);
  return res.json();
}
