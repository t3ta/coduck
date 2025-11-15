import type { SpecJson } from '../shared/types.js';
import { callCodex, collectTextContent, codexResultIndicatesError, extractCodexStatus, extractConversationId } from '../shared/codex-mcp.js';

export interface ExecutionResult {
  success: boolean;
  commitHash?: string;
  testsPassed?: boolean;
  error?: string;
  conversationId?: string;
  awaitingInput?: boolean;
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

export async function executeCodex(worktreePath: string, specJson: SpecJson): Promise<ExecutionResult> {
  const prompt = buildPrompt(specJson);
  try {
    const result = await callCodex({
      prompt,
      worktreePath,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });

    const output = collectTextContent(result);
    if (output.trim()) {
      console.log(output.trim());
    }

    const conversationId = extractConversationId(result);
    const status = extractCodexStatus(result);
    const error = codexResultIndicatesError(result);

    if (status === 'awaiting_input') {
      return {
        success: false,
        conversationId,
        awaitingInput: true,
        error: error ?? (output.trim() || 'Codex is awaiting additional input.'),
      };
    }

    if (error) {
      return { success: false, conversationId, error };
    }

    return { success: true, conversationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to execute Codex via MCP: ${message}` };
  }
}
