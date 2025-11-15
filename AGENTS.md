# Coduckエージェントガイド

Coduckは3つの主要エージェント（オーケストレーター、ワーカー、MCPサーバー）が連携してCodexジョブを実行します。本書は各エージェントの役割と運用手順をまとめたものです。

## 1. オーケストレーターエージェント

- **役割**: SQLiteベースのジョブキューを提供し、HTTP API経由でジョブの登録・取得・状態更新を管理します。
- **主な責務**
  - `pending`/`running`/`awaiting_input`/`done`/`failed`/`cancelled` といった状態遷移の一貫性確保
  - WALモードSQLiteでのアトミックなジョブ取得（`better-sqlite3`）
  - MCPサーバーや外部クライアントからのジョブ登録リクエストの受付
- **起動方法**
  ```bash
  npm run orchestrator
  ```
  - デフォルトポートは `ORCHESTRATOR_PORT` (既定: 3000)。
  - `.env` で `ORCHESTRATOR_URL` を上書き可能。

## 2. ワーカーエージェント

- **役割**: オーケストレーターをポーリングし、ジョブごとに隔離されたgit worktreeを作成してCodex CLIを実行、完了後に結果を更新します。
- **主な責務**
  - `WORKTREE_BASE_DIR`（既定: `./worktrees`）配下に作業ディレクトリを生成
  - ジョブ成功時は自動クリーンアップ、失敗時はデバッグ用に保持
  - `CODEX_CLI_PATH`（既定: `codex`）を通じたCodex実行と結果のコミット/プッシュ
  - `WORKER_POLL_INTERVAL_MS`（既定: 5000ms）に基づくポーリング
  - テストコマンド（`npm test`）が存在する場合の自動実行
- **起動方法**
  ```bash
  npm run worker
  ```
  - 実行前に対象リポジトリへアクセス可能なgit資格情報を用意してください。

## 3. MCPサーバーエージェント

- **役割**: Claude CodeなどのMCPクライアントに対してCoduck用ツール群を提供し、ジョブの作成・一覧取得・詳細取得・継続実行を可能にします。
- **提供ツール例**
  - `enqueue_codex_job`: 新規ジョブ登録
  - `list_jobs`: フィルター付きジョブ一覧
  - `get_job`: ジョブ詳細取得
  - `continue_codex_job`: 途中ジョブの継続実行（Codex CLIを再度呼び出し会話履歴をプロンプトに埋め込む）
- **起動方法**
  ```bash
  npm run mcp
  ```
  - `~/.claude/config.json` にMCPサーバーを登録することでClaude Codeから接続可能。
  - `codex-reply` ツールのセッション制限により、`continue_codex_job` はCodex CLIを直接呼び出すワークアラウンドを採用します（詳細は `docs/codex-mcp-limitations.md` を参照）。

## 共通設定

`.env` or 環境変数で以下を設定できます（`src/shared/config.ts` 参照）:

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `WORKTREE_BASE_DIR` | `./worktrees` | ワーカーが生成するgit worktreeの親ディレクトリ |
| `CODEX_CLI_PATH` | `codex` | ワーカー/継続実行で使用するCodex CLIパス |
| `ORCHESTRATOR_PORT` | `3000` | HTTPサーバーポート |
| `ORCHESTRATOR_URL` | `http://localhost:${ORCHESTRATOR_PORT}` | クライアントが参照するAPI URL |
| `WORKER_POLL_INTERVAL_MS` | `5000` | ワーカーのポーリング間隔（ミリ秒） |

## 運用フロー概要

1. MCPクライアントまたはその他のクライアントがオーケストレーターへジョブを登録。
2. ワーカーがジョブを取得し、専用worktreeでCodexを実行。
3. 実行結果や会話ログはデータベースに保存され、必要に応じてMCPツールの `continue_codex_job` で追加入力を行う。
4. 完了・失敗・キャンセル時の状態更新はオーケストレーターが管理。

この3エージェントを適切に起動・設定することで、Coduck全体のジョブライフサイクルが成立します。運用時は各エージェントのログとSQLite DB状態を監視し、ジョブの詰まりやworktree残骸がないかを定期的に確認してください。
