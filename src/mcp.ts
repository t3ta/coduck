import type { Server } from 'http';

import { startServer as startMcpServer } from './mcp/server.js';
import { startServer as startOrchestrator } from './orchestrator/server.js';
import { CodexWorker } from './worker/codex-worker.js';

let orchestratorServer: Server | null = null;
let worker: CodexWorker | null = null;
let shuttingDown = false;

const requestShutdown = (signal?: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (signal) {
    console.log(`\nReceived ${signal}. Shutting down...`);
  } else {
    console.log('Shutting down...');
  }

  // Stop worker polling
  if (worker) {
    worker.stop();
    console.log('Worker stopped.');
  }

  // Close orchestrator HTTP server
  if (orchestratorServer) {
    orchestratorServer.close(() => {
      console.log('Orchestrator stopped.');
    });
  }

  // MCP server runs on stdio, so we just exit
  process.exit(0);
};

const registerSignalHandlers = () => {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  signals.forEach((signal) => {
    process.on(signal, () => requestShutdown(signal));
  });
};

const main = async (): Promise<void> => {
  registerSignalHandlers();

  try {
    // 1. Start Orchestrator (HTTP API + SQLite)
    orchestratorServer = startOrchestrator();

    // 2. Start Worker (job polling)
    worker = new CodexWorker();
    // Start worker in background (don't await - it polls indefinitely)
    worker.start().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Worker error: ${message}`);
    });
    console.log('Worker started.');

    // 3. Start MCP Server (stdio transport - blocks until closed)
    await startMcpServer();
  } catch (error) {
    console.error('Failed to start:', error);
    process.exitCode = 1;
  }
};

void main();
