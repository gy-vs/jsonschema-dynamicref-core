# JSON Schema core

TypeScript library for JSON Schema 2020-12 validation, including `$dynamicRef` / `$dynamicAnchor`.

Run `npm install`, then `npm test` and `npm run build`.

## Usage

```ts
import { Registry } from 'jsonschema-dynamicref-core';

const registry = new Registry();
registry
  .addResource('doc://example/tree.json', treeSchema, { revision: 1 })
  .addResource('doc://example/strict.json', strictSchema, { revision: 1 });

const validator = registry.compile('doc://example/strict.json'); // cached
const issues = validator.validate(instance);
// issues: [{ path, message, resolutionChain }]
```

The legacy `validate(schema, value)` one-shot API is still exported.

## Design

**Compile phase** (`src/compile.ts`) — `compileSchema` walks every registered
resource and builds immutable tables: node ids, per-node base URIs (from `$id`
scopes), per-resource `$anchor` / `$dynamicAnchor` tables, and JSON-Pointer
indexes. All resources are walked before any `$ref` / `$dynamicRef` is
resolved, so results never depend on resource registration order. `$dynamicRef`
gets a static "bookend" resolution plus a flag for whether the static target is
a `$dynamicAnchor` (if not, it behaves exactly like `$ref`). Dynamic keywords
are only honored for the 2020-12 dialect.

**Runtime** (`src/evaluate.ts`) — each validation run keeps a dynamic scope:
the stack of resource URIs entered so far, outermost first. A `$dynamicRef`
binds to the first resource in that ordering that defines a matching
`$dynamicAnchor` (the resource evaluation started from shadows same-named
anchors in referenced resources); the static bookend is the fallback. Recursive
schemas are memoized per (schema node, instance location) pair; revisiting an
in-progress pair is reported as a cyclic-evaluation error, never treated as
success. Every issue carries the instance path and the full resolution chain
(`$ref` / `$dynamicRef` hops) that led to the failing node.

**Compile cache** (`src/index.ts`) — `Registry.compile` caches validators
process-wide. The cache key covers the root URI and each resource's
`(uri, dialect, revision, content)`, sorted by URI, so it is order-independent
and distinguishes both dialect and resource revision. Bump `revision` after
changing a document in place.
