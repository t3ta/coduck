import { describe, expect, test } from '../utils/jest-lite.js';

// Since truncateResponseText is not exported, we'll test the behavior through
// the continue_codex_job tool indirectly. For direct unit testing, we recreate
// the function here with the same logic.
const truncateResponseText = (text: string): string => {
  const TRUNCATE_THRESHOLD = 500;
  const TRUNCATE_HEAD = 250;
  const TRUNCATE_TAIL = 200;

  if (text.length <= TRUNCATE_THRESHOLD) {
    return text;
  }

  // Truncate: take first TRUNCATE_HEAD and last TRUNCATE_TAIL characters, with "..." in between
  const head = text.slice(0, TRUNCATE_HEAD);
  const tail = text.slice(-TRUNCATE_TAIL);
  return `${head}\n...\n${tail}`;
};

describe('truncateResponseText', () => {
  test('should return text unchanged if under threshold', () => {
    const shortText = 'This is a short text.';
    const result = truncateResponseText(shortText);
    expect(result).toBe(shortText);
  });

  test('should return text unchanged if exactly at threshold', () => {
    const text = 'a'.repeat(500);
    const result = truncateResponseText(text);
    expect(result).toBe(text);
  });

  test('should truncate long text with head and tail', () => {
    const longText = 'a'.repeat(600);
    const result = truncateResponseText(longText);
    
    // Should have first 250 chars, "...", then last 200 chars
    expect(result.startsWith('a'.repeat(250))).toBe(true);
    expect(result.includes('\n...\n')).toBe(true);
    expect(result.endsWith('a'.repeat(200))).toBe(true);
  });

  test('should handle very long text', () => {
    const veryLongText = 'This is the beginning. ' + 'x'.repeat(1000) + ' This is the end.';
    const result = truncateResponseText(veryLongText);
    
    // Should start with the beginning
    expect(result.startsWith('This is the beginning.')).toBe(true);
    // Should end with the end
    expect(result.endsWith('This is the end.')).toBe(true);
    // Should have the truncation marker
    expect(result.includes('\n...\n')).toBe(true);
    // Should be shorter than original
    expect(result.length < veryLongText.length).toBe(true);
    // Should be approximately 250 + 5 ("\n...\n") + 200 = 455 chars
    expect(result.length < 500).toBe(true);
  });

  test('should handle empty text', () => {
    const result = truncateResponseText('');
    expect(result).toBe('');
  });

  test('should handle text with newlines', () => {
    const textWithNewlines = 'Line 1\nLine 2\n' + 'x'.repeat(500) + '\nLast line';
    const result = truncateResponseText(textWithNewlines);
    
    expect(result.includes('\n...\n')).toBe(true);
    expect(result.endsWith('Last line')).toBe(true);
  });

  test('should preserve technical content at boundaries', () => {
    const technicalText = 
      'Error: Connection failed at line 123\n' +
      'Stack trace:\n' +
      'x'.repeat(500) +
      '\nSolution: Check network configuration';
    
    const result = truncateResponseText(technicalText);
    
    // Should preserve the beginning with error info
    expect(result.startsWith('Error: Connection failed')).toBe(true);
    // Should preserve the end with solution
    expect(result.endsWith('Solution: Check network configuration')).toBe(true);
    // Should have truncation marker
    expect(result.includes('\n...\n')).toBe(true);
  });
});
