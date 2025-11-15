import { startServer } from './mcp/server.js';

const main = async (): Promise<void> => {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exitCode = 1;
  }
};

void main();
