// Import config FIRST to redirect stdout before any other modules load
import './shared/config.js';

import { startServer as startMcpServer } from './mcp/server.js';

const main = async (): Promise<void> => {
  try {
    // Start MCP Server only (blocks until closed)
    await startMcpServer();
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
};

void main();
