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
     - `enqueue_codex_job`: 新規ジョブ作成（依存関係指定対応）
     - `list_jobs`: ジョブ一覧取得
     - `get_job`: ジョブ詳細取得
     - `get_job_dependencies`: ジョブ依存関係取得
     - `delete_job`: ジョブ削除
     - `cleanup_jobs`: 複数ジョブの一括削除
     - `continue_codex_job`: 会話継続
     - `list_worktrees`, `cleanup_worktrees`, `delete_worktree`, `checkout_job_worktree`: Worktree管理

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

- デフォルトディレクトリ: `./worktrees/`（`WORKTREE_BASE_DIR`で変更可）
- `worktree_path` は branch 名を `-` 置換したディレクトリ名で上記ディレクトリ配下に絶対パス生成。no-worktreeジョブは空文字を送って worktree 削除を防ぐ
- 同じ`branch_name`を持つJobは同じworktreeを共有
- 成功時かつ`push_mode!=='never'`の場合は自動クリーンアップ。`push_mode='never'`または失敗時は調査のために保持
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

## ワークツリーなしモード

### 概要

既存のClaude Code作業ディレクトリで直接Codexを実行するモードです。Gitワークツリーを作成せず、ファイルの変更のみを行います。

### 用途

- 既存プロジェクトへの直接適用
- シンプルな実験やプロトタイピング
- 高速な小規模変更
- コードの変更がない運用作業（調査、分析、ドキュメント生成など）

### 使用方法

MCP Tool経由で以下のように指定:

```typescript
enqueue_codex_job({
  goal: "プロジェクト構造を分析してREADMEに記載",
  context_files: ["src/", "package.json"],
  use_worktree: false, // ワークツリーなしモード
});
```

**注意**:
- `repo_url` は現在の作業ディレクトリの絶対パスに自動設定（ユーザー指定時も絶対パス必須）
- `worktree_path` は常に空文字列（worker がクリーンアップ対象として扱わないため）
- `working_directory` は result_summary に記録され、実行パスを明示
- `push_mode` は強制的に `'never'`
- `branch_name` は `no-worktree-<uuid>`形式で自動生成（Git操作はしないがメタデータとして保存）
- `base_ref` は使用されません（no-worktreeモードではGitブランチ操作を行わないため、baseブランチからの分岐が発生しません）

### 制約

- Git操作（コミット、プッシュ）は実行されません
- テストは通常通り実行されます（`package.json` の `test` スクリプトがあれば）
- 作業ディレクトリの変更は直接適用されます（ワークツリーの分離なし）。worker/cleanupはいずれもこのディレクトリを削除しません（`use_worktree=false` + 空の`worktree_path`で防御）
- コミットやpushは利用者が手動で行う必要があります

### バリデーションとメタデータ

- `use_worktree=false` の場合、`repo_url` は絶対パス必須（相対パスは400）。CLI/Toolの自動設定は `process.cwd()` の絶対パス。
- `use_worktree=true` の場合は `worktree_path` が必須（空文字不可）。オーケストレーターで `WORKTREE_BASE_DIR` 配下の絶対パスに解決されます。
- プロパティ名の使い分け:
  - `worktree_path`: workerが管理するGitワークツリーのパス。クリーンアップ対象。
  - `working_directory`: no-worktree実行時の実ディレクトリ。削除/クリーンアップ対象外にするため別名で記録。
  - `conversation_id`: CodexセッションID。`result_summary.codex.conversation_id` とジョブの `conversation_id` の両方で保持（互換性のため）。
- `result_summary` は上記プロパティを保存してディレクトリ衝突や誤削除を避けます。
- ジョブ削除/クリーンアップ時は `use_worktree` フラグと `worktree_path` を確認し、no-worktreeジョブの作業ディレクトリを削除しないよう防御しています。

### 使用例

```typescript
// 例1: コードベースの調査（ファイル変更なし）
enqueue_codex_job({
  goal: "このプロジェクトの依存関係を分析して、セキュリティリスクをレポート",
  context_files: ["package.json", "package-lock.json"],
  use_worktree: false,
});

// 例2: 小規模な変更（手動でコミット）
enqueue_codex_job({
  goal: "ESLintの警告を修正",
  context_files: ["src/**/*.ts"],
  use_worktree: false,
});

// 例3: ドキュメント生成
enqueue_codex_job({
  goal: "API仕様書をOpenAPI形式で生成",
  context_files: ["src/api/"],
  use_worktree: false,
});
```

## ジョブ依存関係管理（DAG）

### 概要

ジョブ間の依存関係を定義し、前提ジョブの完了を待って自動実行するDAG（Directed Acyclic Graph）機能をサポートしています。

### 基本的な使い方

```typescript
// ステップ1: 基盤となるジョブを作成
const baseJob = await enqueue_codex_job({
  goal: "データベーススキーマを作成",
  context_files: ["src/db/schema.ts"],
});

// ステップ2: 依存ジョブを作成（baseJobが完了するまで待機）
const apiJob = await enqueue_codex_job({
  goal: "RESTful APIエンドポイントを実装",
  context_files: ["src/api/routes.ts"],
  depends_on: [baseJob.id], // 依存関係を指定
});

// ステップ3: 複数の依存関係も指定可能
const testJob = await enqueue_codex_job({
  goal: "統合テストを追加",
  context_files: ["tests/integration/"],
  depends_on: [baseJob.id, apiJob.id], // 両方が完了するまで待機
});
```

### 依存関係の動作

**ジョブの実行条件**:
- 依存するすべてのジョブが`done`ステータスになった時点で実行可能になる
- 依存ジョブが`failed`ステータスの場合は実行されない（blocked状態を維持）
- 依存関係がないジョブは即座に実行可能

**Worker の claimJob() 動作**:
```typescript
// Workerは以下の条件を満たすジョブのみをクレーム:
// 1. status = 'pending'
// 2. worktree競合がない（同じbranch_name, repo_urlのrunningジョブがない）
// 3. 全ての依存ジョブが'done'ステータス
// 4. 依存ジョブに'failed'がない
```

**循環依存の検出**:
- ジョブ作成時に深さ優先探索（DFS）で循環依存をチェック
- 循環が検出された場合は400エラーで作成を拒否

### API仕様

**POST /jobs**:
```typescript
{
  // 既存フィールド...
  "depends_on": ["job-uuid-1", "job-uuid-2"], // オプション: 依存ジョブのUUID配列
}
```

**GET /jobs/:id/dependencies**:
```typescript
{
  "depends_on": ["upstream-job-id"],    // このジョブが依存するジョブ
  "depended_by": ["downstream-job-id"]  // このジョブに依存しているジョブ
}
```

### MCP Tool の使用例

```typescript
// 依存関係付きでジョブを作成
enqueue_codex_job({
  goal: "機能Bを実装",
  context_files: ["src/feature-b.ts"],
  depends_on: ["<job-a-uuid>"],
  feature_id: "multi-step-feature",
  feature_part: "step-2"
});

// 依存関係を確認
get_job_dependencies({ id: "<job-id>" });
// 出力例:
// Upstream dependencies (must complete before this job): 1
//   - <job-a-uuid>
// Downstream dependencies (blocked until this job completes): 2
//   - <job-c-uuid>
//   - <job-d-uuid>
```

### データベーススキーマ

**job_dependenciesテーブル**:
```sql
CREATE TABLE job_dependencies (
  job_id TEXT NOT NULL,              -- 依存する側のジョブ
  depends_on_job_id TEXT NOT NULL,   -- 依存される側のジョブ
  PRIMARY KEY (job_id, depends_on_job_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
```

### 使用例：マルチステップワークフロー

```typescript
// 例: Webアプリケーションの段階的実装

// Phase 1: データモデル
const modelJob = await enqueue_codex_job({
  goal: "Userモデルとスキーマを定義",
  context_files: ["src/models/user.ts", "src/db/schema.ts"],
  feature_id: "user-auth",
  feature_part: "models",
});

// Phase 2: バックエンドAPI（モデルに依存）
const apiJob = await enqueue_codex_job({
  goal: "User認証APIを実装",
  context_files: ["src/api/auth.ts"],
  depends_on: [modelJob.id],
  feature_id: "user-auth",
  feature_part: "api",
});

// Phase 3: フロントエンド（APIに依存）
const uiJob = await enqueue_codex_job({
  goal: "ログインUIコンポーネントを作成",
  context_files: ["src/components/LoginForm.tsx"],
  depends_on: [apiJob.id],
  feature_id: "user-auth",
  feature_part: "ui",
});

// Phase 4: テスト（全てに依存）
const testJob = await enqueue_codex_job({
  goal: "E2E認証テストを追加",
  context_files: ["tests/e2e/auth.test.ts"],
  depends_on: [modelJob.id, apiJob.id, uiJob.id],
  feature_id: "user-auth",
  feature_part: "tests",
});

// 実行順序:
// 1. modelJob が実行される（依存なし）
// 2. modelJob 完了後、apiJob が実行される
// 3. apiJob 完了後、uiJob が実行される
// 4. 全て完了後、testJob が実行される
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
