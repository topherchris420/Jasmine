import { describe, expect, it } from 'vitest';
import { getPath, parseJsonTemplate, parseRef, resolveCode, resolveJsonTemplate, resolveString, type Scope } from '../src/flow/template.ts';

const scope: Scope = new Map([
  ['n', { output: { items: [{ k: 'a' }, { k: 'b' }, { k: 'c' }], count: 3, text: 'hi' } }],
  ['llm', { output: { generatedResponse: 'He said "stop".\nThen: {"x": 1}' } }],
]);
const strict = { strict: true };

describe('reference paths (Studio reference syntax)', () => {
  it('parses dotted, index, slice and map segments', () => {
    const ref = parseRef('n.output.items[1:3]')!;
    expect(ref.nodeId).toBe('n');
    expect(getPath(scope.get('n'), ref.path)).toEqual([{ k: 'b' }, { k: 'c' }]);
    expect(resolveString('{{n.output.items[:].k}}', scope, strict)).toEqual(['a', 'b', 'c']);
    expect(resolveString('{{n.output.items[-1].k}}', scope, strict)).toBe('c');
  });

  it('keeps the raw type for whole-string references and stringifies when interpolating', () => {
    expect(resolveString('{{n.output.count}}', scope, strict)).toBe(3);
    expect(resolveString('count={{n.output.count}} first={{n.output.items[0]}}', scope, strict)).toBe('count=3 first={"k":"a"}');
  });

  it('fails loudly on unresolved references in strict mode, substitutes empty in lenient mode', () => {
    expect(() => resolveString('x {{n.output.missing}}', scope, strict)).toThrowError(/resolved to undefined/);
    expect(resolveString('x {{n.output.missing}}', scope, { strict: false })).toBe('x ');
    // Bare names that are not in scope are prompt placeholders (common in imported AgentKit prompts), left as text.
    expect(resolveString('Answer in {{language}} for {{n.output.count}} items', scope, strict)).toBe('Answer in {{language}} for 3 items');
    expect(resolveString('{{language}}', scope, strict)).toBe('{{language}}');
  });
});

describe('JSON templates (response outputMapping, apiNode headers/body, variables)', () => {
  const mapping = '{\n  "summary": "{{llm.output.generatedResponse}}",\n  "n": {{n.output.count}}\n}';

  it('parses before resolving, so model output with quotes/newlines/JSON cannot break or alter the structure', () => {
    expect(resolveJsonTemplate(mapping, scope, strict)).toEqual({ summary: 'He said "stop".\nThen: {"x": 1}', n: 3 });
  });

  it('reproduces the failure mode of resolve-then-parse (string splicing)', () => {
    const naive = (tpl: string, s: Scope) => JSON.parse(String(resolveString(tpl, s, { strict: false })));
    expect(() => naive(mapping, scope)).toThrow(SyntaxError);
    const injection: Scope = new Map([['llm', { output: { generatedResponse: 'ok", "isAdmin": true, "z": "' } }], ['n', { output: { count: 1 } }]]);
    expect(naive(mapping, injection)).toHaveProperty('isAdmin', true);
    expect(resolveJsonTemplate(mapping, injection, strict)).not.toHaveProperty('isAdmin');
  });

  it('rejects malformed templates at parse time', () => {
    expect(() => parseJsonTemplate('{"a": }')).toThrow();
  });
});

describe('code templates', () => {
  it('inlines values as JSON literals so they stay data', () => {
    const evil: Scope = new Map([['n', { output: { text: '"); process.exit(1); ("' } }]]);
    expect(resolveCode('const t = {{n.output.text}};', evil, strict)).toBe('const t = "\\"); process.exit(1); (\\"";');
  });
});
