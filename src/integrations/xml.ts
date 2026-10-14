/**
 * Small XML → JSON converter for API responses and feeds. Attributes become `@name`, text becomes
 * `#text` (or the value itself for text-only elements), repeated children become arrays.
 */
export function xmlToJson(xml: string): unknown {
  const root: XmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[2] !== undefined) {
      if (stack.length > 1 && top.name === m[2]) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
      const el: XmlElement = { name: m[3], attrs, children: [] };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) {
      const text = decodeEntities(m[6]);
      if (text.trim()) top.children.push(text);
    }
  }
  const out: Record<string, unknown> = {};
  for (const child of root.children) if (typeof child !== 'string') append(out, child.name, toJson(child));
  return out;
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: (XmlElement | string)[];
}

function toJson(el: XmlElement): unknown {
  const elements = el.children.filter((c): c is XmlElement => typeof c !== 'string');
  const text = el.children.filter((c): c is string => typeof c === 'string').join('').trim();
  const attrKeys = Object.keys(el.attrs);
  if (elements.length === 0 && attrKeys.length === 0) return text;
  const out: Record<string, unknown> = {};
  for (const k of attrKeys) out[`@${k}`] = el.attrs[k];
  for (const child of elements) append(out, child.name, toJson(child));
  if (text) out['#text'] = text;
  return out;
}

function append(target: Record<string, unknown>, key: string, value: unknown) {
  if (!(key in target)) target[key] = value;
  else if (Array.isArray(target[key])) (target[key] as unknown[]).push(value);
  else target[key] = [target[key], value];
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[lower] ?? _;
  });
}
