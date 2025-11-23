import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '../utils/jest-lite.js';
import { LATEST_PROTOCOL_VERSION, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

const JSON_RPC_TIMEOUT_MS = 30_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { message?: string };
}

interface JsonRpcWatcher {
  waitForResponse(id: number | string, timeoutMs: number): Promise<JsonRpcResponse>;
  readonly lines: readonly string[];
  readonly nonJsonLines: readonly string[];
  dispose(): void;
}

const createJsonRpcWatcher = (stream: NodeJS.ReadableStream): JsonRpcWatcher => {
  const lines: string[] = [];
  const nonJsonLines: string[] = [];
  const waiters = new Map<
    string,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let buffer = '';

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newlineIndex: number;

    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, '');
      if (line.trim() === '') {
        continue;
      }
      lines.push(line);

      try {
        const message = JSON.parse(line);
        if (message && typeof message === 'object' && 'id' in message && message.id !== undefined) {
          const key = String(message.id);
          const waiter = waiters.get(key);
          if (!waiter) {
            continue;
          }
          clearTimeout(waiter.timer);
          waiters.delete(key);
          if (message.error) {
            const description =
              typeof message.error === 'object' && message.error !== null && 'message' in message.error
                ? String((message.error as { message?: string }).message ?? JSON.stringify(message.error))
                : String(message.error);
            waiter.reject(new Error(`JSON-RPC id=${key} error: ${description}`));
            continue;
          }
          waiter.resolve(message as JsonRpcResponse);
        }
      } catch {
        nonJsonLines.push(line);
      }
    }
  };

  stream.on('data', onData);

  const waitForResponse = (id: number | string, timeoutMs: number): Promise<JsonRpcResponse> => {
    return new Promise((resolve, reject) => {
      const key = String(id);
      if (waiters.has(key)) {
        reject(new Error(`Already waiting for JSON-RPC id ${key}`));
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(key);
        reject(new Error(`Timed out waiting for JSON-RPC response ${key}`));
      }, timeoutMs);
      waiters.set(key, { resolve, reject, timer });
    });
  };

  const dispose = () => {
    stream.off('data', onData);
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('MCP stdout watcher disposed before response arrived'));
    }
    waiters.clear();
  };

  return {
    waitForResponse,
    lines,
    nonJsonLines,
    dispose,
  };
};

const createLineCollector = (stream: NodeJS.ReadableStream) => {
  const lines: string[] = [];
  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      lines.push(rawLine.replace(/\r$/, ''));
    }
  };

  stream.on('data', onData);

  return {
    lines,
    dispose: () => stream.off('data', onData),
  };
};

const writeJsonLine = async (stream: NodeJS.WritableStream | null, message: unknown): Promise<void> => {
  if (!stream) {
    throw new Error('Stdin stream is not available');
  }
  const payload = JSON.stringify(message) + '\n';
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      stream.off('error', onError);
      reject(error);
    };
    stream.on('error', onError);
    const finish = () => {
      stream.off('error', onError);
      resolve();
    };
    if (!stream.write(payload, 'utf8')) {
      stream.once('drain', finish);
    } else {
      finish();
    }
  });
};

describe('MCP STDIO integration', () => {
  test('tsx src/mcp.ts honors JSON-RPC initialize and tools/list over stdout', async () => {
    const testsDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(testsDir, '..', '..');
    const entryPoint = path.join(repoRoot, 'src', 'mcp.ts');
    const child = spawn('npx', ['tsx', entryPoint], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const closePromise = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const stderrCollector = createLineCollector(child.stderr);
    const jsonWatcher = createJsonRpcWatcher(child.stdout);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      const initializeResponsePromise = jsonWatcher.waitForResponse(1, JSON_RPC_TIMEOUT_MS);
      await writeJsonLine(child.stdin, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'stdio-integration-test',
            version: '1.0.0',
          },
        },
      });
      const initializeResponse = await initializeResponsePromise;
      expect(initializeResponse.jsonrpc).toBe('2.0');
      expect(initializeResponse.id).toBe(1);
      expect(initializeResponse.result).toBeDefined();

      await writeJsonLine(child.stdin, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      const listToolsResponsePromise = jsonWatcher.waitForResponse(2, JSON_RPC_TIMEOUT_MS);
      await writeJsonLine(child.stdin, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      const listToolsResponse = await listToolsResponsePromise;
      expect(listToolsResponse.id).toBe(2);
      expect(listToolsResponse.result).toBeDefined();

      const parsed = ListToolsResultSchema.safeParse(listToolsResponse.result);
      if (!parsed.success) {
        throw parsed.error;
      }
      expect(parsed.data.tools.length).toBe(10);
    } finally {
      jsonWatcher.dispose();
      stderrCollector.dispose();
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGINT');
      }
      await closePromise;
    }
  });
});
