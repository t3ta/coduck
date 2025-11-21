import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appConfig } from './config.js';

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

const DEFAULT_SANDBOX: SandboxMode = 'workspace-write';
const DEFAULT_APPROVAL: ApprovalPolicy = 'never';

export interface CodexExecOptions {
  prompt: string;
  worktreePath: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  config?: Record<string, unknown>;
}

export interface CodexResumeOptions {
  sessionId: string;
  prompt: string;
  worktreePath: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  config?: Record<string, unknown>;
}

export interface CodexExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sessionId?: string;
  awaitingInput?: boolean;
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether the process was killed due to timeout */
  timedOut?: boolean;
}

/**
 * Extract session ID from the latest Codex session file.
 * Looks for files created/modified after the given timestamp.
 */
export const extractLatestSessionId = (afterTimestamp: number): string | undefined => {
  try {
    const sessionsBase = join(homedir(), '.codex', 'sessions');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const todayPath = join(sessionsBase, String(year), month, day);

    try {
      const files = readdirSync(todayPath);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      const recentFiles: Array<{ file: string; mtime: number }> = [];
      for (const file of sessionFiles) {
        const filePath = join(todayPath, file);
        const stat = statSync(filePath);
        const mtimeSeconds = Math.floor(stat.mtimeMs / 1000);

        if (mtimeSeconds >= afterTimestamp) {
          recentFiles.push({ file, mtime: mtimeSeconds });
        }
      }

      if (recentFiles.length === 0) {
        return undefined;
      }

      recentFiles.sort((a, b) => b.mtime - a.mtime);

      // Extract session_id from filename: rollout-YYYY-MM-DDTHH-MM-SS-<session_id>.jsonl
      const latestFile = recentFiles[0].file;
      const match = latestFile.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);

      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // Directory doesn't exist or other error
    }

    return undefined;
  } catch (error) {
    console.error('[WARN] Failed to extract session ID:', error);
    return undefined;
  }
};

/**
 * Build the config object to pass to Codex CLI.
 */
const buildCodexConfig = (userConfig?: Record<string, unknown>): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    ...userConfig,
  };

  // Add reasoning settings from environment if not already specified
  if (appConfig.codexReasoningSummary && !config.model_reasoning_summary) {
    config.model_reasoning_summary = appConfig.codexReasoningSummary;
  }

  if (appConfig.codexReasoningFormat && !config.model_reasoning_summary_format) {
    config.model_reasoning_summary_format = appConfig.codexReasoningFormat;
  }

  return config;
};

/**
 * Parse session ID from Codex JSON output.
 * Codex outputs JSON lines with various event types including session info.
 */
const parseSessionIdFromOutput = (output: string): string | undefined => {
  // Try to find session_id in JSON output lines
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Look for session_id in various possible locations
      if (typeof parsed.session_id === 'string') {
        return parsed.session_id;
      }
      if (typeof parsed.sessionId === 'string') {
        return parsed.sessionId;
      }
      // Check nested structures
      if (parsed.data && typeof parsed.data === 'object') {
        const data = parsed.data as Record<string, unknown>;
        if (typeof data.session_id === 'string') {
          return data.session_id;
        }
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return undefined;
};

/**
 * Execute `codex exec` command and stream output in real-time.
 */
export const execCodex = (options: CodexExecOptions): Promise<CodexExecResult> => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const beforeTimestamp = Math.floor(startTime / 1000);
    const timeoutMs = appConfig.codexMcpTimeoutMs;
    let timedOut = false;
    let resolved = false;

    const args = ['exec'];

    // Add sandbox mode
    args.push('--sandbox', options.sandbox ?? DEFAULT_SANDBOX);

    // Add approval policy
    args.push('--ask-for-approval', options.approvalPolicy ?? DEFAULT_APPROVAL);

    // Add config if present
    const config = buildCodexConfig(options.config);
    if (Object.keys(config).length > 0) {
      args.push('--config', JSON.stringify(config));
    }

    // Add the prompt
    args.push(options.prompt);

    console.log(`[CODEX] Executing: ${appConfig.codexCliPath} ${args.slice(0, 3).join(' ')} ... (timeout: ${timeoutMs}ms)`);

    const child = spawn(appConfig.codexCliPath, args, {
      cwd: options.worktreePath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        console.error(`[CODEX] Timeout after ${timeoutMs}ms, killing process...`);
        child.kill('SIGTERM');
        // Force kill if SIGTERM doesn't work
        setTimeout(() => {
          if (!resolved) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Stream to console in real-time
      process.stdout.write(`[CODEX stdout] ${text}`);
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Stream to console in real-time (this is where thinking/progress appears)
      process.stderr.write(`[CODEX stderr] ${text}`);
    });

    child.on('error', (error) => {
      clearTimeout(timeoutHandle);
      resolved = true;
      const durationMs = Date.now() - startTime;
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr,
        durationMs,
        error: `Failed to spawn Codex: ${error.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolved = true;
      const durationMs = Date.now() - startTime;
      // Try to parse session ID from output first (more reliable for concurrent execution)
      // Fall back to file system scanning if not found
      const sessionId = parseSessionIdFromOutput(stdout) ??
                        parseSessionIdFromOutput(stderr) ??
                        extractLatestSessionId(beforeTimestamp);

      if (sessionId) {
        console.log(`[CODEX] Session ID: ${sessionId}`);
      }
      console.log(`[CODEX] Completed in ${(durationMs / 1000).toFixed(1)}s`);

      // Check if awaiting input (Codex might signal this via exit code or stderr)
      const awaitingInput = stderr.includes('awaiting') || stderr.includes('waiting for input');

      if (timedOut) {
        resolve({
          success: false,
          exitCode: code,
          stdout,
          stderr,
          sessionId,
          durationMs,
          timedOut: true,
          error: `Codex timed out after ${timeoutMs}ms`,
        });
      } else if (code === 0) {
        resolve({
          success: true,
          exitCode: code,
          stdout,
          stderr,
          sessionId,
          durationMs,
        });
      } else {
        resolve({
          success: false,
          exitCode: code,
          stdout,
          stderr,
          sessionId,
          durationMs,
          awaitingInput,
          error: `Codex exited with code ${code}`,
        });
      }
    });
  });
};

/**
 * Resume an existing Codex session with `codex exec resume <session_id>`.
 */
export const resumeCodex = (options: CodexResumeOptions): Promise<CodexExecResult> => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const beforeTimestamp = Math.floor(startTime / 1000);
    const timeoutMs = appConfig.codexMcpTimeoutMs;
    let timedOut = false;
    let resolved = false;

    const args = ['exec', 'resume', options.sessionId];

    // Add sandbox mode
    args.push('--sandbox', options.sandbox ?? DEFAULT_SANDBOX);

    // Add approval policy
    args.push('--ask-for-approval', options.approvalPolicy ?? DEFAULT_APPROVAL);

    // Add config if present
    const config = buildCodexConfig(options.config);
    if (Object.keys(config).length > 0) {
      args.push('--config', JSON.stringify(config));
    }

    // Add the continuation prompt
    args.push(options.prompt);

    console.log(`[CODEX] Resuming session ${options.sessionId} (timeout: ${timeoutMs}ms)`);

    const child = spawn(appConfig.codexCliPath, args, {
      cwd: options.worktreePath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        console.error(`[CODEX] Timeout after ${timeoutMs}ms, killing process...`);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!resolved) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(`[CODEX stdout] ${text}`);
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(`[CODEX stderr] ${text}`);
    });

    child.on('error', (error) => {
      clearTimeout(timeoutHandle);
      resolved = true;
      const durationMs = Date.now() - startTime;
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr,
        durationMs,
        error: `Failed to spawn Codex: ${error.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolved = true;
      const durationMs = Date.now() - startTime;
      // Try to parse session ID from output first (more reliable for concurrent execution)
      // Fall back to file system scanning, then to original session ID
      const sessionId = parseSessionIdFromOutput(stdout) ??
                        parseSessionIdFromOutput(stderr) ??
                        extractLatestSessionId(beforeTimestamp) ??
                        options.sessionId;

      console.log(`[CODEX] Completed in ${(durationMs / 1000).toFixed(1)}s`);

      const awaitingInput = stderr.includes('awaiting') || stderr.includes('waiting for input');

      if (timedOut) {
        resolve({
          success: false,
          exitCode: code,
          stdout,
          stderr,
          sessionId,
          durationMs,
          timedOut: true,
          error: `Codex timed out after ${timeoutMs}ms`,
        });
      } else if (code === 0) {
        resolve({
          success: true,
          exitCode: code,
          stdout,
          stderr,
          sessionId,
          durationMs,
        });
      } else {
        resolve({
          success: false,
          exitCode: code,
          stdout,
          stderr,
          sessionId,
          durationMs,
          awaitingInput,
          error: `Codex exited with code ${code}`,
        });
      }
    });
  });
};
