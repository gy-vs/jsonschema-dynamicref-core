import { describe, expect, it } from 'vitest';
import { compile, validate, type Resource, type Schema } from '../src/index.js';

describe('plain $ref', () => {
  const schema: Schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/pos' }, b: { $ref: '#/$defs/pos' } },
    $defs: { pos: { type: 'number' } },
  };

  it('accepts matching instances', () => {
    expect(compile(schema).validate({ a: 1, b: 2 })).toEqual([]);
  });

  it('reports instance path and resolution chain', () => {
    const issues = compile(schema).validate({ a: 'x' });
    expect(issues).toEqual([
      { path: '#/a', message: 'expected number', resolutionChain: ['#/$defs/pos'] },
    ]);
  });

  it('resolves plain-name anchors', () => {
    const s: Schema = { $defs: { x: { $anchor: 'thing', type: 'string' } }, $ref: '#thing' };
    expect(compile(s).validate('ok')).toEqual([]);
    expect(compile(s).validate(1)).toHaveLength(1);
  });
});

describe('cross-document references', () => {
  const child: Schema = {
    $id: 'https://ex.com/child.json',
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
  const root: Schema = {
    $id: 'https://ex.com/root.json',
    type: 'object',
    properties: { child: { $ref: 'child.json' } },
  };
  const validator = compile(root, {
    resources: [{ uri: 'https://ex.com/child.json', schema: child, revision: 1 }],
  });

  it('validates through the remote resource', () => {
    expect(validator.validate({ child: { name: 'n' } })).toEqual([]);
  });

  it('keeps the actual resolution chain and instance path in errors', () => {
    const issues = validator.validate({ child: { name: 5 } });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('#/child/name');
    expect(issues[0].message).toBe('expected string');
    expect(issues[0].resolutionChain).toEqual(['https://ex.com/child.json']);
    const missing = validator.validate({ child: {} });
    expect(missing[0]).toMatchObject({ path: '#/child/name', message: 'required' });
  });
});

describe('$dynamicRef / $dynamicAnchor', () => {
  it('outer dynamic anchor shadows the same-named inner one (typical dynamic resolution)', () => {
    const schema: Schema = {
      $id: 'https://ex.com/typical/root',
      $ref: 'list',
      $defs: {
        strictItems: { $dynamicAnchor: 'items', type: 'string' },
        list: {
          $id: 'list',
          type: 'array',
          items: { $dynamicRef: '#items' },
          $defs: { bookend: { $dynamicAnchor: 'items' } },
        },
      },
    };
    const v = compile(schema);
    expect(v.validate(['a', 'b'])).toEqual([]);
    const issues = v.validate(['a', 1]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: '#/1', message: 'expected string' });
  });

  it('resolves to the inner anchor when no outer scope defines it', () => {
    const list: Schema = {
      $id: 'https://ex.com/plain-list',
      type: 'array',
      items: { $dynamicRef: '#items' },
      $defs: { bookend: { $dynamicAnchor: 'items' } },
    };
    expect(compile(list).validate([1, 'anything'])).toEqual([]);
  });

  it('selects the anchor across resources via the runtime dynamic scope (strict-tree)', () => {
    const tree: Schema = {
      $id: 'https://ex.com/tree.json',
      $dynamicAnchor: 'node',
      type: 'object',
      properties: {
        data: { type: 'number' },
        children: { type: 'array', items: { $dynamicRef: '#node' } },
      },
    };
    const strict: Schema = {
      $id: 'https://ex.com/strict.json',
      $ref: 'tree.json',
      $dynamicAnchor: 'node',
      required: ['data'],
    };
    const strictV = compile(strict, {
      resources: [{ uri: 'https://ex.com/tree.json', schema: tree, revision: 1 }],
    });
    expect(strictV.validate({ data: 1, children: [{ data: 2, children: [] }] })).toEqual([]);
    const issues = strictV.validate({ data: 1, children: [{}] });
    expect(issues.map((i) => i.path)).toEqual(['#/children/0/data']);
    expect(issues[0].resolutionChain).toContain('https://ex.com/tree.json');
    expect(issues[0].resolutionChain).toContain('https://ex.com/strict.json');
    // The same tree schema alone imposes no "data" requirement.
    expect(compile(tree).validate({ children: [{}] })).toEqual([]);
  });

  it('behaves like a normal $ref when the static target is not a $dynamicAnchor', () => {
    const s: Schema = { $defs: { x: { $anchor: 'plain', type: 'number' } }, $dynamicRef: '#plain' };
    const v = compile(s);
    expect(v.validate(3)).toEqual([]);
    expect(v.validate('x')).toHaveLength(1);
  });
});

describe('recursion', () => {
  it('validates self-recursive schemas via $dynamicRef', () => {
    const linked: Schema = {
      $id: 'https://ex.com/linked',
      $dynamicAnchor: 'node',
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'number' }, next: { $dynamicRef: '#node' } },
    };
    const v = compile(linked);
    expect(v.validate({ value: 1, next: { value: 2, next: { value: 3 } } })).toEqual([]);
    const issues = v.validate({ value: 1, next: { value: 'x' } });
    expect(issues.map((i) => i.path)).toEqual(['#/next/value']);
  });

  it('validates self-recursive schemas via plain $ref', () => {
    const s: Schema = { type: 'object', properties: { child: { $ref: '#' }, n: { type: 'integer' } } };
    const v = compile(s);
    expect(v.validate({ n: 1, child: { n: 2, child: { n: 3 } } })).toEqual([]);
    expect(v.validate({ n: 1, child: { n: 2.5 } }).map((i) => i.path)).toEqual(['#/child/n']);
  });

  it('supports mutually recursive resources', () => {
    const a: Schema = {
      $id: 'https://ex.com/a.json',
      type: 'object',
      properties: { kind: { const: 'a' }, b: { $ref: 'b.json' } },
    };
    const b: Schema = {
      $id: 'https://ex.com/b.json',
      type: 'object',
      properties: { kind: { const: 'b' }, a: { $ref: 'a.json' } },
    };
    const v = compile(a, { resources: [{ uri: 'https://ex.com/b.json', schema: b }] });
    expect(v.validate({ kind: 'a', b: { kind: 'b', a: { kind: 'a' } } })).toEqual([]);
    const issues = v.validate({ kind: 'a', b: { kind: 'a' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: '#/b/kind', message: 'expected "b"' });
    expect(issues[0].resolutionChain).toEqual(['https://ex.com/b.json']);
  });

  it('does not treat an in-progress (node, instance) pair as success: direct self loop', () => {
    const issues = compile({ $ref: '#' }).validate(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/circular reference/);
  });

  it('does not treat an in-progress (node, instance) pair as success: $dynamicRef self loop', () => {
    const s: Schema = { $dynamicAnchor: 'x', $dynamicRef: '#x' };
    const issues = compile(s).validate({});
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/circular reference/);
  });

  it('detects infinite mutual recursion across resources', () => {
    const a2: Schema = { $id: 'https://ex.com/a2.json', $ref: 'b2.json' };
    const b2: Schema = { $id: 'https://ex.com/b2.json', $ref: 'a2.json' };
    const issues = compile(a2, { resources: [{ uri: 'https://ex.com/b2.json', schema: b2 }] }).validate({});
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/circular reference/);
    expect(issues[0].resolutionChain).toEqual(['https://ex.com/b2.json', 'https://ex.com/a2.json']);
  });
});

describe('missing anchors and resources', () => {
  it('rejects an unknown local anchor', () => {
    expect(() => compile({ $ref: '#nope' })).toThrow(/#nope/);
  });

  it('rejects an unknown resource', () => {
    expect(() => compile({ $ref: 'missing.json' })).toThrow(/missing\.json/);
  });

  it('rejects an unknown $dynamicRef target', () => {
    expect(() => compile({ $dynamicRef: '#gone' })).toThrow(/#gone/);
  });

  it('rejects a missing pointer in another resource', () => {
    const dep: Schema = { $id: 'https://ex.com/dep.json', $defs: { real: { type: 'string' } } };
    expect(() =>
      compile(
        { $ref: 'https://ex.com/dep.json#/$defs/imaginary' },
        { resources: [{ uri: 'https://ex.com/dep.json', schema: dep }] },
      ),
    ).toThrow(/imaginary/);
  });
});

describe('compile cache', () => {
  const root: Schema = { $id: 'https://ex.com/cache-root.json', $ref: 'dep.json' };
  const dep = (revision: number): Resource => ({
    uri: 'https://ex.com/dep.json',
    schema: { type: 'string' },
    revision,
  });

  it('reuses the compiled schema for identical options', () => {
    const c1 = compile(root, { resources: [dep(1)] });
    expect(compile(root, { resources: [dep(1)] })).toBe(c1);
  });

  it('distinguishes resource revisions', () => {
    const c1 = compile(root, { resources: [dep(1)] });
    expect(compile(root, { resources: [dep(2)] })).not.toBe(c1);
  });

  it('distinguishes dialects and root revisions', () => {
    const c1 = compile(root, { resources: [dep(1)] });
    expect(compile(root, { dialect: 'http://json-schema.org/draft-07/schema#', resources: [dep(1)] })).not.toBe(c1);
    expect(compile(root, { revision: 2, resources: [dep(1)] })).not.toBe(c1);
  });
});

describe('resource load order independence', () => {
  const makeRoot = (): Schema => ({
    $id: 'https://ex.com/main.json',
    type: 'object',
    properties: { a: { $ref: 'a.json' }, b: { $ref: 'b.json' } },
  });
  const ra: Resource = { uri: 'https://ex.com/a.json', schema: { $id: 'https://ex.com/a.json', type: 'string' }, revision: 1 };
  const rb: Resource = { uri: 'https://ex.com/b.json', schema: { $id: 'https://ex.com/b.json', type: 'number' }, revision: 1 };
  const instance = { a: 1, b: 'x' };

  it('produces identical results regardless of resource order', () => {
    const forward = compile(makeRoot(), { resources: [ra, rb] }).validate(instance);
    const reverse = compile(makeRoot(), { resources: [rb, ra] }).validate(instance);
    expect(forward).toHaveLength(2);
    expect(reverse).toEqual(forward);
  });

  it('shares the cache entry across resource orderings', () => {
    const shared = makeRoot();
    expect(compile(shared, { resources: [ra, rb] })).toBe(compile(shared, { resources: [rb, ra] }));
  });
});

describe('legacy validate()', () => {
  it('still validates simple schemas', () => {
    expect(validate({ type: 'string' }, 3)).toHaveLength(1);
    expect(validate({ type: 'string' }, 'x')).toEqual([]);
    expect(validate(true, 42)).toEqual([]);
    expect(validate(false, 42)).toHaveLength(1);
  });
});
