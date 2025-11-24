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
  console.log('=== createApp() called ===');
  const app = express();

  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  // API routes
  app.use('/jobs', jobsRouter);
  app.use('/features', featuresRouter);
  app.use('/worktrees', worktreesRouter);
  app.use(sseRouter);

  // Serve static files from dist/public
  // Use absolute path based on project root
  const projectRoot = path.join(__dirname, '../..');
  const publicDir = path.join(projectRoot, 'dist/public');
  console.log('Serving static files from:', publicDir);
  app.use(express.static(publicDir));

  // Fallback to index.html for SPA routes (non-API requests)
  app.use((req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/jobs') ||
        req.path.startsWith('/features') ||
        req.path.startsWith('/worktrees') ||
        req.path.startsWith('/events')) {
      return next();
    }
    // For non-API GET requests, serve index.html
    if (req.method === 'GET') {
      return res.sendFile(path.join(publicDir, 'index.html'), (err) => {
        if (err) {
          console.error('Error sending index.html:', err);
          next(err);
        }
      });
    }
    next();
  });

  // 404 handler - must be after all routes
  app.use((_req: Request, res: Response) => {
    console.log('=== 404 handler called ===');
    return res.status(404).json({ error: 'Not found' });
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
      console.log(`🚀 Orchestrator listening on http://localhost:${appConfig.orchestratorPort}`);
      resolve(server);
    });
  });
};
