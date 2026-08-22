declare module 'canonicalize' {
  /** RFC 8785 canonicalization; returns undefined for non-JSON-safe input. */
  function canonicalize(value: unknown): string | undefined;
  export default canonicalize;
}
