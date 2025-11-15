import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  worktreeBaseDir: string;
  codexCliPath: string;
  orchestratorPort: number;
  orchestratorUrl: string;
  workerPollIntervalMs: number;
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePort = (value: string | undefined, fallback: number): number => {
  return parseNumber(value, fallback);
};

const orchestratorPort = parsePort(process.env.ORCHESTRATOR_PORT, 3000);
const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? `http://localhost:${orchestratorPort}`;

export const appConfig: AppConfig = {
  worktreeBaseDir: process.env.WORKTREE_BASE_DIR ?? './worktrees',
  codexCliPath: process.env.CODEX_CLI_PATH ?? 'codex',
  orchestratorPort,
  orchestratorUrl,
  workerPollIntervalMs: parseNumber(process.env.WORKER_POLL_INTERVAL_MS, 5000),
};
