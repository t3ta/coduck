import { Router, type Request, type Response } from 'express';
import { orchestratorEvents } from '../events.js';

export const sseRouter = Router();

sseRouter.get('/events', (req: Request, res: Response) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial comment to establish connection
  res.write(': connected\n\n');

  // Listen to orchestrator events
  const unsubscribe = orchestratorEvents.on((event) => {
    res.write(`event: ${event.type}\n`);
    const data = 'data' in event ? event.data : {};
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });

  // Handle client disconnect
  req.on('close', () => {
    unsubscribe();
  });
});
