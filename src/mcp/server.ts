import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerJobTools } from './tools/job-tools.js';
import { OrchestratorClient } from './orchestrator-client.js';

export const createServer = (): McpServer => {
  const server = new McpServer(
    {
      name: 'coduck-orchestrator',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerJobTools(server, new OrchestratorClient());

  return server;
};

export const startServer = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();

  server.server.oninitialized = () => {
    console.log('MCP server initialized and ready for tool calls.');
  };

  await server.connect(transport);
};
