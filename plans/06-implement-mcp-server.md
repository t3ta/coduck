# Task 06: MCP サーバの実装

## 優先度
⚙️ 新規実装

## 目標
Claude Code 用 MCP サーバを実装し、ジョブオーケストレータのHTTP APIをラップする。

## 実装内容

### 1. src/mcp/server.ts
MCP サーバのエントリポイント：
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  {
    name: 'coduck-orchestrator',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);
```

### 2. src/mcp/tools/job-tools.ts
MCPツール定義：

#### enqueue_codex_job
```typescript
{
  name: 'enqueue_codex_job',
  description: 'Enqueue a new Codex job',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      context_files: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      base_ref: { type: 'string', default: 'origin/main' }
    },
    required: ['goal', 'context_files']
  }
}
```

実装：
- `POST /jobs` を呼び出し
- repo_url, branch_name, worktree_path を自動生成
- worker_type="codex"

#### list_jobs
```typescript
{
  name: 'list_jobs',
  description: 'List jobs with optional filters',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'running', 'done', 'failed', 'cancelled'] },
      worker_type: { type: 'string' }
    }
  }
}
```

実装：
- `GET /jobs?status=xxx&worker_type=xxx` を呼び出し

#### get_job
```typescript
{
  name: 'get_job',
  description: 'Get job details by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' }
    },
    required: ['id']
  }
}
```

実装：
- `GET /jobs/:id` を呼び出し

### 3. src/mcp.ts
エントリポイント

### 4. HTTP クライアント
- axios または fetch を使ってオーケストレータと通信
- `ORCHESTRATOR_URL` 環境変数から接続先を取得

## package.json の更新
```json
{
  "scripts": {
    "mcp": "tsx src/mcp.ts"
  }
}
```

## Claude Code での使用方法
1. MCPサーバを起動（stdio transport）
2. Claude Codeの設定ファイルにMCPサーバを追加
3. `enqueue_codex_job` ツールでジョブを投入
4. `list_jobs` / `get_job` で進捗確認

## 検証方法
1. オーケストレータを起動
2. MCPサーバをstdioモードで起動
3. MCPクライアント（Inspectorなど）からツールを呼び出し
4. 正常にジョブが作成・取得できることを確認

## 関連ファイル
- `src/mcp/server.ts`（新規）
- `src/mcp/tools/job-tools.ts`（新規）
- `src/mcp.ts`（新規）
- `src/shared/config.ts`（環境変数追加）

## 注意事項
- MCPサーバはstdio transportで動作
- オーケストレータのURLは環境変数で指定可能にする
- 将来的に worker_type のバリエーションが増えても対応できる設計
