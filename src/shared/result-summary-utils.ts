/**
 * Utility functions for working with job result summaries
 */

/**
 * Parse a result summary from string or object format
 * @param value - The result summary value (string, object, or null)
 * @returns Parsed object or empty object if parsing fails
 */
export const parseResultSummary = (value: unknown): Record<string, unknown> => {
  if (!value) return {};

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      return { previous_summary: value };
    }
  }

  if (typeof value === 'object') {
    return { ...(value as Record<string, unknown>) };
  }

  return {};
};
