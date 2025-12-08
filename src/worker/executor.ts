import type { SpecJson } from '../shared/types.js';
import { execCodex, resumeCodex } from '../shared/codex-cli.js';

export interface ExecutionResult {
  success: boolean;
  commitHash?: string;
  testsPassed?: boolean;
  error?: string;
  /** Session ID for resuming the conversation */
  sessionId?: string;
  awaitingInput?: boolean;
  /** Execution duration in milliseconds */
  durationMs?: number;
  /** Whether execution timed out */
  timedOut?: boolean;
}

const buildPrompt = (spec: SpecJson): string => {
  return spec.prompt;
};;

/**
 * Execute Codex for the first time (new session).
 */
export async function executeCodex(worktreePath: string, specJson: SpecJson, jobId?: string): Promise<ExecutionResult> {
  const prompt = buildPrompt(specJson);

  const result = await execCodex({
    prompt,
    worktreePath,
    sandbox: 'workspace-write',
    jobId,
  });

  if (result.awaitingInput) {
    return {
      success: false,
      sessionId: result.sessionId,
      awaitingInput: true,
      durationMs: result.durationMs,
      error: result.error ?? 'Codex is awaiting additional input.',
    };
  }

  if (!result.success) {
    return {
      success: false,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      error: result.error,
    };
  }

  return {
    success: true,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
  };
}

/**
 * Continue an existing Codex session.
 */
export async function continueCodex(
  worktreePath: string,
  sessionId: string,
  additionalPrompt: string,
  jobId?: string
): Promise<ExecutionResult> {
  const result = await resumeCodex({
    sessionId,
    prompt: additionalPrompt,
    worktreePath,
    sandbox: 'workspace-write',
    jobId,
  });

  if (result.awaitingInput) {
    return {
      success: false,
      sessionId: result.sessionId,
      awaitingInput: true,
      durationMs: result.durationMs,
      error: result.error ?? 'Codex is awaiting additional input.',
    };
  }

  if (!result.success) {
    return {
      success: false,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      error: result.error,
    };
  }

  return {
    success: true,
    sessionId: result.sessionId,
    durationMs: result.durationMs,
  };
}
