# Coduck Main Features

- Job Orchestration: SQLite-based job queue with atomic operations and consistent status tracking.
- Codex Worker: Automated Codex execution per job in isolated git worktrees, with commits, optional pushes, and test runs when available.
- MCP Server: Claude Code integration via Model Context Protocol, exposing tools to enqueue, list, get, and continue Codex jobs.
