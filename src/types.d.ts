/**
 * Minimal ambient declaration for `@vexify-org/yaggs`, which publishes no
 * bundled TypeScript types. Runtime behavior is what matters here; calls are
 * untyped (`any`).
 */
declare module '@vexify-org/yaggs' {
  const yaggs: any;
  export = yaggs;
}