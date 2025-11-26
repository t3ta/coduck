import dotenv from 'dotenv';

// Suppress stdout pollution to keep MCP stdio clean
// MCP uses stdio for JSON-RPC communication, so ANY output to stdout will break the protocol
// We redirect console.log to console.error, but keep process.stdout.write intact
// so that the MCP SDK can write JSON-RPC messages to stdout
console.log = console.error;

// Use quiet mode to suppress dotenv banner messages
dotenv.config({ debug: false, quiet: true });

export interface AppConfig {
  worktreeBaseDir: string;
  codexCliPath: string;
  gitPath: string;
  orchestratorPort: number;
  orchestratorUrl: string;
  workerPollIntervalMs: number;
  workerConcurrency: number;
  codexMcpTimeoutMs: number;
  /** Codex reasoning summary level: auto | concise | detailed */
  codexReasoningSummary?: string;
  /** Codex reasoning format: none | experimental */
  codexReasoningFormat?: string;
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
const gitPath = process.env.GIT_PATH?.trim() || 'git';

export const appConfig: AppConfig = {
  worktreeBaseDir: process.env.WORKTREE_BASE_DIR ?? './worktrees',
  codexCliPath: process.env.CODEX_CLI_PATH ?? 'codex',
  gitPath,
  orchestratorPort,
  orchestratorUrl,
  workerPollIntervalMs: parseNumber(process.env.WORKER_POLL_INTERVAL_MS, 5000),
  workerConcurrency: parseNumber(process.env.WORKER_CONCURRENCY, 3),
  codexMcpTimeoutMs: parseNumber(process.env.CODEX_MCP_TIMEOUT_MS, 3600000),
  codexReasoningSummary: process.env.CODEX_REASONING_SUMMARY || undefined,
  codexReasoningFormat: process.env.CODEX_REASONING_FORMAT || undefined,
};
