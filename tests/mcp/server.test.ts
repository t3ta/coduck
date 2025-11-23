import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { createServer } from '../../src/mcp/server.js';
import { describe, expect, test } from '../utils/jest-lite.js';

const EXPECTED_TOOLS = [
  'enqueue_codex_job',
  'list_jobs',
  'get_job',
  'delete_job',
  'cleanup_jobs',
  'continue_codex_job',
  'list_worktrees',
  'cleanup_worktrees',
  'delete_worktree',
  'checkout_job_worktree',
] as const;

const setupClientAndServer = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
};

const closeClientAndServer = async (client: Client, server: ReturnType<typeof createServer>) => {
  await Promise.all([client.close(), server.close()]);
};

describe('MCP Server', () => {
  test('should list all registered tools', async () => {
    const { client, server } = await setupClientAndServer();
    try {
      const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

      expect(result.tools).toBeDefined();
      expect(result.tools.length).toBe(10);

      const toolNames = result.tools.map((tool) => tool.name);
      for (const expected of EXPECTED_TOOLS) {
        expect(toolNames).toContain(expected);
      }
    } finally {
      await closeClientAndServer(client, server);
    }
  });

  test('should have correct tool schemas', async () => {
    const { client, server } = await setupClientAndServer();
    try {
      const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

      for (const expectedName of EXPECTED_TOOLS) {
        const tool = result.tools.find((entry) => entry.name === expectedName);
        expect(tool).toBeDefined();
        expect(Boolean(tool?.title)).toBe(true);
        expect(Boolean(tool?.description)).toBe(true);
        expect(tool?.inputSchema).toBeDefined();
        if (tool?.inputSchema) {
          expect(tool.inputSchema.type).toBe('object');
        }
      }
    } finally {
      await closeClientAndServer(client, server);
    }
  });

  test('should connect successfully', async () => {
    const { client, server } = await setupClientAndServer();
    try {
      expect(server.isConnected()).toBe(true);
      const serverInfo = client.getServerVersion();
      expect(serverInfo).toBeDefined();
      expect(serverInfo?.name).toBe('coduck-orchestrator');

      const capabilities = client.getServerCapabilities();
      expect(capabilities).toBeDefined();
      expect(capabilities?.tools).toBeDefined();
    } finally {
      await closeClientAndServer(client, server);
    }
  });
});
