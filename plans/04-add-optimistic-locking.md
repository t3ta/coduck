# Task 04: updateJobStatusに楽観的ロック追加

## 優先度
🟡 中優先度（Codexレビュー指摘事項）

## 問題
`updateJobStatus()` が前の状態をチェックせずに status/result_summary を上書きする。再試行やミスリクエストで `done` から `running` に戻ってしまう可能性がある。

## 目標
- `updateJobStatus()` に楽観的ロックを実装
- 不正な状態遷移を防止

## 実装内容

### 1. models/job.ts の updateJobStatus シグネチャ変更

```typescript
export const updateJobStatus = (
  id: string,
  status: JobStatus,
  result_summary?: unknown,
  expectedStatus?: JobStatus  // 新規: 期待する現在のstatus
): void => {
  const db = getDb();
  const now = new Date().toISOString();
  const assignments = ['status = ?', 'updated_at = ?'];
  const params: Array<string | null> = [status, now];

  if (result_summary !== undefined) {
    assignments.push('result_summary = ?');
    params.push(result_summary === null ? null : JSON.stringify(result_summary));
  }

  params.push(id);

  // WHERE句にexpectedStatusを追加
  let whereClause = 'id = ?';
  if (expectedStatus) {
    whereClause += ' AND status = ?';
    params.push(expectedStatus);
  }

  const stmt = db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE ${whereClause}`);
  const result = stmt.run(...params);

  if (result.changes === 0) {
    if (expectedStatus) {
      throw new Error(`Job ${id} not found or status is not ${expectedStatus}`);
    }
    throw new Error(`Job ${id} not found`);
  }
};
```

### 2. routes/jobs.ts の /jobs/:id/complete を修正

```typescript
router.post('/:id/complete', (req, res, next) => {
  try {
    const { id } = req.params;
    const body = completeJobSchema.parse(req.body);

    // runningからのみdone/failedに遷移できる
    updateJobStatus(id, body.status, body.result_summary, 'running');

    const job = getJob(id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.status(200).json(job);
  } catch (err) {
    next(err);
  }
});
```

## 検証方法
1. pending jobを作成
2. 直接 `done` に変更しようとして失敗することを確認
3. running jobに対して `done` に変更できることを確認

## 関連ファイル
- `src/orchestrator/models/job.ts`
- `src/orchestrator/routes/jobs.ts`

## 備考
これにより、ジョブの状態遷移が安全になり、予期しない状態変更を防げます。
