import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const createTextResult = (text: string, structuredContent?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
});
