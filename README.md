# JSON Schema core

TypeScript library for JSON Schema 2020-12 validation, including `$ref`,
`$dynamicRef` / `$dynamicAnchor`, cross-document references and recursive
schemas.

Run `npm install`, then `npm test` and `npm run build`.

## API

```ts
import { compile, validate } from 'jsonschema-dynamicref-core';

const validator = compile(rootSchema, {
  dialect: 'https://json-schema.org/draft/2020-12/schema', // default
  revision: 1,                 // root schema revision (cache key)
  resources: [                 // extra schema resources, any order
    { uri: 'https://ex.com/other.json', schema: other, revision: 3 },
  ],
});

const issues = validator.validate(instance);
// Issue = { path, message, resolutionChain? } — resolutionChain lists the
// URIs actually entered through $ref / $dynamicRef, outermost first.
```

Semantics notes:

- Compilation is two-phase: all resources, base URIs, anchors and pointer
  tables are built before any reference is resolved, so results never depend
  on resource load order. Unresolvable references throw at compile time.
- `$dynamicRef` first resolves statically; if the static target is a
  `$dynamicAnchor` (the bookending requirement), the anchor is re-resolved
  against the runtime dynamic scope, outermost resource first.
- Results are memoized per (schema node, instance location, dynamic scope).
  A (node, instance) pair already being evaluated signals infinite recursion
  and is reported as a `circular reference` issue — never as success.
- Compiled schemas are cached by root schema identity plus a key of dialect
  and all resource revisions; bump a revision when schema content changes.

`validate(schema, value)` remains as a one-shot convenience wrapper.
