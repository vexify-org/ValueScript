// @ts-nocheck
/**
 * @fileoverview ValueScript runtime bridge (Vexify).
 *
 * The helpers below implement immutable object/array updates for the compiled
 * `__set` / `__get` / `__delete` calls produced by the ValueScript compiler.
 *
 * The runtime is intentionally written as plain ES6 (no type annotations, no
 * library imports). This is not an accident: the compiler embeds these
 * functions verbatim (via `Function.prototype.toString`) as an inline preamble
 * at the top of every emitted `.js` file, so compiled output is fully
 * self-contained and has ZERO external dependencies.
 *
 * Copyright 2026 Vexify. Licensed under the Apache License 2.0.
 */

/**
 * Clones a single container node. Arrays are copied with `slice`, objects with
 * a shallow spread. Primitives (and null/undefined) are returned untouched.
 */
function _cloneNode(x) {
  if (Array.isArray(x)) return x.slice();
  if (x !== null && typeof x === 'object') return { ...x };
  return x;
}

/**
 * Creates an empty container for the next path segment. Numeric segments (bare
 * array indices like "0", "3", "12") imply an array; everything else is an object.
 */
function _makeNode(nextKey) {
  return /^(?:0|[1-9]\d*)$/.test(String(nextKey)) ? [] : {};
}

/**
 * Immutable set. Returns a brand new object/array whose node at `path` is set
 * to `value`. The original `obj` is never mutated. Intermediate nodes along the
 * path are created when missing (arrays are created for numeric segments).
 *
 *   __set(obj, 'a.b.c', 42)        -> obj with { a: { b: { c: 42 } } }
 *   __set(obj, 'list.2', x)        -> obj with list[2] === x
 */
function __set(obj, path, value) {
  const parts = String(path).split('.');
  const root = _cloneNode(obj);
  if (root === null || typeof root !== 'object') return value;
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = _cloneNode(cur[key]);
    const child =
      existing !== null && typeof existing === 'object'
        ? existing
        : _makeNode(parts[i + 1]);
    cur[key] = child;
    cur = child;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur) && /^(?:0|[1-9]\d*)$/.test(String(last))) {
    cur[Number(last)] = value;
  } else {
    cur[last] = value;
  }
  return root;
}

/**
 * Safe get. Walks `path` and returns the value, or `undefined` if any segment
 * along the way is missing.
 *
 *   __get(obj, 'a.b.c')  -> value or undefined
 */
function __get(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * Immutable delete. Returns a brand new object/array with the node at `path`
 * removed. The original `obj` is never mutated. Deleting a numeric array index
 * removes that element (re-indexing the array via splice).
 */
function __delete(obj, path) {
  const parts = String(path).split('.');
  const root = _cloneNode(obj);
  if (root === null || typeof root !== 'object') return root;
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = _cloneNode(cur[key]);
    cur[key] = next;
    cur = next;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur) && /^(?:0|[1-9]\d*)$/.test(String(last))) {
    cur.splice(Number(last), 1);
  } else {
    delete cur[last];
  }
  return root;
}

/**
 * Returns the plain-JS source text of all runtime helpers, joined into a single
 * block. The compiler prepends this block to every compiled output file so the
 * emitted JavaScript is standalone (no import statement, no runtime dependency).
 */
export function runtimePreamble() {
  return [_cloneNode, _makeNode, __set, __get, __delete]
    .map((fn) => fn.toString())
    .join('\n\n');
}

export { _cloneNode, _makeNode, __set, __get, __delete };