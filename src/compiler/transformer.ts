/**
 * @fileoverview ValueScript public compiler entry (Vexify).
 *
 * This is a thin re-export of the zero-dependency self-hosting core in
 * `selfhost.ts`. No TypeScript compiler-API import is used, so the compiled
 * output has no external runtime dependencies.
 */

export { transformValueScript } from './selfhost.js';