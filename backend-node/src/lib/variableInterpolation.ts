/**
 * Shared {{name}} variable interpolation + dot/bracket-path resolution,
 * used by both ApiExecutionAgent and DbExecutionAgent so request/query
 * chaining works identically across API and DB testing.
 */

export function getByPath(obj: any, path: string): any {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

// Replaces {{varName}} placeholders anywhere in a string with the current variable value.
// Unresolved placeholders are left as-is so failures are visible in the request/query log rather than silently sent as empty strings.
export function interpolateString(str: string, variables: Record<string, any>): string {
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, varName) => {
    const val = variables[varName];
    return val !== undefined && val !== null ? String(val) : match;
  });
}

export function interpolateValue(value: any, variables: Record<string, any>): any {
  if (typeof value === 'string') return interpolateString(value, variables);
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, variables));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateValue(v, variables);
    return out;
  }
  return value;
}
