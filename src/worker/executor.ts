import { spawn } from 'node:child_process';

import type { SpecJson } from '../shared/types.js';
import { appConfig } from '../shared/config.js';

export interface ExecutionResult {
  success: boolean;
  commitHash?: string;
  testsPassed?: boolean;
  error?: string;
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

  return new Promise<ExecutionResult>((resolve) => {
    const child = spawn(appConfig.codexCliPath, [], {
      cwd: worktreePath,
      env: {
        ...process.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on('error', (error) => {
      resolve({ success: false, error: `Failed to start Codex CLI: ${error.message}` });
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errorMessage = stderr.trim() || `Codex CLI exited with code ${code}`;
        resolve({ success: false, error: errorMessage });
      }
    });

    child.stdin.write(`${prompt}\n`);
    child.stdin.end();
  });
}
