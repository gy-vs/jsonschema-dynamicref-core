import { describe, expect, it } from 'vitest';
import { DIALECT_2020_12, Registry, type Schema } from '../src/index.js';

const tree: Schema = {
  $id: 'doc://tree/tree.json',
  $dynamicAnchor: 'node',
  type: 'object',
  required: ['data'],
  properties: {
    data: true,
    children: { type: 'array', items: { $dynamicRef: '#node' } },
  },
};

const strictTree: Schema = {
  $id: 'doc://tree/strict.json',
  $dynamicAnchor: 'node',
  $ref: 'tree.json',
  properties: { data: { type: 'number' } },
};

function registryWith(...entries: [string, Schema][]): Registry {
  const registry = new Registry();
  for (const [uri, schema] of entries) registry.addResource(uri, schema);
  return registry;
}

describe('plain $ref and cross-document references', () => {
  const defs: Schema = {
    $id: 'doc://example/defs.json',
    $defs: {
      name: { $anchor: 'name', type: 'string' },
      count: { type: 'integer' },
    },
  };
  const main: Schema = {
    $id: 'doc://example/main.json',
    type: 'object',
    required: ['title'],
    properties: {
      title: { $ref: 'defs.json#name' },
      count: { $ref: 'doc://example/defs.json#/$defs/count' },
    },
  };
  const validator = registryWith(['doc://example/defs.json', defs], ['doc://example/main.json', main]).compile(
    'doc://example/main.json',
  );

  it('accepts valid instances', () => {
    expect(validator.validate({ title: 'ok', count: 3 })).toEqual([]);
  });

  it('reports failures with instance path and resolution chain', () => {
    const issues = validator.validate({ title: 7, count: 'x' });
    expect(issues.map((i) => i.path).sort()).toEqual(['#/count', '#/title']);
    const title = issues.find((i) => i.path === '#/title')!;
    expect(title.message).toBe('expected string');
    expect(title.resolutionChain).toContain('$ref -> doc://example/defs.json#name');
    const count = issues.find((i) => i.path === '#/count')!;
    expect(count.resolutionChain).toContain('$ref -> doc://example/defs.json#/$defs/count');
  });

  it('still reports required alongside refs', () => {
    expect(validator.validate({})).toEqual([
      expect.objectContaining({ path: '#/title', message: 'required' }),
    ]);
  });
});

describe('same-name dynamic anchor shadowing', () => {
  // The outer document overrides the "items" anchor of the inner "list" resource.
  const root: Schema = {
    $id: 'doc://dyn/root',
    $ref: 'list',
    $defs: {
      foo: { $dynamicAnchor: 'items', type: 'string' },
      list: {
        $id: 'list',
        type: 'array',
        items: { $dynamicRef: '#items' },
        $defs: { items: { $dynamicAnchor: 'items' } },
      },
    },
  };
  const registry = registryWith(['doc://dyn/root', root]);

  it('outer anchor shadows the inner bookend', () => {
    const validator = registry.compile('doc://dyn/root');
    expect(validator.validate(['a', 'b'])).toEqual([]);
    const issues = validator.validate([42]);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('#/0');
    expect(issues[0].message).toBe('expected string');
    expect(issues[0].resolutionChain).toContain(
      "$dynamicRef(#items) -> doc://dyn/root#items [dynamic scope 'doc://dyn/root']",
    );
  });

  it('falls back to the static bookend when no outer anchor exists', () => {
    const validator = registry.compile('doc://dyn/list');
    expect(validator.validate([42])).toEqual([]);
    expect(validator.validate(['a'])).toEqual([]);
  });
});

describe('self recursion', () => {
  it('through $dynamicRef with shadowing (strict tree)', () => {
    const validator = registryWith(['doc://tree/tree.json', tree], ['doc://tree/strict.json', strictTree]).compile(
      'doc://tree/strict.json',
    );
    expect(validator.validate({ data: 1, children: [{ data: 2, children: [{ data: 3 }] }] })).toEqual([]);
    const bad = { data: 1, children: [{ data: 2, children: [{ data: 'x' }] }] };
    const issues = validator.validate(bad);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('#/children/0/children/0/data');
    expect(issues[0].message).toBe('expected number');
    // The chain records the dynamic hops back into strict.json at every level.
    expect(
      issues[0].resolutionChain.filter((e) => e.includes('$dynamicRef(#node) -> doc://tree/strict.json#node')),
    ).toHaveLength(2);
    expect(issues[0].resolutionChain).toContain('$ref -> doc://tree/tree.json');
  });

  it('unshadowed recursion uses the bookend', () => {
    const validator = registryWith(['doc://tree/tree.json', tree]).compile('doc://tree/tree.json');
    expect(validator.validate({ data: 1, children: [{ data: 'anything' }] })).toEqual([]);
    expect(validator.validate({ data: 1, children: [{}] })).toEqual([
      expect.objectContaining({ path: '#/children/0/data', message: 'required' }),
    ]);
  });

  it('through plain $ref to the document root', () => {
    const linkedList: Schema = {
      $id: 'doc://rec/list.json',
      type: 'object',
      properties: { value: { type: 'number' }, next: { $ref: '#' } },
    };
    const validator = registryWith(['doc://rec/list.json', linkedList]).compile('doc://rec/list.json');
    expect(validator.validate({ value: 1, next: { value: 2, next: { value: 3 } } })).toEqual([]);
    const issues = validator.validate({ value: 1, next: { value: 2, next: { value: 'x' } } });
    expect(issues).toEqual([expect.objectContaining({ path: '#/next/next/value', message: 'expected number' })]);
  });
});

describe('mutual recursion across documents', () => {
  const a: Schema = { $id: 'doc://mut/a.json', type: 'object', properties: { b: { $ref: 'b.json' } } };
  const b: Schema = { $id: 'doc://mut/b.json', type: 'object', properties: { a: { $ref: 'a.json' } } };
  const validator = registryWith(['doc://mut/a.json', a], ['doc://mut/b.json', b]).compile('doc://mut/a.json');

  it('terminates while the instance makes progress', () => {
    expect(validator.validate({ b: { a: { b: {} } } })).toEqual([]);
    const issues = validator.validate({ b: { a: { b: { a: 1 } } } });
    expect(issues).toEqual([expect.objectContaining({ path: '#/b/a/b/a', message: 'expected object' })]);
    expect(issues[0].resolutionChain).toEqual([
      '$ref -> doc://mut/b.json',
      '$ref -> doc://mut/a.json',
      '$ref -> doc://mut/b.json',
      '$ref -> doc://mut/a.json',
    ]);
  });
});

describe('missing anchors and resources', () => {
  it('reports unresolvable refs instead of crashing', () => {
    const broken: Schema = {
      $id: 'doc://miss/m.json',
      properties: {
        x: { $ref: '#nope' },
        y: { $ref: 'other.json#/$defs/absent' },
        z: { $ref: 'ghost.json' },
      },
    };
    const validator = registryWith(['doc://miss/m.json', broken]).compile('doc://miss/m.json');
    const issues = validator.validate({ x: 1, y: 2, z: 3 });
    expect(issues.map((i) => i.path).sort()).toEqual(['#/x', '#/y', '#/z']);
    expect(issues.find((i) => i.path === '#/x')!.message).toContain("no such anchor '#nope'");
    expect(issues.find((i) => i.path === '#/y')!.message).toContain("no such pointer '#/$defs/absent'");
    expect(issues.find((i) => i.path === '#/z')!.message).toContain("unknown resource 'doc://miss/ghost.json'");
  });

  it('reports unresolvable $dynamicRef', () => {
    const broken: Schema = { $id: 'doc://miss/d.json', items: { $dynamicRef: '#gone' } };
    const validator = registryWith(['doc://miss/d.json', broken]).compile('doc://miss/d.json');
    expect(validator.validate([1])).toEqual([
      expect.objectContaining({ path: '#/0', message: expect.stringContaining("unresolvable $dynamicRef") }),
    ]);
  });
});

describe('cyclic evaluation is not success', () => {
  it('direct self-cycle through $ref', () => {
    const cyc: Schema = { $id: 'doc://cyc/c.json', $ref: '#' };
    const validator = registryWith(['doc://cyc/c.json', cyc]).compile('doc://cyc/c.json');
    const issues = validator.validate(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('cyclic evaluation');
    expect(issues[0].path).toBe('#');
  });

  it('mutual cycle without instance progress', () => {
    const a: Schema = { $id: 'doc://cyc/a.json', $ref: 'b.json' };
    const b: Schema = { $id: 'doc://cyc/b.json', $ref: 'a.json' };
    const validator = registryWith(['doc://cyc/a.json', a], ['doc://cyc/b.json', b]).compile('doc://cyc/a.json');
    const issues = validator.validate({});
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('cyclic evaluation');
  });

  it('memoizes completed pairs without false cycles', () => {
    // allOf evaluates the same node twice at the same instance location:
    // the second pass must reuse the memoized result, not report a cycle.
    const schema: Schema = {
      $id: 'doc://memo/m.json',
      allOf: [{ $ref: '#/$defs/num' }, { $ref: '#/$defs/num' }],
      $defs: { num: { type: 'number' } },
    };
    const validator = registryWith(['doc://memo/m.json', schema]).compile('doc://memo/m.json');
    expect(validator.validate(5)).toEqual([]);
    const issues = validator.validate('x');
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.message === 'expected number')).toBe(true);
  });
});

describe('compile cache', () => {
  it('reuses validators and distinguishes revision and dialect', () => {
    const registry = new Registry();
    registry.addResource('doc://c/a.json', { type: 'string' }, { revision: 1 });
    const v1 = registry.compile('doc://c/a.json');
    expect(registry.compile('doc://c/a.json')).toBe(v1);

    // Same content and revision, fresh registry: still the cached validator.
    const registry2 = new Registry();
    registry2.addResource('doc://c/a.json', { type: 'string' }, { revision: 1 });
    expect(registry2.compile('doc://c/a.json')).toBe(v1);

    // Revision bump recompiles even though the URI is unchanged.
    registry.addResource('doc://c/a.json', { type: 'number' }, { revision: 2 });
    const v2 = registry.compile('doc://c/a.json');
    expect(v2).not.toBe(v1);
    expect(v2.validate('x')).toHaveLength(1);
    expect(v1.validate('x')).toEqual([]); // cached validator is unaffected

    // Dialect is part of the cache key.
    registry.addResource('doc://c/a.json', { type: 'number' }, { revision: 2, dialect: 'http://json-schema.org/draft-07/schema#' });
    const v3 = registry.compile('doc://c/a.json');
    expect(v3).not.toBe(v2);
  });

  it('dialect controls whether dynamic keywords are honored', () => {
    const root: Schema = {
      $id: 'doc://d/root',
      $ref: 'list',
      $defs: {
        foo: { $dynamicAnchor: 'items', type: 'string' },
        list: { $id: 'list', type: 'array', items: { $dynamicRef: '#items' }, $defs: { items: { $dynamicAnchor: 'items' } } },
      },
    };
    const modern = registryWith(['doc://d/root', root]).compile('doc://d/root');
    expect(modern.compiled.resourceDialect.get('doc://d/root')).toBe(DIALECT_2020_12);
    expect(modern.validate([42])).toHaveLength(1);

    const legacy = new Registry();
    legacy.addResource('doc://d/root', root, { dialect: 'http://json-schema.org/draft-07/schema#' });
    const legacyValidator = legacy.compile('doc://d/root');
    expect(legacyValidator).not.toBe(modern);
    expect(legacyValidator.validate([42])).toEqual([]); // $dynamicRef ignored pre-2020-12
  });
});

describe('load order independence', () => {
  const bad = { data: 1, children: [{ data: 'x' }] };

  it('validation results do not depend on registration order', () => {
    const forward = registryWith(['doc://tree/tree.json', tree], ['doc://tree/strict.json', strictTree])
      .compile('doc://tree/strict.json')
      .validate(bad);
    const reverse = registryWith(['doc://tree/strict.json', strictTree], ['doc://tree/tree.json', tree])
      .compile('doc://tree/strict.json')
      .validate(bad);
    expect(forward.length).toBeGreaterThan(0);
    expect(reverse).toEqual(forward);
  });

  it('compile cache key does not depend on registration order', () => {
    const r1 = registryWith(['doc://tree/tree.json', tree], ['doc://tree/strict.json', strictTree]);
    const r2 = registryWith(['doc://tree/strict.json', strictTree], ['doc://tree/tree.json', tree]);
    expect(r1.compile('doc://tree/strict.json')).toBe(r2.compile('doc://tree/strict.json'));
  });
});
