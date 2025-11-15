# Task 05: Codex ワーカーの実装

## 優先度
⚙️ 新規実装

## 目標
Codexワーカーを実装し、ジョブオーケストレータからジョブを取得して実行する。

## 実装内容

### 1. src/worker/codex-worker.ts
メインワーカーループ：
- オーケストレータの `POST /jobs/claim?worker_type=codex` を定期的にポーリング
- ジョブを取得したら処理開始
- 完了後に `POST /jobs/:id/complete` で結果を報告

### 2. src/worker/worktree.ts
git worktree 操作：
```typescript
export interface WorktreeContext {
  path: string;
  branchName: string;
  cleanup: () => Promise<void>;
}

export async function createWorktree(
  repoPath: string,
  baseRef: string,
  branchName: string,
  worktreePath: string
): Promise<WorktreeContext> {
  // git worktree add 実装
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  // git worktree remove 実装
}
```

### 3. src/worker/executor.ts
Codex CLI 実行ロジック：
```typescript
export interface ExecutionResult {
  success: boolean;
  commitHash?: string;
  testsPassed?: boolean;
  error?: string;
}

export async function executeCodex(
  worktreePath: string,
  specJson: SpecJson
): Promise<ExecutionResult> {
  // codex CLI を実行
  // spec_json の内容をプロンプトとして渡す
}
```

### 4. src/worker.ts
エントリポイント

### 5. フロー
1. `/jobs/claim?worker_type=codex` でジョブ取得
2. `createWorktree()` でブランチ作成
3. `executeCodex()` で Codex 実行
4. commit & push
5. テスト実行
6. `/jobs/:id/complete` で結果報告
7. 成功なら worktree 削除、失敗なら残す

## 環境変数
- `ORCHESTRATOR_URL`: オーケストレータのURL（デフォルト: http://localhost:3000）
- `WORKER_POLL_INTERVAL_MS`: ポーリング間隔（デフォルト: 5000）

## 検証方法
1. オーケストレータを起動
2. ワーカーを起動
3. `POST /jobs` でジョブ作成
4. ワーカーがジョブを取得して実行することを確認

## 関連ファイル
- `src/worker/codex-worker.ts`（新規）
- `src/worker/executor.ts`（新規）
- `src/worker/worktree.ts`（新規）
- `src/worker.ts`（新規）
- `src/shared/config.ts`（環境変数追加）

## 注意事項
- Codex CLI のパスは `appConfig.codexCliPath` から取得
- worktree のベースディレクトリは `appConfig.worktreeBaseDir` から取得
