import assert from 'node:assert/strict';

export type Hook = () => void | Promise<void>;
export type TestFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
}

interface Suite {
  name: string;
  tests: TestCase[];
  beforeAll: Hook[];
  afterAll: Hook[];
  beforeEach: Hook[];
  afterEach: Hook[];
  children: Suite[];
  parent?: Suite;
}

const globalSuite: Suite = {
  name: '(root)',
  tests: [],
  beforeAll: [],
  afterAll: [],
  beforeEach: [],
  afterEach: [],
  children: [],
};

let currentSuite: Suite = globalSuite;

const runInSuite = (suite: Suite, fn: () => void) => {
  const previous = currentSuite;
  currentSuite = suite;
  try {
    fn();
  } finally {
    currentSuite = previous;
  }
};

export const describe = (name: string, fn: () => void): void => {
  const suite: Suite = {
    name,
    tests: [],
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
    children: [],
    parent: currentSuite,
  };
  currentSuite.children.push(suite);
  runInSuite(suite, fn);
};

export const test = (name: string, fn: TestFn): void => {
  currentSuite.tests.push({ name, fn });
};

export const it = test;

export const beforeAll = (fn: Hook): void => {
  currentSuite.beforeAll.push(fn);
};

export const afterAll = (fn: Hook): void => {
  currentSuite.afterAll.push(fn);
};

export const beforeEach = (fn: Hook): void => {
  currentSuite.beforeEach.push(fn);
};

export const afterEach = (fn: Hook): void => {
  currentSuite.afterEach.push(fn);
};

type MockCall = { args: unknown[]; result?: { type: 'return' | 'throw'; value: unknown } };

type MockState = {
  impl: (...args: unknown[]) => unknown;
  queue: Array<(...args: unknown[]) => unknown>;
};

interface MockFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T>;
  mock: {
    calls: Array<Parameters<T>>;
    results: Array<{ type: 'return' | 'throw'; value: ReturnType<T> | unknown }>;
  };
  mockImplementation(fn: T): MockFunction<T>;
  mockImplementationOnce(fn: T): MockFunction<T>;
  mockReturnValue(value: ReturnType<T>): MockFunction<T>;
  mockResolvedValue(value: Awaited<ReturnType<T>>): MockFunction<T>;
  mockRejectedValue(error: unknown): MockFunction<T>;
  mockClear(): void;
  mockReset(): void;
  mockRestore?(): void;
}

const createMock = <T extends (...args: any[]) => any>(impl?: T): MockFunction<T> => {
  const state: MockState = {
    impl: impl ?? (((..._args: unknown[]) => undefined) as (...args: unknown[]) => unknown),
    queue: [],
  };

  const calls: Array<Parameters<T>> = [];
  const results: Array<{ type: 'return' | 'throw'; value: unknown }> = [];

  const mockFn = ((...args: Parameters<T>) => {
    let fnToCall = state.impl;
    if (state.queue.length) {
      fnToCall = state.queue.shift()!;
    }
    try {
      const value = fnToCall(...args) as ReturnType<T>;
      calls.push(args);
      results.push({ type: 'return', value });
      return value;
    } catch (error) {
      calls.push(args);
      results.push({ type: 'throw', value: error });
      throw error;
    }
  }) as MockFunction<T>;

  mockFn.mock = { calls, results };

  mockFn.mockImplementation = (fn: T) => {
    state.impl = fn;
    return mockFn;
  };

  mockFn.mockImplementationOnce = (fn: T) => {
    state.queue.push(fn);
    return mockFn;
  };

  mockFn.mockReturnValue = (value: ReturnType<T>) => {
    state.impl = (() => value) as unknown as T;
    return mockFn;
  };

  mockFn.mockResolvedValue = (value: Awaited<ReturnType<T>>) => {
    state.impl = ((..._args: unknown[]) => Promise.resolve(value)) as unknown as T;
    return mockFn;
  };

  mockFn.mockRejectedValue = (error: unknown) => {
    state.impl = ((..._args: unknown[]) => Promise.reject(error)) as unknown as T;
    return mockFn;
  };

  mockFn.mockClear = () => {
    calls.length = 0;
    results.length = 0;
  };

  mockFn.mockReset = () => {
    mockFn.mockClear();
    state.impl = (((..._args: unknown[]) => undefined) as (...args: unknown[]) => unknown);
    state.queue = [];
  };

  return mockFn;
};

const spyOn = <T extends object, K extends keyof T>(object: T, method: K): MockFunction<T[K] extends (...args: any[]) => any ? T[K] : never> => {
  const original = object[method];
  if (typeof original !== 'function') {
    throw new Error(`Cannot spy on non-function property ${String(method)}`);
  }
  const mock = createMock(original as (...args: any[]) => unknown) as MockFunction<any>;
  const replacement = function (this: unknown, ...args: unknown[]) {
    return mock.apply(this, args);
  };
  Object.defineProperty(object, method, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: replacement,
  });
  mock.mockRestore = () => {
    Object.defineProperty(object, method, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: original,
    });
  };
  return mock;
};

const formatValue = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

class Expectation<T> {
  constructor(private readonly actual: T, private readonly negate = false) {}

  private check(condition: boolean, message: string): void {
    const pass = this.negate ? !condition : condition;
    if (!pass) {
      throw new Error(message);
    }
  }

  get not(): Expectation<T> {
    return new Expectation(this.actual, !this.negate);
  }

  toBe(expected: T): void {
    this.check(Object.is(this.actual, expected), `Expected ${formatValue(this.actual)} ${this.negate ? 'not ' : ''}to be ${formatValue(expected)}`);
  }

  toEqual(expected: unknown): void {
    try {
      assert.deepEqual(this.actual, expected);
      if (this.negate) {
        throw new Error('Expected values to not be equal');
      }
    } catch (error) {
      if (!this.negate) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  toStrictEqual(expected: unknown): void {
    try {
      assert.deepStrictEqual(this.actual, expected);
      if (this.negate) {
        throw new Error('Expected values to not be strictly equal');
      }
    } catch (error) {
      if (!this.negate) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  toMatchObject(expected: Record<string, unknown>): void {
    if (typeof this.actual !== 'object' || this.actual === null) {
      throw new Error('Actual value is not an object');
    }
    const actualRecord = this.actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actualRecord)) {
        if (!this.negate) {
          throw new Error(`Expected object to have key ${key}`);
        }
        return;
      }
      try {
        assert.deepStrictEqual(actualRecord[key], value);
        if (this.negate) {
          throw new Error(`Expected property ${key} to not match`);
        }
      } catch (error) {
        if (!this.negate) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }
  }

  toBeNull(): void {
    this.check(this.actual === null, `Expected ${formatValue(this.actual)} ${this.negate ? 'not ' : ''}to be null`);
  }

  toBeDefined(): void {
    this.check(this.actual !== undefined, `Expected value ${this.negate ? 'not ' : ''}to be defined`);
  }

  toBeTruthy(): void {
    this.check(Boolean(this.actual), `Expected ${formatValue(this.actual)} ${this.negate ? 'not ' : ''}to be truthy`);
  }

  toContain(expected: unknown): void {
    if (typeof this.actual === 'string') {
      this.check(this.actual.includes(String(expected)), `Expected string to ${this.negate ? 'not ' : ''}contain ${String(expected)}`);
      return;
    }
    if (Array.isArray(this.actual)) {
      this.check(this.actual.includes(expected), `Expected array to ${this.negate ? 'not ' : ''}contain ${formatValue(expected)}`);
      return;
    }
    throw new Error('Actual value does not support containment checks');
  }

  toHaveLength(expected: number): void {
    if (this.actual && typeof (this.actual as any).length === 'number') {
      this.check((this.actual as any).length === expected, `Expected length ${this.negate ? 'not ' : ''}to be ${expected} but received ${(this.actual as any).length}`);
      return;
    }
    throw new Error('Actual value does not have length property');
  }

  toThrow(expected?: RegExp | string): void {
    if (typeof this.actual !== 'function') {
      throw new Error('Actual value is not a function');
    }
    let threw = false;
    try {
      (this.actual as unknown as () => unknown)();
    } catch (error) {
      threw = true;
      if (expected instanceof RegExp) {
        const message = error instanceof Error ? error.message : String(error);
        this.check(expected.test(message), `Expected error message to match ${expected}, received ${message}`);
      } else if (typeof expected === 'string') {
        const message = error instanceof Error ? error.message : String(error);
        this.check(message.includes(expected), `Expected error message to include ${expected}, received ${message}`);
      }
    }
    this.check(threw, 'Expected function to throw');
  }
}

export const expect = <T>(actual: T): Expectation<T> => new Expectation(actual);

export const jest = {
  fn: createMock,
  spyOn,
};

export const getRootSuites = (): Suite[] => globalSuite.children;

export const clearSuites = (): void => {
  globalSuite.children = [];
  globalSuite.tests = [];
  globalSuite.beforeAll = [];
  globalSuite.afterAll = [];
  globalSuite.beforeEach = [];
  globalSuite.afterEach = [];
  currentSuite = globalSuite;
};

const gatherBeforeEach = (suite: Suite): Hook[] => {
  const hooks: Hook[] = [];
  let current: Suite | undefined = suite;
  while (current) {
    hooks.unshift(...current.beforeEach);
    current = current.parent;
  }
  return hooks;
};

const gatherAfterEach = (suite: Suite): Hook[] => {
  const hooks: Hook[] = [];
  let current: Suite | undefined = suite;
  while (current) {
    hooks.push(...current.afterEach);
    current = current.parent;
  }
  return hooks;
};

interface TestFailure {
  suitePath: string;
  testName: string;
  error: unknown;
}

const runHooks = async (hooks: Hook[], reverse = false): Promise<void> => {
  const ordered = reverse ? [...hooks].reverse() : hooks;
  for (const hook of ordered) {
    await hook();
  }
};

const suiteNamePath = (suite: Suite): string[] => {
  const names: string[] = [];
  let current: Suite | undefined = suite;
  while (current && current !== globalSuite) {
    names.unshift(current.name);
    current = current.parent;
  }
  return names;
};

const runSuite = async (suite: Suite, depth: number, failures: TestFailure[], stats: { passed: number; failed: number }): Promise<void> => {
  const indent = '  '.repeat(depth);
  if (suite !== globalSuite) {
    console.log(`${indent}${suite.name}`);
  }
  await runHooks(suite.beforeAll);
  for (const testCase of suite.tests) {
    const beforeEachHooks = gatherBeforeEach(suite);
    const afterEachHooks = gatherAfterEach(suite);
    const testIndent = '  '.repeat(suite === globalSuite ? depth : depth + 1);
    try {
      await runHooks(beforeEachHooks);
      await testCase.fn();
      console.log(`${testIndent}✓ ${testCase.name}`);
      stats.passed += 1;
    } catch (error) {
      failures.push({ suitePath: suiteNamePath(suite).join(' > '), testName: testCase.name, error });
      console.log(`${testIndent}✗ ${testCase.name}`);
      stats.failed += 1;
    } finally {
      try {
        await runHooks(afterEachHooks);
      } catch (error) {
        failures.push({ suitePath: suiteNamePath(suite).join(' > '), testName: `${testCase.name} (afterEach)`, error });
        console.log(`${testIndent}✗ ${testCase.name} (afterEach)`);
        stats.failed += 1;
      }
    }
  }
  for (const child of suite.children) {
    await runSuite(child, suite === globalSuite ? depth : depth + 1, failures, stats);
  }
  await runHooks(suite.afterAll, true);
};

export const runAllSuites = async (): Promise<{ failed: number; passed: number; failures: TestFailure[] }> => {
  const suites = getRootSuites();
  const failures: TestFailure[] = [];
  const stats = { passed: 0, failed: 0 };
  if (!suites.length && !globalSuite.tests.length) {
    console.log('No tests found.');
    return { failed: 0, passed: 0, failures: [] };
  }
  if (globalSuite.tests.length) {
    await runSuite(globalSuite, 0, failures, stats);
  }
  for (const suite of suites) {
    await runSuite(suite, 0, failures, stats);
  }
  return { ...stats, failures };
};

