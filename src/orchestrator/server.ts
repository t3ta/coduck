import express, { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

import { appConfig } from '../shared/config.js';
import jobsRouter from './routes/jobs.js';
import { router as featuresRouter } from './routes/features.js';
import worktreesRouter from './routes/worktrees.js';
import { sseRouter } from './routes/sse.js';
import { initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const createApp = () => {
  const app = express();

  app.use(express.json());

  // API routes
  app.use('/jobs', jobsRouter);
  app.use('/features', featuresRouter);
  app.use('/worktrees', worktreesRouter);
  app.use(sseRouter);

  // Serve static files from dist/public
  const publicDir = path.join(__dirname, '../../dist/public');
  app.use(express.static(publicDir));

  // Fallback to index.html for SPA routes
  app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/jobs') ||
        req.path.startsWith('/features') ||
        req.path.startsWith('/worktrees') ||
        req.path.startsWith('/events')) {
      return next();
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

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

export const startServer = (): Promise<import('http').Server> => {
  return new Promise((resolve) => {
    initDb();
    const app = createApp();
    const server = app.listen(appConfig.orchestratorPort, () => {
      resolve(server);
    });
  });
};
