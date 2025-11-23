# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Codexをバックエンドとするジョブオーケストレーターシステムです。Gitワークツリーの分離環境でCodexを実行し、MCPサーバー経由でClaude Codeと統合します。

## 開発コマンド

### 起動（ローカル実行）

```bash
# Orchestrator (HTTP API + SQLiteジョブキュー)
npm run orchestrator

# Worker (ジョブ実行)
npm run worker

# Workerを並列実行（例: 5並列）
WORKER_CONCURRENCY=5 npm run worker

# MCP Server (Claude Code統合)
npm run mcp
```

### テストとビルド

```bash
# テスト実行
npm test

# TypeScriptビルド (dist/に出力) + 型チェック
npx tsc
```

### 開発環境

- `tsx`を使用してTypeScriptを直接実行
- `.env`ファイルで設定をオーバーライド可能（オプション）
- ホットリロードなし - コード変更後はプロセスを再起動
- Docker環境は提供せず、ローカル実行のみサポート

## アーキテクチャ

### 3つのコンポーネント

1. **Orchestrator** (`src/orchestrator/`)
   - Express HTTPサーバー
   - SQLite + WALモードで原子性を保証
   - ジョブステータス管理: `pending` → `running` → `done`/`failed`/`awaiting_input`
   - トランザクションベースのジョブクレーム処理

2. **Worker** (`src/worker/`)
   - Orchestratorをポーリングしてpendingジョブを取得
   - Gitワークツリーを作成または再利用（同じブランチの場合は既存worktreeを再利用）
   - Codex MCPサーバー経由でCodexを実行
   - 実行結果をコミット（push_modeに応じてプッシュ制御）
   - 会話継続時は既存ワークツリーを再利用

3. **MCP Server** (`src/mcp/`)
   - Claude Codeに公開するツール:
     - `enqueue_codex_job`: 新規ジョブ作成
     - `list_jobs`: ジョブ一覧取得
     - `get_job`: ジョブ詳細取得
     - `continue_codex_job`: 会話継続

### データフロー

```
Claude Code → MCP Tool → Orchestrator API → SQLite
                              ↓
                          Worker Poll
                              ↓
                      Create Worktree → Run Codex → Commit
                              ↓
                      Update Job Status
```

### 型の設計

- `src/shared/types.ts`: 全コンポーネント共通の型定義
- `src/shared/config.ts`: 環境変数ベースの設定管理
- `Job`インターフェース: データベーススキーマと1:1対応
- `SpecJson`: ジョブの目標と制約を定義

## 重要な制約と回避策

### Codex MCP `codex-reply`の制限

**問題**: Codex MCPの`codex-reply`ツールはMCPクライアント接続間でセッションを共有できないため動作しません（[Issue #3712](https://github.com/openai/codex/issues/3712)）。

**回避策**: `continue_codex_job`は以下の方法で会話継続を実装:

1. 新しい`codex`セッションを開始
2. 元のgoalと過去の会話履歴をプロンプトに含める
3. 新しい`conversationId`を`~/.codex/sessions/`から抽出

詳細は[docs/codex-mcp-limitations.md](docs/codex-mcp-limitations.md)を参照。

**コードへの影響**:
- `src/worker/codex-worker.ts`: 会話履歴を含む統合プロンプトを構築
- `src/shared/codex-mcp.ts`: セッションファイルから`conversationId`を抽出
- `result_summary.continuations[]`: 会話履歴を配列で保存

## TypeScript設定

- **Target**: ES2022
- **Modules**: NodeNext (ESM形式、`"type": "module"`必須)
- **Strict Mode**: 有効
- すべてのimportで`.js`拡張子が必要（TypeScript ESMの仕様）

## Gitワークツリーとブランチ戦略

### ワークツリーの基本

- デフォルトディレクトリ: `./worktrees/`
- 同じ`branch_name`を持つJobは同じworktreeを共有
- ワークツリーは手動削除が必要（自動クリーンアップなし）
- 会話継続時は既存ワークツリーを再利用してコンテキストを保持
- `repo_url` はローカルリポジトリの絶対パスを前提（例: `/home/user/workspace/my-app`）。同一マシン内でworktreeとローカルリポジトリが親和的に扱われ、ネットワーク経由のcloneやpushに依存しない

### ブランチ名の決定ロジック

`enqueue_codex_job`でブランチ名は以下の優先順で決定されます：

1. **`branch_name`が明示的に指定されている場合**: そのまま使用
   ```typescript
   // 例: 複数Jobをfeatureブランチにまとめる
   branch_name: "feature/navy-comment-system"
   ```

2. **`feature_id`のみ指定されている場合**: `feature/<feature_id>`を使用
   ```typescript
   // feature_id: "navy-comment-system" → branch_name: "feature/navy-comment-system"
   ```

3. **どちらも未指定の場合**: 自動生成（従来の挙動）
   ```typescript
   // codex/<goal-slug>-<timestamp>-<random> 形式
   // 例: "codex/add-user-auth-lm3k9-a1b2c3d4"
   ```

### Push制御（`push_mode`）

Jobの`push_mode`フィールドでリモートへのpush挙動を制御できます：

- **`always`**（デフォルト）: 差分があれば自動でgit push
- **`never`**: コミットまで実行するが、pushはスキップ

#### 使い分け

**フルオートPRモード**（従来の挙動）:
```typescript
// branch_name未指定、push_mode='always'（デフォルト）
// → codex/...ブランチが自動生成され、自動push
```

**ローカルマージモード**（新機能）:
```typescript
// 同じfeatureに複数Jobを積む
enqueue_codex_job({
  goal: "バックエンドAPIを実装",
  branch_name: "feature/navy-comment",
  push_mode: "never",
  feature_id: "navy-comment",
  feature_part: "backend"
});

enqueue_codex_job({
  goal: "フロントエンドUIを実装",
  branch_name: "feature/navy-comment",
  push_mode: "never",
  feature_id: "navy-comment",
  feature_part: "frontend"
});

// → 同じfeature/navy-commentブランチに2つのJobがcommit
// → ローカルで確認後、手動でpush & PR作成
```

## MCP Server登録

`~/.claude/config.json`に追加:

```json
{
  "mcpServers": {
    "coduck-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/coduck/dist/mcp.js"]
    }
  }
}
```

変更後はClaude Codeを再起動。

## データベース

- **ファイル**: `orchestrator.sqlite`
- **モード**: WAL（Write-Ahead Logging）で並行性向上
- **スキーマ**: `src/orchestrator/db.ts`で初期化
- **トランザクション**: ジョブクレーム時に排他制御を実施

## コーディングパターン

### エラーハンドリング

- `try/catch`で例外をキャッチし、ジョブステータスを`failed`に更新
- `result_summary`にエラーメッセージを記録
- Worker: エラー発生時もworktreeを保持（デバッグ用）

### 非同期実行

- Worker: `setInterval`でポーリング（デフォルト5秒）
- 長時間実行ジョブは`running`ステータスで進行中を表示
- `codex`コマンドは`child_process.execFile`で実行

### JSON直列化

- SQLiteに保存する複雑なオブジェクトは`JSON.stringify/parse`
- `spec_json`, `result_summary`, `conversation_id`など
