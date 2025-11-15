import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { clearSuites, runAllSuites } from './utils/jest-lite.js';

const isTestFile = (filePath: string): boolean => /\.test\.ts$/.test(filePath);

const collectTestFiles = (dir: string, results: string[]): void => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, results);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      results.push(fullPath);
    }
  }
};

const main = async () => {
  const testsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const repoRoot = path.resolve(testsDir, '..');
  const testFiles: string[] = [];
  collectTestFiles(testsDir, testFiles);
  collectTestFiles(path.join(repoRoot, 'src'), testFiles);

  if (testFiles.length === 0) {
    console.log('No test files found.');
    return;
  }

  clearSuites();

  testFiles.sort();

  for (const file of testFiles) {
    const fileUrl = pathToFileURL(file);
    await import(fileUrl.href);
  }

  const { failed, passed, failures } = await runAllSuites();
  console.log(`\nTest summary: ${passed} passed, ${failed} failed.`);
  if (failures.length) {
    for (const failure of failures) {
      const location = failure.suitePath ? `${failure.suitePath} > ${failure.testName}` : failure.testName;
      const message = failure.error instanceof Error ? failure.error.stack ?? failure.error.message : String(failure.error);
      console.error(`\n${location}\n${message}`);
    }
    process.exitCode = 1;
  }
};

await main();
