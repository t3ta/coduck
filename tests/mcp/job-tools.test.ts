import { describe, expect, test } from '../utils/jest-lite.js';
import {
  truncateResponseText,
  TRUNCATE_THRESHOLD,
  TRUNCATE_HEAD,
  TRUNCATE_TAIL,
  TRUNCATE_SEPARATOR,
} from '../../src/mcp/tools/job-tools.js';

describe('truncateResponseText', () => {
  test('should return text unchanged if under threshold', () => {
    const shortText = 'This is a short text.';
    const result = truncateResponseText(shortText);
    expect(result).toBe(shortText);
  });

  test('should return text unchanged if exactly at threshold', () => {
    const text = 'a'.repeat(TRUNCATE_THRESHOLD);
    const result = truncateResponseText(text);
    expect(result).toBe(text);
  });

  test('should truncate long text with head and tail', () => {
    const longText = 'a'.repeat(600);
    const result = truncateResponseText(longText);
    
    // Should have first TRUNCATE_HEAD chars, separator, then last TRUNCATE_TAIL chars
    expect(result.startsWith('a'.repeat(TRUNCATE_HEAD))).toBe(true);
    expect(result.includes(TRUNCATE_SEPARATOR)).toBe(true);
    expect(result.endsWith('a'.repeat(TRUNCATE_TAIL))).toBe(true);
  });

  test('should handle very long text', () => {
    const veryLongText = 'This is the beginning. ' + 'x'.repeat(1000) + ' This is the end.';
    const result = truncateResponseText(veryLongText);
    
    // Should start with the beginning
    expect(result.startsWith('This is the beginning.')).toBe(true);
    // Should end with the end
    expect(result.endsWith('This is the end.')).toBe(true);
    // Should have the truncation marker
    expect(result.includes(TRUNCATE_SEPARATOR)).toBe(true);
    // Should be shorter than original
    expect(result.length < veryLongText.length).toBe(true);
    // Expected length: TRUNCATE_HEAD + TRUNCATE_SEPARATOR + TRUNCATE_TAIL
    const expectedLength = TRUNCATE_HEAD + TRUNCATE_SEPARATOR.length + TRUNCATE_TAIL;
    expect(result.length).toBe(expectedLength);
  });

  test('should handle empty text', () => {
    const result = truncateResponseText('');
    expect(result).toBe('');
  });

  test('should handle text with newlines', () => {
    const textWithNewlines = 'Line 1\nLine 2\n' + 'x'.repeat(500) + '\nLast line';
    const result = truncateResponseText(textWithNewlines);
    
    expect(result.includes(TRUNCATE_SEPARATOR)).toBe(true);
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
    expect(result.includes(TRUNCATE_SEPARATOR)).toBe(true);
  });
});
