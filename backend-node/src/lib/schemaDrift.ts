/**
 * Structural "shape" extraction + diffing for API contract/schema-drift
 * detection. Deliberately ignores values and only tracks the type/key
 * structure of a JSON response, so drift is reported even when a field's
 * value changes acceptably but its TYPE or presence does not.
 */

export type Shape =
  | { t: 'null' }
  | { t: 'string' | 'number' | 'boolean' | 'undefined' | 'unknown' }
  | { t: 'array'; items: Shape }
  | { t: 'object'; keys: Record<string, Shape> };

const MAX_DEPTH = 6;

export function extractShape(value: any, depth = 0): Shape {
  if (value === null) return { t: 'null' };
  if (Array.isArray(value)) {
    return { t: 'array', items: value.length > 0 ? extractShape(value[0], depth + 1) : { t: 'unknown' } };
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return { t: 'object', keys: {} };
    const keys: Record<string, Shape> = {};
    for (const key of Object.keys(value).sort()) {
      keys[key] = extractShape(value[key], depth + 1);
    }
    return { t: 'object', keys };
  }
  return { t: typeof value as any };
}

export interface SchemaDriftEntry {
  path: string;
  kind: 'added' | 'removed' | 'type_changed';
  expectedType?: string;
  actualType?: string;
}

export function diffShape(baseline: Shape, current: Shape, path = '$'): SchemaDriftEntry[] {
  const results: SchemaDriftEntry[] = [];

  if (baseline.t !== current.t) {
    results.push({ path, kind: 'type_changed', expectedType: baseline.t, actualType: current.t });
    return results; // types differ — no meaningful deeper comparison possible
  }

  if (baseline.t === 'object' && current.t === 'object') {
    const baseKeys = Object.keys(baseline.keys);
    const curKeys = Object.keys(current.keys);
    for (const k of baseKeys) {
      if (!curKeys.includes(k)) {
        results.push({ path: `${path}.${k}`, kind: 'removed', expectedType: baseline.keys[k]!.t });
      }
    }
    for (const k of curKeys) {
      if (!baseKeys.includes(k)) {
        results.push({ path: `${path}.${k}`, kind: 'added', actualType: current.keys[k]!.t });
      }
    }
    for (const k of baseKeys) {
      if (curKeys.includes(k)) {
        results.push(...diffShape(baseline.keys[k]!, current.keys[k]!, `${path}.${k}`));
      }
    }
  } else if (baseline.t === 'array' && current.t === 'array') {
    if (baseline.items.t !== 'unknown' && current.items.t !== 'unknown') {
      results.push(...diffShape(baseline.items, current.items, `${path}[]`));
    }
  }

  return results;
}
