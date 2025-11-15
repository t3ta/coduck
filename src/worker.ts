import { CodexWorker } from './worker/codex-worker.js';

const worker = new CodexWorker();
let shuttingDown = false;

const requestShutdown = (signal?: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (signal) {
    console.log(`Received ${signal}. Stopping Codex worker...`);
  } else {
    console.log('Stopping Codex worker...');
  }
  worker.stop();
};

const registerSignalHandlers = () => {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  signals.forEach((signal) => {
    process.on(signal, () => requestShutdown(signal));
  });
};

const main = async () => {
  registerSignalHandlers();

  try {
    await worker.start();
    if (shuttingDown) {
      console.log('Codex worker shut down gracefully.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Codex worker encountered an error: ${message}`);
    process.exitCode = 1;
  }
};

main();
