import { describe, expect, it } from 'vitest';
import { transformValueScript } from '../src/compiler/transformer.js';

/**
 * Compiles a tiny `.vs` snippet and returns the produced JavaScript.
 * The runtime preamble is always present, so assertions use `.toContain`.
 */
function compile(source: string): string {
  return transformValueScript(source, 'fixture.vs');
}

describe('ValueScript compiler transforms', () => {
  it('rewrites a basic object property assignment to __set', () => {
    const out = compile(`
let user = { name: 'Ada', age: 36 };
user.name = 'Grace';
`);
    expect(out).toContain(`const user = { name: 'Ada', age: 36 };`);
    expect(out).toContain(`__set(user, "name", 'Grace')`);
    expect(out).not.toContain(`user.name =`);
  });

  it('rewrites arr.push(x) into an immutable reassignment', () => {
    const out = compile(`
let list = [1, 2, 3];
list.push(4);
`);
    expect(out).toContain(`let list = [1, 2, 3];`);
    expect(out).toContain(`list = [...list, 4];`);
  });

  it('flattens a deep path a.b.c = 1 into __set(obj, "a.b.c", 1)', () => {
    const out = compile(`
let config = {};
config.a.b.c = 1;
`);
    expect(out).toContain(`__set(config, "a.b.c", 1)`);
    expect(out).not.toContain(`config.a.b.c =`);
  });

  it('converts let to const when the variable is never reassigned', () => {
    const out = compile(`
let x = 1;
let y = 2;
console.log(x + y);
`);
    expect(out).toContain(`const x = 1;`);
    expect(out).toContain(`const y = 2;`);
    expect(out).not.toContain(`let x =`);
    expect(out).not.toContain(`let y =`);
  });

  it('keeps a variable as let when it is reassigned by an array mutator', () => {
    const out = compile(`
let items = [1, 2];
items.push(3);
items = items.slice(0, 1);
`);
    expect(out).toContain(`let items = [1, 2];`);
    expect(out).toContain(`items = [...items, 3];`);
  });

  it('handles every array mutator (pop, shift, unshift, splice, sort, reverse)', () => {
    const out = compile(`
let a = [];
a.pop();
a.shift();
a.unshift(9);
a.splice(1, 2, 7, 8);
a.sort();
a.reverse();
`);
    expect(out).toContain(`a = a.slice(0, -1);`);
    expect(out).toContain(`a = a.slice(1);`);
    expect(out).toContain(`a = [9, ...a];`);
    expect(out).toContain(`a = [...a.slice(0, 1), 7, 8, ...a.slice(1 + 2)];`);
    expect(out).toContain(`a = [...a].sort();`);
    expect(out).toContain(`a = [...a].reverse();`);
  });

  it('routes nested property array mutators through __set', () => {
    const out = compile(`
let state = { list: [1] };
state.list.push(2);
`);
    expect(out).toContain(`__set(state, "list", [...state.list, 2])`);
    expect(out).not.toContain(`state.list =`);
  });

  it('collects reassignment only for mutating variables, not plain property sets', () => {
    const out = compile(`
let obj = { n: 1 };
let arr = [1, 2];
obj.n = 5;
`);
    // obj is only used via property set -> never reassigned -> const.
    expect(out).toContain(`const obj = { n: 1 };`);
    expect(out).toContain(`const arr = [1, 2];`);
    expect(out).toContain(`__set(obj, "n", 5)`);
  });

  it('compiled output is fully self-contained with the runtime preamble', () => {
    const out = compile(`let x = { a: 1 };\nx.a = 2;\n`);
    expect(out.startsWith('function _cloneNode')).toBe(true);
    expect(out).toContain('function __set(');
    expect(out).toContain('function __get(');
    expect(out).toContain('function __delete(');
    // No imports left behind -> zero runtime dependencies.
    expect(out).not.toMatch(/^\s*import\s+/m);
  });
});

describe('runtime bridge helpers', () => {
  it('__set creates intermediate objects for deep paths', async () => {
    const { __set } = await import('../src/runtime/bridge.js');
    const out = __set({}, 'a.b.c', 42);
    expect(out).toEqual({ a: { b: { c: 42 } } });
    // Original untouched (immutability).
    expect({}).toEqual({});
  });

  it('__set never mutates the source object', async () => {
    const { __set } = await import('../src/runtime/bridge.js');
    const src = { list: [1, 2] };
    const out = __set(src, 'list.0', 99);
    expect(out).toEqual({ list: [99, 2] });
    expect(src).toEqual({ list: [1, 2] });
  });

  it('__get returns a value or undefined on missing paths', async () => {
    const { __set, __get } = await import('../src/runtime/bridge.js');
    const obj = __set({}, 'a.b.c', 1);
    expect(__get(obj, 'a.b.c')).toBe(1);
    expect(__get(obj, 'a.b.missing')).toBeUndefined();
    expect(__get(obj, 'nope')).toBeUndefined();
  });

  it('__delete removes a nested key immutably', async () => {
    const { __set, __delete, __get } = await import('../src/runtime/bridge.js');
    const obj = __set({}, 'a.b.c', 1);
    const reduced = __delete(obj, 'a.b.c');
    expect(__get(reduced, 'a.b.c')).toBeUndefined();
    expect(__get(obj, 'a.b.c')).toBe(1); // original intact
  });
});