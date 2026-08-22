/**
 * RFC 8785 (JSON Canonicalization Scheme, JCS) — deterministic JSON
 * serialization:
 *
 * - object keys sorted by UTF-16 code units (`Array.prototype.sort` default),
 * - numbers serialized with ECMAScript `Number::toString` (which also maps
 *   `-0` to `"0"`, and uses exponent form like `1e+21` where applicable),
 * - strings serialized with `JSON.stringify` (escapes quotes, backslashes and
 *   control characters per ECMAScript).
 *
 * Non-finite numbers and non-JSON types (undefined / bigint / function /
 * symbol) are rejected, per RFC 8785 §3.2.3.
 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS: number must be finite (RFC 8785 §3.2.3)');
    }
    // ECMAScript Number::toString — handles -0 -> "0" and 1e21 -> "1e+21"
    return String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += jcs(value[i]);
    }
    return out + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default sort = UTF-16 code unit order
    let out = '{';
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ',';
      const key = keys[i]!;
      out += JSON.stringify(key) + ':' + jcs(obj[key]);
    }
    return out + '}';
  }
  throw new TypeError('JCS: unsupported value type: ' + t);
}
