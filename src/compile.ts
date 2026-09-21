import { escapePointer, normalizeUri, resolveUri, splitFragment } from './uri.js';

export const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type Schema = boolean | SchemaObject;

export interface SchemaObject {
  $id?: string;
  $schema?: string;
  $anchor?: string;
  $dynamicAnchor?: string;
  $ref?: string;
  $dynamicRef?: string;
  $defs?: Record<string, Schema>;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  not?: Schema;
  const?: unknown;
  enum?: unknown[];
  [keyword: string]: unknown;
}

/** A schema document registered under a canonical URI. */
export interface ResourceDef {
  uri: string;
  schema: Schema;
  dialect: string;
  revision: string;
}

/** Static (compile-time) resolution of a plain $ref. */
export interface StaticRef {
  /** Absolute URI the reference resolved to, fragment included. */
  uri: string;
  /** Canonical URI of the target resource. */
  doc: string;
  /** Target node id; undefined when unresolvable. */
  node?: number;
  error?: string;
}

/** Static part of a $dynamicRef: the bookend plus whether runtime lookup applies. */
export interface StaticDynamicRef {
  /** Anchor name taken from the reference fragment. */
  name: string;
  uri: string;
  doc: string;
  /** True when the static target is a $dynamicAnchor, so the dynamic scope is consulted. */
  dynamic: boolean;
  /** Statically resolved target node, used as fallback ("bookend"). */
  bookend?: number;
  error?: string;
}

/** Immutable output of the compile phase: node table plus per-resource URI/anchor indexes. */
export interface CompiledSchema {
  rootUri: string;
  rootId: number;
  /** Node id -> schema (subschemas share identity with the input documents). */
  nodes: Schema[];
  /** Node id -> base URI in effect at that node (nearest $id). */
  baseUri: string[];
  /** Node id -> canonical URI of the resource that contains the node. */
  resourceOf: string[];
  /** Resource URI -> root node id. */
  resourceRoot: Map<string, number>;
  /** Resource URI -> normalized dialect. */
  resourceDialect: Map<string, string>;
  /** Resource URI -> ($anchor name -> node id). */
  anchors: Map<string, Map<string, number>>;
  /** Resource URI -> ($dynamicAnchor name -> node id); 2020-12 dialect only. */
  dynamicAnchors: Map<string, Map<string, number>>;
  /** "resourceUri#/json/pointer" -> node id. */
  pointers: Map<string, number>;
  /** Schema object identity -> node id. */
  nodeId: Map<Schema, number>;
  staticRefs: Map<number, StaticRef>;
  dynamicRefs: Map<number, StaticDynamicRef>;
}

export function normalizeDialect(dialect: string): string {
  return dialect.endsWith('#') ? dialect.slice(0, -1) : dialect;
}

/**
 * Compile a set of resource definitions into immutable lookup tables.
 * Every resource is fully walked before any reference is resolved, so the
 * result does not depend on the order in which resources were registered.
 */
export function compileSchema(rootUri: string, defs: ResourceDef[]): CompiledSchema {
  const nodes: Schema[] = [];
  const baseUri: string[] = [];
  const resourceOf: string[] = [];
  const resourceRoot = new Map<string, number>();
  const resourceDialect = new Map<string, string>();
  const anchors = new Map<string, Map<string, number>>();
  const dynamicAnchors = new Map<string, Map<string, number>>();
  const pointers = new Map<string, number>();
  const nodeId = new Map<Schema, number>();

  const ensureResource = (uri: string, dialect: string): void => {
    if (!anchors.has(uri)) anchors.set(uri, new Map());
    if (!dynamicAnchors.has(uri)) dynamicAnchors.set(uri, new Map());
    if (!resourceDialect.has(uri)) resourceDialect.set(uri, dialect);
  };

  const walk = (
    schema: Schema,
    docUri: string,
    base: string,
    resource: string,
    dialect: string,
    docPtr: string,
    resPtr: string,
  ): number => {
    const id = nodes.length;
    nodes.push(schema);
    baseUri.push(base);
    resourceOf.push(resource);
    nodeId.set(schema, id);

    let curBase = base;
    let curRes = resource;
    let curResPtr = resPtr;
    if (typeof schema === 'object' && schema !== null) {
      if (typeof schema.$id === 'string' && schema.$id !== '') {
        // An $id starts a new resource: base URI resets, pointer indexing restarts.
        curBase = normalizeUri(resolveUri(schema.$id, base));
        curRes = curBase;
        curResPtr = '';
        ensureResource(curRes, dialect);
        if (!resourceRoot.has(curRes)) resourceRoot.set(curRes, id);
        baseUri[id] = curBase;
        resourceOf[id] = curRes;
      }
      if (typeof schema.$anchor === 'string') anchors.get(curRes)!.set(schema.$anchor, id);
      if (dialect === DIALECT_2020_12 && typeof schema.$dynamicAnchor === 'string') {
        dynamicAnchors.get(curRes)!.set(schema.$dynamicAnchor, id);
      }
    }
    pointers.set(`${curRes}#${curResPtr}`, id);
    pointers.set(`${docUri}#${docPtr}`, id);

    if (typeof schema !== 'object' || schema === null) return id;
    const sub = (child: Schema, segment: string): number =>
      walk(child, docUri, curBase, curRes, dialect, `${docPtr}/${segment}`, `${curResPtr}/${segment}`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      sub(child, `properties/${escapePointer(key)}`);
    }
    for (const [key, child] of Object.entries(schema.$defs ?? {})) {
      sub(child, `$defs/${escapePointer(key)}`);
    }
    if (schema.items !== undefined) sub(schema.items, 'items');
    if (schema.additionalProperties !== undefined) sub(schema.additionalProperties, 'additionalProperties');
    schema.allOf?.forEach((child, i) => sub(child, `allOf/${i}`));
    schema.anyOf?.forEach((child, i) => sub(child, `anyOf/${i}`));
    if (schema.not !== undefined) sub(schema.not, 'not');
    return id;
  };

  // Deterministic walk order keeps node numbering stable across registrations.
  const sorted = [...defs].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  for (const def of sorted) {
    const uri = normalizeUri(def.uri);
    const dialect = normalizeDialect(def.dialect);
    ensureResource(uri, dialect);
    const id = walk(def.schema, uri, uri, uri, dialect, '', '');
    if (!resourceRoot.has(uri)) resourceRoot.set(uri, id);
  }

  const lookup = (fromId: number, ref: string): StaticRef => {
    const uri = resolveUri(ref, baseUri[fromId]);
    let [doc, frag] = splitFragment(uri);
    doc = doc ? normalizeUri(doc) : resourceOf[fromId];
    if (frag === undefined || frag === '') {
      const node = resourceRoot.get(doc);
      return node === undefined
        ? { uri, doc, error: `unknown resource '${doc}'` }
        : { uri, doc, node };
    }
    if (frag.startsWith('/')) {
      const node = pointers.get(`${doc}#${frag}`);
      return node === undefined
        ? { uri, doc, error: `no such pointer '#${frag}' in resource '${doc}'` }
        : { uri, doc, node };
    }
    const node = anchors.get(doc)?.get(frag) ?? dynamicAnchors.get(doc)?.get(frag);
    return node === undefined
      ? { uri, doc, error: `no such anchor '#${frag}' in resource '${doc}'` }
      : { uri, doc, node };
  };

  // Second pass: resolve every reference now that all anchors are known.
  const staticRefs = new Map<number, StaticRef>();
  const dynamicRefs = new Map<number, StaticDynamicRef>();
  for (let id = 0; id < nodes.length; id++) {
    const schema = nodes[id];
    if (typeof schema !== 'object' || schema === null) continue;
    if (typeof schema.$ref === 'string') staticRefs.set(id, lookup(id, schema.$ref));
    if (
      typeof schema.$dynamicRef === 'string' &&
      resourceDialect.get(resourceOf[id]) === DIALECT_2020_12
    ) {
      const ref = schema.$dynamicRef;
      const staticTarget = lookup(id, ref);
      const [, frag] = splitFragment(resolveUri(ref, baseUri[id]));
      const name = frag ?? '';
      if (staticTarget.error !== undefined || staticTarget.node === undefined) {
        dynamicRefs.set(id, {
          name,
          uri: staticTarget.uri,
          doc: staticTarget.doc,
          dynamic: false,
          error: staticTarget.error ?? 'unresolvable',
        });
        continue;
      }
      const target = nodes[staticTarget.node];
      const isDynamic =
        frag !== undefined &&
        frag !== '' &&
        !frag.startsWith('/') &&
        typeof target === 'object' &&
        target !== null &&
        target.$dynamicAnchor === name;
      // A $dynamicRef whose static target is not a $dynamicAnchor behaves like $ref.
      dynamicRefs.set(id, {
        name,
        uri: staticTarget.uri,
        doc: staticTarget.doc,
        dynamic: isDynamic,
        bookend: staticTarget.node,
      });
    }
  }

  const rootId = resourceRoot.get(normalizeUri(rootUri));
  if (rootId === undefined) throw new Error(`unknown root resource: ${rootUri}`);

  return {
    rootUri: normalizeUri(rootUri),
    rootId,
    nodes,
    baseUri,
    resourceOf,
    resourceRoot,
    resourceDialect,
    anchors,
    dynamicAnchors,
    pointers,
    nodeId,
    staticRefs,
    dynamicRefs,
  };
}
