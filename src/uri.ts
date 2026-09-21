/** URI helpers for schema resource identification and $ref resolution. */

/** Canonical form for a resource URI: URL-normalized, empty fragment stripped. */
export function normalizeUri(uri: string): string {
  let out = uri;
  try {
    out = new URL(uri).href;
  } catch {
    // Keep non-URL identifiers (e.g. bare names) untouched.
  }
  return out.endsWith('#') ? out.slice(0, -1) : out;
}

/** Resolve a URI-reference against a base URI, RFC 3986 style via WHATWG URL. */
export function resolveUri(ref: string, base: string): string {
  try {
    const out = new URL(ref, base).href;
    return out.endsWith('#') && !ref.endsWith('#') ? out.slice(0, -1) : out;
  } catch {
    return ref;
  }
}

/** Split an absolute URI into [document part, fragment]. Fragment may be undefined. */
export function splitFragment(uri: string): [string, string | undefined] {
  const i = uri.indexOf('#');
  if (i < 0) return [uri, undefined];
  let frag = uri.slice(i + 1);
  try {
    frag = decodeURIComponent(frag);
  } catch {
    // Leave malformed percent-encoding as-is.
  }
  return [uri.slice(0, i), frag];
}

/** Escape one JSON Pointer segment (RFC 6901). */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
