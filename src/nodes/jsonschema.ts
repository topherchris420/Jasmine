/** Minimal JSON Schema subset (type, properties, required, items, enum, additionalProperties:false). */
export function validateJsonSchema(value: unknown, schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  const errors: string[] = [];
  const types = s['type'] === undefined ? undefined : Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type'] as string];
  if (types && !types.some((t) => matchesType(value, t))) {
    return [`${path}: expected ${types.join('|')}, got ${describe(value)}`];
  }
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s['enum'])}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    for (const key of (Array.isArray(s['required']) ? s['required'] : []) as string[]) {
      if (!(key in obj)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validateJsonSchema(obj[key], sub, `${path}.${key}`));
    }
    if (s['additionalProperties'] === false) {
      for (const key of Object.keys(obj)) if (!(key in props)) errors.push(`${path}.${key}: is not allowed`);
    }
  }
  if (Array.isArray(value) && s['items']) {
    value.forEach((item, i) => errors.push(...validateJsonSchema(item, s['items'], `${path}[${i}]`)));
  }
  return errors;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
