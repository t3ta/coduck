# Coduck - Codex Job Orchestrator

Job orchestrator with Codex worker and MCP server integration.

## Features

- **Job Orchestration**: SQLite-based job queue with atomic operations
- **Codex Worker**: Automated code execution via Codex MCP server
- **Git Worktree Isolation**: Each job runs in an isolated git worktree
- **MCP Server**: Claude Code integration via Model Context Protocol
- **Conversation Continuity**: Track and continue Codex conversations across jobs
- **Job Cleanup**: Manual and automated cleanup of completed jobs and orphaned worktrees

## Architecture

### Components

1. **Orchestrator** (`src/orchestrator/`)
   - HTTP server for job management
   - SQLite database with WAL mode
   - Atomic job claiming with transactions
   - Job status tracking: `pending`, `running`, `awaiting_input`, `done`, `failed`, `cancelled`

2. **Worker** (`src/worker/`)
   - Polls orchestrator for pending jobs
   - Creates isolated git worktrees for each job
   - Executes Codex via MCP server
   - Commits and pushes changes
   - Runs tests if available

3. **MCP Server** (`src/mcp/`)
   - Exposes tools for Claude Code:
     - `enqueue_codex_job`: Create new jobs
     - `list_jobs`: Query jobs with filters
     - `get_job`: Fetch job details
     - `continue_codex_job`: Continue conversations

## Setup

### Prerequisites

- Node.js 18+
- Codex CLI (`codex`)
- Git

### Installation

```bash
npm install
```

### Configuration

Create `.env` file (optional, defaults are provided):

```env
ORCHESTRATOR_PORT=3000
ORCHESTRATOR_URL=http://localhost:3000
WORKER_POLL_INTERVAL_MS=5000
WORKTREE_BASE_DIR=./worktrees
CODEX_CLI_PATH=codex
```

## Usage

### Start Orchestrator

```bash
npm run orchestrator
```

### Start Worker

```bash
npm run worker
```

### Start MCP Server

```bash
npm run mcp
```

### Register MCP Server with Claude Code

Add to `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "coduck-orchestrator": {
      "command": "node",
      "args": ["/path/to/coduck/dist/mcp.js"],
      "env": {}
    }
  }
}
```

## Cleanup

### CLI Cleanup

```bash
# Dry run - show what would be removed
npm run cleanup -- --dry-run --all

# Clean up completed jobs (done, failed, cancelled)
npm run cleanup -- --jobs

# Clean up jobs with specific status
npm run cleanup -- --jobs --status=done,failed

# Clean up jobs older than 7 days
npm run cleanup -- --jobs --max-age=7

# Clean up orphaned worktrees
npm run cleanup -- --worktrees

# Clean up unused repository cache
npm run cleanup -- --repo-cache

# Clean up everything
npm run cleanup -- --all
```

### MCP Tools for Claude Code

Available tools:

- `delete_job`: Delete a single job by ID
- `cleanup_jobs`: Delete multiple jobs with filters

```typescript
// Delete a single job
delete_job({ id: "job-id" })

// Cleanup failed jobs
cleanup_jobs({ statuses: ["failed"] })

// Cleanup jobs older than 7 days
cleanup_jobs({ statuses: ["done", "failed"], maxAgeDays: 7 })
```

### HTTP API

Endpoints:

- `DELETE /jobs/:id` - Delete a single job
- `POST /jobs/cleanup` - Delete multiple jobs with filters

```bash
# Delete a single job
curl -X DELETE http://localhost:3000/jobs/{job-id}

# Cleanup failed jobs
curl -X POST http://localhost:3000/jobs/cleanup \
  -H "Content-Type: application/json" \
  -d '{"statuses": ["failed"]}'
```

### Safety Features

- Protected statuses: `running` and `awaiting_input` jobs cannot be deleted
- Confirmation prompt for destructive operations (CLI)
- Dry-run mode to preview changes (CLI)
- Automatic worktree cleanup when deleting jobs

## Known Limitations

### Codex MCP `codex-reply` Tool

The `codex-reply` tool does not work due to session isolation between MCP client connections. See [docs/codex-mcp-limitations.md](docs/codex-mcp-limitations.md) for details.

**Workaround**: The `continue_codex_job` tool uses `codex` (instead of `codex-reply`) with conversation history in the prompt to maintain context across turns.

## Example Workflow

```typescript
// 1. Create a job via MCP tool
enqueue_codex_job({
  goal: "Add TypeScript strict mode",
  context_files: ["tsconfig.json"],
  base_ref: "main"
})

// 2. Worker claims and executes the job
// - Creates worktree
// - Runs Codex
// - Commits changes
// - Updates job status

// 3. Continue conversation if needed
continue_codex_job({
  id: "job-id",
  prompt: "Also enable noImplicitAny"
})
```

## Development

### Build

```bash
npm run build
```

### Type Check

```bash
npm run typecheck
```

## Project Structure

```
coduck/
├── src/
│   ├── orchestrator/     # HTTP server & DB
│   ├── worker/          # Job execution
│   ├── mcp/             # MCP server
│   └── shared/          # Common types & config
├── docs/                # Documentation
└── worktrees/          # Isolated work directories
```

## License

MIT
