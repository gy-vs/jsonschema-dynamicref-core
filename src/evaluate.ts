import type { CompiledSchema, Schema, SchemaObject } from './compile.js';
import { escapePointer } from './uri.js';

export interface Issue {
  /** Instance location, '#' for the root, JSON-Pointer style below. */
  path: string;
  message: string;
  /** Every $ref/$dynamicRef hop that led to the failing schema node. */
  resolutionChain: string[];
}

/**
 * Marker for a (schema node, instance location) pair that is currently being
 * evaluated. Revisiting an in-progress pair means the schema recurses without
 * the instance making progress; that is reported as an error, never as success.
 */
const IN_PROGRESS: unique symbol = Symbol('in-progress');

type Memo = Map<string, Issue[] | typeof IN_PROGRESS>;

/**
 * Runtime validation frame state. `scope` is the dynamic scope: the stack of
 * resource URIs entered so far, ordered outermost-first. Per the 2020-12
 * dynamic-scope rules, a $dynamicRef binds to the first resource in this
 * ordering that defines a matching $dynamicAnchor (the resource evaluation
 * started from shadows identically named anchors in referenced resources);
 * the statically resolved bookend is the fallback.
 */
interface EvalState {
  compiled: CompiledSchema;
  scope: string[];
  memo: Memo;
}

export function evaluateRoot(compiled: CompiledSchema, value: unknown): Issue[] {
  const state: EvalState = {
    compiled,
    scope: [compiled.resourceOf[compiled.rootId]],
    memo: new Map(),
  };
  return evalNode(state, compiled.rootId, value, '#', []);
}

function issue(path: string, message: string, chain: string[]): Issue {
  return { path, message, resolutionChain: chain };
}

function evalNode(
  state: EvalState,
  id: number,
  value: unknown,
  path: string,
  chain: string[],
): Issue[] {
  const { compiled: c } = state;
  const schema = c.nodes[id];
  if (schema === true) return [];
  if (schema === false) return [issue(path, 'false schema: value not allowed', chain)];

  const key = `${id}␟${path}`;
  const prev = state.memo.get(key);
  if (prev === IN_PROGRESS) {
    return [
      issue(
        path,
        `cyclic evaluation: schema node #${id} is already being evaluated at '${path}' (in-progress is not success)`,
        chain,
      ),
    ];
  }
  if (prev !== undefined) return prev;
  state.memo.set(key, IN_PROGRESS);

  const issues: Issue[] = [];

  const sref = c.staticRefs.get(id);
  if (sref !== undefined) {
    if (sref.node === undefined) {
      issues.push(issue(path, `unresolvable $ref '${sref.uri}': ${sref.error ?? 'unknown'}`, chain));
    } else {
      const target = sref.node;
      const nextChain = [...chain, `$ref -> ${sref.uri}`];
      issues.push(...withinResource(state, sref.doc, () => evalNode(state, target, value, path, nextChain)));
    }
  }

  const dref = c.dynamicRefs.get(id);
  if (dref !== undefined) {
    if (dref.bookend === undefined) {
      issues.push(issue(path, `unresolvable $dynamicRef '${dref.uri}': ${dref.error ?? 'unknown'}`, chain));
    } else {
      let target = dref.bookend;
      let targetDoc = dref.doc;
      let via = 'static bookend';
      if (dref.dynamic) {
        for (const res of state.scope) {
          const node = c.dynamicAnchors.get(res)?.get(dref.name);
          if (node !== undefined) {
            target = node;
            targetDoc = res;
            via = `dynamic scope '${res}'`;
            break;
          }
        }
      }
      const nextChain = [...chain, `$dynamicRef(#${dref.name}) -> ${targetDoc}#${dref.name} [${via}]`];
      issues.push(...withinResource(state, targetDoc, () => evalNode(state, target, value, path, nextChain)));
    }
  }

  const s = schema as SchemaObject;
  if (s.type !== undefined && !typeMatches(value, s.type)) {
    issues.push(issue(path, `expected ${s.type}`, chain));
  }
  if (s.const !== undefined && !deepEqual(value, s.const)) {
    issues.push(issue(path, `expected const ${JSON.stringify(s.const)}`, chain));
  }
  if (s.enum !== undefined && !s.enum.some((e) => deepEqual(e, value))) {
    issues.push(issue(path, 'not in enum', chain));
  }

  if (isPlainObject(value)) {
    for (const key of s.required ?? []) {
      if (!(key in value)) issues.push(issue(`${path}/${escapePointer(key)}`, 'required', chain));
    }
    const props = s.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) issues.push(...evalChild(state, c, sub, value[key], `${path}/${escapePointer(key)}`, chain));
    }
    if (s.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          issues.push(...evalChild(state, c, s.additionalProperties as Schema, value[key], `${path}/${escapePointer(key)}`, chain));
        }
      }
    }
  }

  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => {
      issues.push(...evalChild(state, c, s.items as Schema, item, `${path}/${i}`, chain));
    });
  }

  for (const sub of s.allOf ?? []) issues.push(...evalChild(state, c, sub, value, path, chain));

  if (s.anyOf !== undefined) {
    const branches = s.anyOf.map((sub) => evalChild(state, c, sub, value, path, chain));
    if (branches.every((b) => b.length > 0)) {
      issues.push(issue(path, 'anyOf: no subschema matched', chain));
      for (const b of branches) issues.push(...b);
    }
  }

  if (s.not !== undefined && evalChild(state, c, s.not, value, path, chain).length === 0) {
    issues.push(issue(path, 'not: value matches the forbidden schema', chain));
  }

  state.memo.set(key, issues);
  return issues;
}

function evalChild(
  state: EvalState,
  c: CompiledSchema,
  sub: Schema,
  value: unknown,
  path: string,
  chain: string[],
): Issue[] {
  return evalNode(state, c.nodeId.get(sub)!, value, path, chain);
}

/** Run `fn` with `doc` pushed onto the dynamic scope when it differs from the current resource. */
function withinResource<T>(state: EvalState, doc: string, fn: () => T): T {
  if (state.scope[state.scope.length - 1] === doc) return fn();
  state.scope.push(doc);
  try {
    return fn();
  } finally {
    state.scope.pop();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(value: unknown, type: NonNullable<SchemaObject['type']>): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
