# Task 02: /:id/claim エンドポイントの削除

## 優先度
🔴 高優先度（Codexレビュー指摘事項）

## 問題
`POST /:id/claim` エンドポイントが非アトミックな実装になっており、race conditionのリスクがある。また、Task 01で追加する `/jobs/claim` の方が適切なため、このエンドポイントは不要。

## 目標
- `POST /:id/claim` エンドポイントを削除
- デッドコードの整理

## 実装内容

### 1. routes/jobs.ts からエンドポイント削除
`router.post('/:id/claim', ...)` のハンドラ全体を削除

### 2. 関連するZodスキーマの削除
使われなくなったバリデーションスキーマがあれば削除

## 検証方法
1. `POST /jobs/:id/claim` を呼び出して404が返ることを確認
2. `POST /jobs/claim?worker_type=codex` が正常に動作することを確認（Task 01の実装が有効）

## 関連ファイル
- `src/orchestrator/routes/jobs.ts`

## 注意事項
この変更は破壊的変更です。既存のワーカーが `/:id/claim` を使用している場合は、先に `/jobs/claim` に移行する必要があります。ただし、現時点ではワーカーはまだ実装されていないため、問題ありません。
