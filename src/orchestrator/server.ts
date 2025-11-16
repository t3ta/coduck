import express, { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { appConfig } from '../shared/config.js';
import jobsRouter from './routes/jobs.js';
import { router as featuresRouter } from './routes/features.js';
import worktreesRouter from './routes/worktrees.js';
import { initDb } from './db.js';

export const createApp = () => {
  const app = express();

  app.use(express.json());
  app.use('/jobs', jobsRouter);
  app.use('/features', featuresRouter);
  app.use('/worktrees', worktreesRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }

    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
};

export const startServer = () => {
  initDb();
  const app = createApp();
  const server = app.listen(appConfig.orchestratorPort, () => {
    console.log(`Orchestrator listening on port ${appConfig.orchestratorPort}`);
  });
  return server;
};
