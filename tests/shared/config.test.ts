import { describe, it, expect } from '../utils/jest-lite.js';
import { appConfig } from '../../src/shared/config.js';

describe('appConfig', () => {
  it('デフォルト値を持つ', () => {
    // デフォルト値または環境変数から設定された値を確認
    expect(typeof appConfig.worktreeBaseDir).toBe('string');
    expect(typeof appConfig.codexCliPath).toBe('string');
    expect(typeof appConfig.gitPath).toBe('string');
    expect(typeof appConfig.orchestratorPort).toBe('number');
    expect(typeof appConfig.orchestratorUrl).toBe('string');
    expect(typeof appConfig.workerPollIntervalMs).toBe('number');
    expect(typeof appConfig.workerConcurrency).toBe('number');
    expect(typeof appConfig.codexMcpTimeoutMs).toBe('number');
  });

  it('数値設定が有効な範囲内である', () => {
    // ポート番号は1-65535の範囲
    expect(appConfig.orchestratorPort).toBeTruthy();
    expect(appConfig.orchestratorPort > 0).toBe(true);
    expect(appConfig.orchestratorPort <= 65535).toBe(true);

    // ポーリング間隔は正の数
    expect(appConfig.workerPollIntervalMs > 0).toBe(true);

    // 並行実行数は正の数
    expect(appConfig.workerConcurrency > 0).toBe(true);

    // タイムアウトは正の数
    expect(appConfig.codexMcpTimeoutMs > 0).toBe(true);
  });

  it('orchestratorUrlが適切な形式である', () => {
    expect(appConfig.orchestratorUrl).toContain('http');
    expect(appConfig.orchestratorUrl.startsWith('http://')).toBe(true);
  });

  it('パスの設定が空でない', () => {
    expect(appConfig.worktreeBaseDir.length > 0).toBe(true);
    expect(appConfig.codexCliPath.length > 0).toBe(true);
    expect(appConfig.gitPath.length > 0).toBe(true);
  });

  it('オプション設定が正しい型である', () => {
    // codexReasoningSummary と codexReasoningFormat はオプション
    if (appConfig.codexReasoningSummary !== undefined) {
      expect(typeof appConfig.codexReasoningSummary).toBe('string');
    }
    if (appConfig.codexReasoningFormat !== undefined) {
      expect(typeof appConfig.codexReasoningFormat).toBe('string');
    }
  });
});
