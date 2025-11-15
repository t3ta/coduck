# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Codexをバックエンドとするジョブオーケストレーターシステムです。Gitワークツリーの分離環境でCodexを実行し、MCPサーバー経由でClaude Codeと統合します。

## 開発コマンド

### 起動

```bash
# Orchestrator (HTTP API + SQLiteジョブキュー)
npm run orchestrator

# Worker (ジョブ実行)
npm run worker

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

## アーキテクチャ

### 3つのコンポーネント

1. **Orchestrator** (`src/orchestrator/`)
   - Express HTTPサーバー
   - SQLite + WALモードで原子性を保証
   - ジョブステータス管理: `pending` → `running` → `done`/`failed`/`awaiting_input`
   - トランザクションベースのジョブクレーム処理

2. **Worker** (`src/worker/`)
   - Orchestratorをポーリングしてpendingジョブを取得
   - 各ジョブ用のGitワークツリーを作成（完全に分離された環境）
   - Codex MCPサーバー経由でCodexを実行
   - 実行結果をコミット・プッシュ
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

## Gitワークツリーの管理

- デフォルトディレクトリ: `./worktrees/`
- 各ジョブは`worktrees/job-<id>/`に分離
- ワークツリーは手動削除が必要（自動クリーンアップなし）
- 会話継続時は既存ワークツリーを再利用してコンテキストを保持

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
