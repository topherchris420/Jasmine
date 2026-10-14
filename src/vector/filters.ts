import { EngineError } from '../errors.ts';

/**
 * Metadata filters. Accepts Weaviate-style `where` trees (the format imported vector-search nodes use):
 *   { operator: "And", operands: [{ path: ["category"], operator: "Equal", valueText: "faq" }, ...] }
 * and a shorthand map of exact matches: { "category": "faq", "year": 2024 }.
 */
export type MetadataFilter = FilterGroup | FilterLeaf | Record<string, unknown>;

interface FilterGroup {
  operator: 'And' | 'Or' | 'and' | 'or' | 'AND' | 'OR';
  operands: MetadataFilter[];
}

interface FilterLeaf {
  path: string | string[];
  operator: string;
  value?: unknown;
  valueText?: unknown;
  valueString?: unknown;
  valueInt?: unknown;
  valueNumber?: unknown;
  valueBoolean?: unknown;
  valueDate?: unknown;
  valueTextArray?: unknown;
  valueStringArray?: unknown;
  valueIntArray?: unknown;
  valueNumberArray?: unknown;
}

const LEAF_OPERATORS = new Set([
  'equal', 'notequal', 'greaterthan', 'greaterthanequal', 'lessthan', 'lessthanequal', 'like', 'containsany', 'containsall', 'isnull', 'in', 'notin',
]);

export function parseFilter(raw: unknown): MetadataFilter | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw new EngineError('BAD_PAYLOAD', `Filter is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return { operator: 'And', operands: value as MetadataFilter[] };
  }
  if (!value || typeof value !== 'object') throw new EngineError('BAD_PAYLOAD', 'Filter must be an object');
  if (Object.keys(value).length === 0) return undefined;
  validate(value as MetadataFilter);
  return value as MetadataFilter;
}

function isGroup(f: MetadataFilter): f is FilterGroup {
  return typeof (f as FilterGroup).operator === 'string' && Array.isArray((f as FilterGroup).operands);
}
function isLeaf(f: MetadataFilter): f is FilterLeaf {
  return typeof (f as FilterLeaf).operator === 'string' && 'path' in f;
}

function validate(f: MetadataFilter): void {
  if (isGroup(f)) {
    if (!/^(and|or)$/i.test(f.operator)) throw new EngineError('BAD_PAYLOAD', `Unknown filter combinator ${f.operator}`);
    f.operands.forEach(validate);
  } else if (isLeaf(f)) {
    if (!LEAF_OPERATORS.has(f.operator.toLowerCase())) throw new EngineError('BAD_PAYLOAD', `Unknown filter operator ${f.operator}`);
  }
}

function leafValue(leaf: FilterLeaf): unknown {
  for (const key of ['value', 'valueText', 'valueString', 'valueInt', 'valueNumber', 'valueBoolean', 'valueDate', 'valueTextArray', 'valueStringArray', 'valueIntArray', 'valueNumberArray'] as const) {
    if (leaf[key] !== undefined) return leaf[key];
  }
  return undefined;
}

export function getMeta(metadata: Record<string, unknown>, path: string | string[]): unknown {
  const parts = Array.isArray(path) ? path : path.split('.');
  let cur: unknown = metadata;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const asComparable = (v: unknown): number | string => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return Date.parse(v);
  return String(v);
};

const eq = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a)) return a.some((x) => eq(x, b));
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return asComparable(a) === asComparable(b);
};

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesFilter(metadata: Record<string, unknown>, filter: MetadataFilter | undefined): boolean {
  if (!filter) return true;
  if (isGroup(filter)) {
    const results = filter.operands.map((o) => matchesFilter(metadata, o));
    return /^or$/i.test(filter.operator) ? results.some(Boolean) : results.every(Boolean);
  }
  if (isLeaf(filter)) {
    const actual = getMeta(metadata, filter.path);
    const expected = leafValue(filter);
    const list = Array.isArray(expected) ? expected : [expected];
    switch (filter.operator.toLowerCase()) {
      case 'equal': return eq(actual, expected);
      case 'notequal': return !eq(actual, expected);
      case 'greaterthan': return actual !== undefined && asComparable(actual) > asComparable(expected);
      case 'greaterthanequal': return actual !== undefined && asComparable(actual) >= asComparable(expected);
      case 'lessthan': return actual !== undefined && asComparable(actual) < asComparable(expected);
      case 'lessthanequal': return actual !== undefined && asComparable(actual) <= asComparable(expected);
      case 'like': return actual !== undefined && likeToRegex(String(expected)).test(String(actual));
      case 'containsany':
      case 'in': return list.some((x) => eq(actual, x));
      case 'notin': return !list.some((x) => eq(actual, x));
      case 'containsall': return list.every((x) => eq(actual, x));
      case 'isnull': return (actual === undefined || actual === null) === (expected !== false);
      default: return false;
    }
  }
  // Shorthand: every key must match exactly.
  return Object.entries(filter).every(([k, v]) => eq(getMeta(metadata, k), v));
}
