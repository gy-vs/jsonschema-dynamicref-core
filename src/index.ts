import { compileSchema, DIALECT_2020_12, normalizeDialect } from './compile.js';
import type { CompiledSchema, ResourceDef, Schema } from './compile.js';
import { evaluateRoot } from './evaluate.js';
import type { Issue } from './evaluate.js';
import { normalizeUri } from './uri.js';

export { compileSchema, DIALECT_2020_12 } from './compile.js';
export type { CompiledSchema, ResourceDef, Schema, SchemaObject, StaticDynamicRef, StaticRef } from './compile.js';
export type { Issue } from './evaluate.js';

export interface Validator {
  readonly rootUri: string;
  readonly compiled: CompiledSchema;
  validate(value: unknown): Issue[];
}

export interface AddResourceOptions {
  /** Overrides the resource's own $schema and the registry default. */
  dialect?: string;
  /** Bump to invalidate cached compilations after the document changes. */
  revision?: string | number;
}

/**
 * Process-wide validator cache. The key covers the root URI plus, for every
 * resource, its (uri, dialect, revision, content) — sorted by uri so the key
 * is independent of registration order.
 */
const compileCache = new Map<string, Validator>();

export function clearCompileCache(): void {
  compileCache.clear();
}

export class Registry {
  private readonly resources = new Map<string, ResourceDef>();

  constructor(private readonly defaultDialect: string = DIALECT_2020_12) {}

  addResource(uri: string, schema: Schema, opts: AddResourceOptions = {}): this {
    const normalized = normalizeUri(uri);
    const own =
      typeof schema === 'object' && schema !== null && typeof schema.$schema === 'string'
        ? schema.$schema
        : undefined;
    const dialect = normalizeDialect(opts.dialect ?? own ?? this.defaultDialect);
    this.resources.set(normalized, {
      uri: normalized,
      schema,
      dialect,
      revision: String(opts.revision ?? '0'),
    });
    return this;
  }

  /** Compile (or fetch from cache) a validator for the given resource URI. */
  compile(rootUri: string): Validator {
    const root = normalizeUri(rootUri);
    const key = cacheKey(root, this.resources);
    const cached = compileCache.get(key);
    if (cached !== undefined) return cached;
    const compiled = compileSchema(root, [...this.resources.values()]);
    const validator: Validator = {
      rootUri: root,
      compiled,
      validate: (value: unknown) => evaluateRoot(compiled, value),
    };
    compileCache.set(key, validator);
    return validator;
  }
}

function cacheKey(rootUri: string, resources: Map<string, ResourceDef>): string {
  const parts = [...resources.values()]
    .map((r) => [r.uri, r.dialect, r.revision, stableStringify(r.schema)].join('␟'))
    .sort();
  return [rootUri, ...parts].join('␞');
}

/** JSON.stringify with sorted object keys, so semantically equal schemas hash equally. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Backwards-compatible one-shot validation: wraps the schema in an anonymous
 * resource and runs it through the compile/evaluate pipeline.
 */
export function validate(schema: Schema, value: unknown, path = '#'): Issue[] {
  const uri = 'https://jsonschema.local/inline';
  const registry = new Registry();
  registry.addResource(uri, schema);
  const issues = registry.compile(uri).validate(value);
  if (path === '#') return issues;
  return issues.map((i) => ({ ...i, path: path + i.path.slice(1) }));
}
