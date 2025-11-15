# Codex MCP の既知の制限事項と回避策

## 問題: `codex-reply` ツールが動作しない

### 現象

Codex MCP serverの`codex-reply`ツールを使用して会話を継続しようとすると、以下のエラーが発生します：

```
Session not found for conversation_id: <session-id>
```

このエラーは、セッション作成直後（10秒以内）でも発生します。

### 原因

MCPクライアントの各接続が**独立したセッション空間**を持つため、異なるMCP接続間でセッションを共有できません。

具体的には：
1. 最初の`codex`ツール呼び出しで新しいMCPクライアント接続が作成され、セッションが開始される
2. `codex-reply`を呼び出すと、**新しいMCPクライアント接続**が作成される
3. 新しい接続には元のセッション情報がないため、「Session not found」エラーになる

### 関連するGitHub Issues

この問題は既知のバグとして報告されています：
- [Issue #3712: Missing conversationId of Codex MCP Server](https://github.com/openai/codex/issues/3712)
- [Issue #4651: codex mcp no return conversationId or codex-reply conversationId no required](https://github.com/openai/codex/issues/4651)

**ステータス**: 2025年11月時点で未解決

### conversationId の抽出

`codex`ツールのレスポンスには`conversationId`が含まれていないため、以下の方法で抽出しています：

```typescript
// ~/.codex/sessions/YYYY/MM/DD/ からセッションファイルを検索
// ファイル名パターン: rollout-YYYY-MM-DDTHH-MM-SS-<session_id>.jsonl
const sessionId = extractLatestSessionId(beforeTimestamp);
```

この方法で取得した`conversationId`は正しいですが、`codex-reply`で使用できません。

## 回避策: `codex` ツールを使った疑似会話継続

### アプローチ

`codex-reply`の代わりに、新しい`codex`セッションを開始し、**会話履歴をプロンプトに含める**ことで文脈を維持します。

### 実装方法

1. **会話履歴の保存**
   ```typescript
   // result_summary.continuations 配列に各ターンを記録
   {
     continuations: [
       { at: "2025-11-15T...", prompt: "...", response: "..." },
       { at: "2025-11-15T...", prompt: "...", response: "..." }
     ]
   }
   ```

2. **新しいプロンプトの構築**
   ```typescript
   const fullPrompt = `# Original Goal
   ${job.spec_json.goal}

   # Previous Conversation
   User: package.jsonのversionを確認してください
   Assistant: Version in package.json:3 is 1.0.0. No edits were made.

   # New Request
   ${newUserPrompt}`;
   ```

3. **callCodex で新しいセッション実行**
   ```typescript
   const codexResult = await callCodex({
     prompt: fullPrompt,
     worktreePath: job.worktree_path,
     sandbox: 'workspace-write',
     approvalPolicy: 'never',
   });
   ```

4. **新しい conversationId を抽出**
   ```typescript
   const nextConversationId = extractLatestSessionId(beforeTimestamp);
   ```

### メリット

- ✅ Codex MCP serverのバグを回避できる
- ✅ 会話の文脈を維持できる
- ✅ 既存のworktreeを再利用できる
- ✅ 新しいconversationIdを取得できる

### デメリット

- ⚠️ 各会話継続で新しいCodexセッションが作成される
- ⚠️ 会話履歴が長くなるとプロンプトサイズが増大する
- ⚠️ 元のCodexセッションの完全な状態は再現できない（新しいセッションとして開始）

## 使用例

### MCP経由での会話継続

```bash
# 1. ジョブを作成
mcp__coduck-orchestrator__enqueue_codex_job \
  --goal "package.jsonを確認" \
  --context_files '["package.json"]' \
  --base_ref main

# 2. ジョブ完了後、conversationIdが記録される
# conversation_id: "019a8619-26e1-7522-8673-4b0c3e88ae10"

# 3. 会話を継続（新しいCodexセッションで実行）
mcp__coduck-orchestrator__continue_codex_job \
  --id "job-id" \
  --prompt "descriptionフィールドを更新してください"

# 内部的には、元のgoalと会話履歴を含む新しいプロンプトで
# 新しいCodexセッションが開始される
```

## 将来の改善案

Codex MCP serverが修正された場合：
1. `codex`ツールのレスポンスに`conversationId`が含まれるようになる
2. `codex-reply`がセッション間で正しく動作するようになる

その場合、このワークアラウンドから本来の`codex-reply`実装に戻すことができます。

## 参考リンク

- [Codex CLI Documentation](https://code.claude.com/docs/)
- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [Issue #3712](https://github.com/openai/codex/issues/3712)
- [Issue #4651](https://github.com/openai/codex/issues/4651)
