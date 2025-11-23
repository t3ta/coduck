// Import config FIRST to redirect stdout before any other modules load
import './shared/config.js';

import type { Server } from 'http';

import { startServer as startMcpServer } from './mcp/server.js';
import { startServer as startOrchestrator } from './orchestrator/server.js';
import { CodexWorker } from './worker/codex-worker.js';

let orchestratorServer: Server | null = null;
let worker: CodexWorker | null = null;
let workerPromise: Promise<void> | null = null;
let shuttingDown = false;

const requestShutdown = async (signal?: NodeJS.Signals, exitCode = 0): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  // Stop worker polling and wait for current job to finish
  if (worker) {
    worker.stop();
    if (workerPromise) {
      await workerPromise;
    }
  }

  // Close orchestrator HTTP server
  if (orchestratorServer) {
    await new Promise<void>((resolve) => {
      orchestratorServer!.close(() => {
        resolve();
      });
    });
  }

  process.exit(exitCode);
};

const registerSignalHandlers = () => {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  signals.forEach((signal) => {
    process.on(signal, () => {
      void requestShutdown(signal);
    });
  });
};

const main = async (): Promise<void> => {
  registerSignalHandlers();

  try {
    // Start Orchestrator (HTTP API + SQLite) and wait for it to be ready
    orchestratorServer = await startOrchestrator();

    // Start Worker (job polling) BEFORE MCP server
    worker = new CodexWorker();
    workerPromise = worker.start().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Worker error: ${message}`);
      void requestShutdown(undefined, 1);
    });

    // Start MCP Server last (blocks until closed)
    await startMcpServer();

    // MCP server closed normally, shutdown other services
    await requestShutdown();
  } catch (error) {
    console.error('Failed to start:', error);
    await requestShutdown(undefined, 1);
  }
};

void main();
