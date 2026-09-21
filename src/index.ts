/**
 * JSON Schema 2020-12 validator with $ref / $dynamicRef / $dynamicAnchor support.
 *
 * Compile phase builds, for every schema resource, a node table plus anchor and
 * JSON-Pointer lookup tables keyed by absolute base URI; all references are
 * resolved only after every resource is registered, so results never depend on
 * the order in which resources were supplied.
 *
 * Runtime validation frames carry the dynamic scope (the stack of resources
 * entered so far). A $dynamicRef whose static target is a $dynamicAnchor
 * (the "bookending" requirement) is re-resolved against the dynamic scope,
 * outermost resource first, falling back to the static target.
 */

export const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type Schema = boolean | SchemaObject;

export interface SchemaObject {
  $id?: string;
  $anchor?: string;
  $dynamicAnchor?: string;
  $ref?: string;
  $dynamicRef?: string;
  $defs?: Record<string, Schema>;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  not?: Schema;
  const?: unknown;
  enum?: unknown[];
}

export interface Issue {
  /** JSON Pointer to the offending instance location, e.g. "#/a/0". */
  path: string;
  message: string;
  /** URIs actually entered through $ref / $dynamicRef, outermost first. */
  resolutionChain?: string[];
}

export interface Resource {
  uri: string;
  schema: Schema;
  /** Bump when the schema content changes; part of the compile-cache key. */
  revision?: string | number;
}

export interface CompileOptions {
  dialect?: string;
  /** Revision of the root schema; part of the compile-cache key. */
  revision?: string | number;
  resources?: Resource[];
}

export interface CompiledSchema {
  readonly dialect: string;
  validate(value: unknown, path?: string): Issue[];
}

// ---------------------------------------------------------------------------
// Compiled representation
// ---------------------------------------------------------------------------

interface CResource {
  id: number;
  uri: string;
  root: CNode;
  anchors: Map<string, CNode>;
  dynamicAnchors: Map<string, CNode>;
  /** Escaped JSON Pointer (without leading '#') -> node, for pointer fragments. */
  pointers: Map<string, CNode>;
}

interface CNode {
  id: number;
  resource: CResource;
  /** Absolute URI of this node (base URI plus pointer fragment), for messages. */
  uri: string;
  baseUri: string;
  bool?: boolean;
  dynamicAnchorName?: string;
  refUri?: string;
  refTarget?: CNode;
  dynamicRefStatic?: CNode;
  /** Set when the static $dynamicRef target is a $dynamicAnchor (bookending). */
  dynamicRefName?: string;
  type?: string;
  required?: string[];
  properties?: [string, CNode][];
  items?: CNode;
  additionalProperties?: CNode | false;
  allOf?: CNode[];
  anyOf?: CNode[];
  not?: CNode;
  hasConst?: boolean;
  constValue?: unknown;
  enum?: unknown[];
}

const escPointer = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

function resolveUri(base: string, ref: string): string {
  try {
    return base ? new URL(ref, base).href : new URL(ref).href;
  } catch {
    // Non-hierarchical base (URN, empty base, plain name): use ref verbatim.
    return ref;
  }
}

// ---------------------------------------------------------------------------
// Compiler: two phases (build all resources, then resolve every reference)
// ---------------------------------------------------------------------------

class Compiler {
  private readonly resources = new Map<string, CResource>();
  private readonly pending: { node: CNode; ref: string; dynamic: boolean }[] = [];
  private nextNodeId = 0;
  private nextResourceId = 0;

  compile(rootSchema: Schema, extra: Resource[]): CNode {
    for (const r of extra) {
      const declared =
        typeof r.schema === 'object' && typeof r.schema.$id === 'string'
          ? resolveUri('', r.schema.$id)
          : r.uri;
      const res = this.buildResource(r.schema, declared);
      if (declared !== r.uri && !this.resources.has(r.uri)) this.resources.set(r.uri, res);
    }
    const rootUri =
      typeof rootSchema === 'object' && typeof rootSchema.$id === 'string'
        ? resolveUri('', rootSchema.$id)
        : '';
    const root = this.buildResource(rootSchema, rootUri);
    this.resolveRefs();
    return root.root;
  }

  private buildResource(schema: Schema, uri: string): CResource {
    if (this.resources.has(uri)) throw new Error(`duplicate schema resource: '${uri || '(root)'}'`);
    const res: CResource = {
      id: this.nextResourceId++,
      uri,
      root: undefined as never,
      anchors: new Map(),
      dynamicAnchors: new Map(),
      pointers: new Map(),
    };
    this.resources.set(uri, res);
    res.root = this.buildNode(schema, res, uri, '');
    return res;
  }

  private buildNode(schema: Schema, res: CResource, baseUri: string, pointer: string): CNode {
    if (typeof schema === 'boolean') {
      const node = this.newNode(res, baseUri, pointer);
      node.bool = schema;
      return node;
    }
    if (typeof schema.$id === 'string' && pointer !== '') {
      // Embedded resource: gets its own base URI and anchor tables, but stays
      // reachable through the parent's pointer space as well.
      const child = this.buildResource(schema, resolveUri(baseUri, schema.$id));
      res.pointers.set(pointer, child.root);
      return child.root;
    }
    const node = this.newNode(res, baseUri, pointer);
    if (schema.$anchor !== undefined) res.anchors.set(schema.$anchor, node);
    if (schema.$dynamicAnchor !== undefined) {
      res.dynamicAnchors.set(schema.$dynamicAnchor, node);
      node.dynamicAnchorName = schema.$dynamicAnchor;
    }
    if (schema.$ref !== undefined) this.pending.push({ node, ref: schema.$ref, dynamic: false });
    if (schema.$dynamicRef !== undefined) this.pending.push({ node, ref: schema.$dynamicRef, dynamic: true });
    if (schema.type !== undefined) node.type = schema.type;
    if (schema.required !== undefined) node.required = [...schema.required];
    if (schema.properties !== undefined) {
      node.properties = Object.entries(schema.properties).map(([k, v]) => [
        k,
        this.buildNode(v, res, baseUri, `${pointer}/properties/${escPointer(k)}`),
      ]);
    }
    if (schema.items !== undefined) node.items = this.buildNode(schema.items, res, baseUri, `${pointer}/items`);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      node.additionalProperties =
        schema.additionalProperties === false
          ? false
          : this.buildNode(schema.additionalProperties, res, baseUri, `${pointer}/additionalProperties`);
    }
    if (schema.allOf !== undefined)
      node.allOf = schema.allOf.map((s, i) => this.buildNode(s, res, baseUri, `${pointer}/allOf/${i}`));
    if (schema.anyOf !== undefined)
      node.anyOf = schema.anyOf.map((s, i) => this.buildNode(s, res, baseUri, `${pointer}/anyOf/${i}`));
    if (schema.not !== undefined) node.not = this.buildNode(schema.not, res, baseUri, `${pointer}/not`);
    if (schema.$defs !== undefined) {
      for (const [k, v] of Object.entries(schema.$defs))
        this.buildNode(v, res, baseUri, `${pointer}/$defs/${escPointer(k)}`);
    }
    if ('const' in schema) {
      node.hasConst = true;
      node.constValue = schema.const;
    }
    if (schema.enum !== undefined) node.enum = schema.enum;
    return node;
  }

  private newNode(res: CResource, baseUri: string, pointer: string): CNode {
    const node: CNode = {
      id: this.nextNodeId++,
      resource: res,
      baseUri,
      uri: pointer ? `${baseUri}#${pointer}` : baseUri,
    };
    res.pointers.set(pointer, node);
    return node;
  }

  private resolveRefs(): void {
    for (const { node, ref, dynamic } of this.pending) {
      const keyword = dynamic ? '$dynamicRef' : '$ref';
      const resolved = resolveUri(node.baseUri, ref);
      const hash = resolved.indexOf('#');
      const doc = hash < 0 ? resolved : resolved.slice(0, hash);
      const frag = hash < 0 ? '' : resolved.slice(hash + 1);
      const res = this.resources.get(doc);
      if (res === undefined)
        throw new Error(`cannot resolve ${keyword} '${ref}' at '${node.uri || '(root)'}': unknown resource '${doc}'`);
      let target: CNode | undefined;
      if (frag === '') target = res.root;
      else if (frag.startsWith('/')) target = res.pointers.get(frag);
      else target = res.anchors.get(frag) ?? res.dynamicAnchors.get(frag);
      if (target === undefined)
        throw new Error(
          `cannot resolve ${keyword} '${ref}' at '${node.uri || '(root)'}': no such fragment '#${frag}' in resource '${doc || '(root)'}'`,
        );
      if (dynamic) {
        node.dynamicRefStatic = target;
        if (target.dynamicAnchorName !== undefined) node.dynamicRefName = target.dynamicAnchorName;
      } else {
        node.refTarget = target;
        node.refUri = target.uri;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface RunCtx {
  /** Dynamic scope: resources entered so far, outermost first. */
  scope: CResource[];
  /** URIs entered through references, for Issue.resolutionChain. */
  chain: string[];
  /** Completed results, keyed by (node, instance location, dynamic scope). */
  memo: Map<string, Issue[]>;
  /** (node, instance location) pairs currently being evaluated. */
  inProgress: Set<string>;
}

function resolveDynamic(ctx: RunCtx, node: CNode): CNode {
  if (node.dynamicRefName !== undefined) {
    for (const res of ctx.scope) {
      const hit = res.dynamicAnchors.get(node.dynamicRefName);
      if (hit !== undefined) return hit;
    }
  }
  return node.dynamicRefStatic as CNode;
}

function runNode(ctx: RunCtx, node: CNode, value: unknown, path: string): Issue[] {
  if (node.bool !== undefined) {
    return node.bool ? [] : [mkIssue(ctx, path, 'boolean schema is false')];
  }
  const instKey = `${node.id}@${path}`;
  const scopeKey = `${instKey}|${ctx.scope.map((r) => r.id).join(',')}`;
  const cached = ctx.memo.get(scopeKey);
  if (cached !== undefined) return cached;
  if (ctx.inProgress.has(instKey)) {
    // Same (schema node, instance location) already on the stack: the schema
    // recurses without consuming instance, i.e. an infinite loop. Report it as
    // an error instead of treating the in-progress pair as a success.
    return [mkIssue(ctx, path, `circular reference: evaluation of '${node.uri || '(root)'}' loops without consuming the instance`)];
  }
  ctx.inProgress.add(instKey);
  const pushed = ctx.scope[ctx.scope.length - 1] !== node.resource;
  if (pushed) ctx.scope.push(node.resource);
  const issues: Issue[] = [];
  try {
    if (node.refTarget !== undefined) {
      ctx.chain.push(node.refUri as string);
      issues.push(...runNode(ctx, node.refTarget, value, path));
      ctx.chain.pop();
    }
    if (node.dynamicRefStatic !== undefined) {
      const target = resolveDynamic(ctx, node);
      ctx.chain.push(target.uri);
      issues.push(...runNode(ctx, target, value, path));
      ctx.chain.pop();
    }
    evalKeywords(ctx, node, value, path, issues);
  } finally {
    if (pushed) ctx.scope.pop();
    ctx.inProgress.delete(instKey);
  }
  ctx.memo.set(scopeKey, issues);
  return issues;
}

function mkIssue(ctx: RunCtx, path: string, message: string): Issue {
  return ctx.chain.length > 0 ? { path, message, resolutionChain: [...ctx.chain] } : { path, message };
}

function evalKeywords(ctx: RunCtx, node: CNode, value: unknown, path: string, issues: Issue[]): void {
  if (node.type !== undefined && !typeOk(node.type, value)) issues.push(mkIssue(ctx, path, `expected ${node.type}`));
  if (node.hasConst === true && !deepEqual(value, node.constValue))
    issues.push(mkIssue(ctx, path, `expected ${JSON.stringify(node.constValue)}`));
  if (node.enum !== undefined && !node.enum.some((e) => deepEqual(e, value)))
    issues.push(mkIssue(ctx, path, 'not in enum'));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    for (const key of node.required ?? [])
      if (!(key in row)) issues.push(mkIssue(ctx, `${path}/${escPointer(key)}`, 'required'));
    const declared = new Set((node.properties ?? []).map(([k]) => k));
    for (const [key, child] of node.properties ?? [])
      if (key in row) issues.push(...runNode(ctx, child, row[key], `${path}/${escPointer(key)}`));
    if (node.additionalProperties !== undefined) {
      for (const key of Object.keys(row)) {
        if (declared.has(key)) continue;
        if (node.additionalProperties === false)
          issues.push(mkIssue(ctx, `${path}/${escPointer(key)}`, 'additional property not allowed'));
        else issues.push(...runNode(ctx, node.additionalProperties, row[key], `${path}/${escPointer(key)}`));
      }
    }
  }
  if (Array.isArray(value) && node.items !== undefined) {
    value.forEach((item, i) => issues.push(...runNode(ctx, node.items as CNode, item, `${path}/${i}`)));
  }
  for (const sub of node.allOf ?? []) issues.push(...runNode(ctx, sub, value, path));
  if (node.anyOf !== undefined && !node.anyOf.some((sub) => runNode(ctx, sub, value, path).length === 0))
    issues.push(mkIssue(ctx, path, 'did not match anyOf'));
  if (node.not !== undefined && runNode(ctx, node.not, value, path).length === 0)
    issues.push(mkIssue(ctx, path, 'must not match "not" schema'));
}

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => deepEqual(x, (b as unknown[])[i]))
    );
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

class CompiledValidator implements CompiledSchema {
  constructor(
    private readonly root: CNode,
    readonly dialect: string,
  ) {}

  validate(value: unknown, path = '#'): Issue[] {
    const ctx: RunCtx = { scope: [], chain: [], memo: new Map(), inProgress: new Set() };
    return runNode(ctx, this.root, value, path);
  }
}

function doCompile(schema: Schema, options: CompileOptions, dialect: string): CompiledSchema {
  const root = new Compiler().compile(schema, options.resources ?? []);
  return new CompiledValidator(root, dialect);
}

/**
 * Compile-cache: keyed by root schema object identity, then by a string of
 * dialect + root revision + sorted resource uri@revision pairs. Results are
 * therefore independent of resource order, and any dialect or revision change
 * produces a fresh compiled schema.
 */
const compileCache = new WeakMap<object, Map<string, CompiledSchema>>();

export function compile(schema: Schema, options: CompileOptions = {}): CompiledSchema {
  const dialect = options.dialect ?? DIALECT_2020_12;
  const revision = String(options.revision ?? 0);
  const resources = options.resources ?? [];
  const resourceKey = resources
    .map((r) => `${r.uri}@${String(r.revision ?? 0)}`)
    .sort()
    .join('|');
  const cacheKey = `${dialect}\n${revision}\n${resourceKey}`;
  if (typeof schema !== 'object' || schema === null) return doCompile(schema, options, dialect);
  let byKey = compileCache.get(schema);
  if (byKey === undefined) {
    byKey = new Map();
    compileCache.set(schema, byKey);
  }
  const hit = byKey.get(cacheKey);
  if (hit !== undefined) return hit;
  const compiled = doCompile(schema, options, dialect);
  byKey.set(cacheKey, compiled);
  return compiled;
}

/** Convenience one-shot validation against an unregistered schema. */
export function validate(schema: Schema, value: unknown, path = '#'): Issue[] {
  return compile(schema).validate(value, path);
}
