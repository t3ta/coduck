import { Router } from 'express';

import { listJobs } from '../models/job.js';
import type { Job } from '../../shared/types.js';

export const router = Router();

router.get('/', (_req, res) => {
  try {
    const allJobs = listJobs();
    const featuredJobs = allJobs.filter((job) => job.feature_id !== null);

    const featureMap = new Map<string, Job[]>();
    for (const job of featuredJobs) {
      if (!job.feature_id) continue;
      if (!featureMap.has(job.feature_id)) {
        featureMap.set(job.feature_id, []);
      }
      featureMap.get(job.feature_id)!.push(job);
    }

    const features = Array.from(featureMap.entries()).map(([feature_id, jobs]) => {
      const statusCounts = jobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.status] = (acc[job.status] || 0) + 1;
        return acc;
      }, {});

      const parts = [...new Set(jobs.map((j) => j.feature_part).filter((part): part is string => part !== null))];
      const sortedByUpdated = [...jobs].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

      return {
        feature_id,
        job_count: jobs.length,
        status_counts: statusCounts,
        parts,
        created_at: jobs[0]?.created_at ?? null,
        updated_at: sortedByUpdated[0]?.updated_at ?? null,
      };
    });

    res.json(features);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/:feature_id', (req, res) => {
  try {
    const { feature_id } = req.params;
    const jobs = listJobs({ feature_id });

    if (jobs.length === 0) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    const jobSummaries = jobs.map((job) => {
      // Truncate prompt for display (first 200 chars)
      const promptPreview = job.spec_json.prompt.length > 200
        ? job.spec_json.prompt.slice(0, 200) + '...'
        : job.spec_json.prompt;
      return {
        id: job.id,
        status: job.status,
        feature_part: job.feature_part,
        branch_name: job.branch_name,
        created_at: job.created_at,
        updated_at: job.updated_at,
        depends_on: job.depends_on,
        spec_json: { prompt: promptPreview },
      };
    });

    res.json({
      feature_id,
      jobs: jobSummaries,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
