# Task 01: /jobs/claim エンドポイントの追加

## 優先度
🔴 高優先度（Codexレビュー指摘事項）

## 問題
現在の実装では、`models/job.ts` にトランザクショナルな `claimJob(worker_type)` ヘルパーが存在するが、これを使用するエンドポイントが存在しない。代わりに `POST /:id/claim` という非アトミックな実装が存在し、race conditionのリスクがある。

## 目標
- `POST /jobs/claim?worker_type=xxx` エンドポイントを追加
- `models/job.ts` の `claimJob()` を直接使用
- 最も古いpending jobを安全に取得してrunningに変更

## 実装内容

### 1. routes/jobs.ts にエンドポイント追加

```typescript
// POST /jobs/claim?worker_type=xxx
router.post('/claim', (req, res, next) => {
  try {
    const { worker_type } = z.object({
      worker_type: z.string().min(1)
    }).parse(req.query);

    const job = claimJob(worker_type);

    if (!job) {
      return res.status(404).json({ error: 'No pending jobs available for this worker type' });
    }

    res.status(200).json(job);
  } catch (err) {
    next(err);
  }
});
```

### 2. Zodスキーマの追加
クエリパラメータのバリデーションスキーマを追加

## 検証方法
1. pending jobを作成
2. `POST /jobs/claim?worker_type=codex` を呼び出し
3. レスポンスでjobのstatusが`running`になっていることを確認
4. 同じリクエストを再度実行し、404が返ることを確認（jobがない場合）

## 関連ファイル
- `src/orchestrator/routes/jobs.ts`
- `src/orchestrator/models/job.ts` (既存のclaimJob関数を使用)
