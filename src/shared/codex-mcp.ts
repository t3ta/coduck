import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appConfig } from './config.js';

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

type StructuredContent = Record<string, unknown>;

const CODEx_TOOL = 'codex';
const CODEx_REPLY_TOOL = 'codex-reply';
const CODEx_CLIENT_INFO = { name: 'coduck-automation', version: '1.0.0' } as const;
const DEFAULT_SANDBOX: SandboxMode = 'workspace-write';
const DEFAULT_APPROVAL: ApprovalPolicy = 'never';

interface CodexCallOptions {
  prompt: string;
  worktreePath: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  config?: Record<string, unknown>;
}

interface CodexReplyOptions {
  conversationId: string;
  prompt: string;
}

const buildEnvironment = (): Record<string, string> => {
  const entries = Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
};

interface HistoryEntry {
  session_id: string;
  ts: number;
  text: string;
}

export const extractLatestSessionId = (afterTimestamp: number): string | undefined => {
  try {
    // Codex MCP server writes to sessions directory, not history.jsonl
    // Look for session files created after the given timestamp
    const sessionsBase = join(homedir(), '.codex', 'sessions');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const todayPath = join(sessionsBase, String(year), month, day);

    try {
      const files = readdirSync(todayPath);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      // Find files modified after the given timestamp
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

      // Sort by modification time, most recent first
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

const createTransport = (): StdioClientTransport =>
  new StdioClientTransport({
    command: appConfig.codexCliPath,
    args: ['mcp-server'],
    env: buildEnvironment(),
  });

const withCodexClient = async <T>(handler: (client: Client) => Promise<T>): Promise<T> => {
  const transport = createTransport();
  const client = new Client(CODEx_CLIENT_INFO);
  let connected = false;

  try {
    await client.connect(transport);
    connected = true;
    return await handler(client);
  } finally {
    if (connected) {
      await client.close().catch(() => {});
    } else {
      await transport.close().catch(() => {});
    }
  }
};

export const callCodex = async (options: CodexCallOptions): Promise<CallToolResult> => {
  const args: Record<string, unknown> = {
    prompt: options.prompt,
    cwd: options.worktreePath,
    sandbox: options.sandbox ?? DEFAULT_SANDBOX,
    'approval-policy': options.approvalPolicy ?? DEFAULT_APPROVAL,
  };

  if (options.config) {
    args.config = options.config;
  }

  return withCodexClient(async (client) => {
    const result = await client.callTool(
      { name: CODEx_TOOL, arguments: args },
      CallToolResultSchema,
      { timeout: appConfig.codexMcpTimeoutMs }
    );
    return result as CallToolResult;
  });
};

export const callCodexReply = async (options: CodexReplyOptions): Promise<CallToolResult> => {
  return withCodexClient(async (client) => {
    const result = await client.callTool(
      {
        name: CODEx_REPLY_TOOL,
        arguments: {
          conversationId: options.conversationId,
          prompt: options.prompt,
        },
      },
      CallToolResultSchema,
      { timeout: appConfig.codexMcpTimeoutMs }
    );
    return result as CallToolResult;
  });
};

const toRecord = (value: unknown): StructuredContent | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as StructuredContent;
  }
  return null;
};

const asTextArray = (result: CallToolResult): string[] => {
  const chunks = Array.isArray(result.content) ? result.content : [];

  return chunks
    .filter((chunk): chunk is { type: 'text'; text: string } => chunk?.type === 'text' && typeof chunk.text === 'string')
    .map((chunk) => chunk.text);
};

export const extractConversationId = (result: CallToolResult): string | undefined => {
  const structured = toRecord(result.structuredContent);
  if (!structured) return undefined;

  const direct = structured.conversationId;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  const snake = structured.conversation_id;
  if (typeof snake === 'string' && snake.trim()) {
    return snake.trim();
  }

  return undefined;
};

export const extractCodexStatus = (result: CallToolResult): string | undefined => {
  const structured = toRecord(result.structuredContent);
  if (!structured) return undefined;
  const status = structured.status ?? structured.state;
  if (typeof status === 'string') {
    return status.trim().toLowerCase();
  }
  return undefined;
};

export const collectTextContent = (result: CallToolResult): string => {
  return asTextArray(result).join('\n\n');
};

export const codexResultIndicatesError = (result: CallToolResult): string | undefined => {
  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim();
  }
  if (result.isError) {
    const content = collectTextContent(result);
    if (content.trim()) {
      return content.trim();
    }
    return 'Codex MCP call reported an error.';
  }
  return undefined;
};
