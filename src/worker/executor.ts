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
  const sections: string[] = [];

  sections.push(`# Goal\n${spec.goal}`);
  if (spec.context_files.length) {
    sections.push(`# Context Files\n${spec.context_files.map((file) => `- ${file}`).join('\n')}`);
  }
  if (spec.notes) {
    sections.push(`# Notes\n${spec.notes}`);
  }
  if (spec.constraints?.length) {
    sections.push(`# Constraints\n${spec.constraints.map((line) => `- ${line}`).join('\n')}`);
  }
  if (spec.acceptance_criteria?.length) {
    sections.push(`# Acceptance Criteria\n${spec.acceptance_criteria.map((line) => `- ${line}`).join('\n')}`);
  }

  sections.push('# Instructions\nPlease complete the task described above within this repository.');

  return sections.join('\n\n');
};

/**
 * Execute Codex for the first time (new session).
 */
export async function executeCodex(worktreePath: string, specJson: SpecJson): Promise<ExecutionResult> {
  const prompt = buildPrompt(specJson);

  const result = await execCodex({
    prompt,
    worktreePath,
    sandbox: 'workspace-write',
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
  additionalPrompt: string
): Promise<ExecutionResult> {
  const result = await resumeCodex({
    sessionId,
    prompt: additionalPrompt,
    worktreePath,
    sandbox: 'workspace-write',
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
