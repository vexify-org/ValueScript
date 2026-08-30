# @valuescript/vsc — ValueScript Compiler

**Powered by Vexify** · License: **Apache-2.0**

`@valuescript/vsc` is a production-grade compiler that turns `.vs` (**ValueScript**)
source files into **plain, fully self-contained JavaScript**. ValueScript is a
strict *immutable* superset of JavaScript: the compiler statically rewrites every
mutable operation into pure, immutable expressions. The emitted `.js` file has
**zero external runtime dependencies** — the runtime helpers are inlined as a
preamble directly into the output.

The compiler core is **self-hosted and zero-dependency**: it ships its own
tokenizer, parser, and emitter instead of depending on the TypeScript compiler
API. The single-file CLI bundles only a tiny argument parser, so the published
package has no runtime install footprint. It can be installed globally as a CLI,
or used programmatically.

---

## Installation

```bash
npm install -g @valuescript/vsc
```

## Usage

```bash
# Compile a single file into ./dist (default output directory)
vsc compile src/index.vs

# Compile into a custom output directory
vsc compile src/index.vs --out-dir dist

# Watch the file and recompile on every save
vsc compile src/index.vs --out-dir dist --watch

# Shorthand
vsc src/index.vs -o dist -w
```

The output file keeps the input basename, but with a `.js` extension
(`src/index.vs` → `dist/index.js`).

### Programmatic API

```typescript
import { transformValueScript } from '@valuescript/vsc/src/compiler/transformer';

const js = transformValueScript('let x = { a: 1 }; x.a = 2;', 'sample.vs');
console.log(js); // self-contained JavaScript
```

---

## Transformation rules

### 1. Object property assignment → `__set`

Any `obj.prop = value` (or `obj['prop'] = value`) becomes an immutable
`__set(obj, 'prop', value)` call that returns a **new** object.

Deep paths are flattened into a single path string instead of nested calls:

```javascript
// ValueScript
config.host.port = 8080;

// Compiled
config = __set(config, 'host.port', 8080);
```

### 2. Array mutators → immutable reassignment

In-place array methods are rewritten to non-mutating expressions, and the
result is rebound to the original variable (which is kept as `let`):

| Mutation        | Compiled output |
| --------------- | ----------------------------- |
| `arr.push(x)`   | `arr = [...arr, x]`           |
| `arr.pop()`     | `arr = arr.slice(0, -1)`      |
| `arr.shift()`   | `arr = arr.slice(1)`          |
| `arr.unshift(x)`| `arr = [x, ...arr]`           |
| `arr.splice(s,d,...i)` | `arr = [...arr.slice(0,s), ...i, ...arr.slice(s+d)]` |
| `arr.sort(comp)`| `arr = [...arr].sort(comp)`   |
| `arr.reverse()` | `arr = [...arr].reverse()`    |

When the receiver is a nested property (`state.list.push(2)`), the rewrite is
routed through `__set` so the surrounding object is never mutated:

```javascript
// ValueScript
state.list.push(2);

// Compiled
state = __set(state, 'list', [...state.list, 2]);
```

### 3. `let` → `const` by default

Variables are immutable by default, so plain `let` declarations are compiled to
`const` — **unless** the variable is reassigned somewhere (for example, by an
array mutator that rebinds it). The compiler performs a static reassignment
analysis and downgrades only those variables back to `let`.

```javascript
let x = 1;            // never reassigned  -> const x = 1;
let items = [1, 2];
items.push(3);        // items is rebound  -> kept as let
```

### 4. Side-effect analysis

Reassigning captured outer variables in a closure is transformed (and could emit
a warning in a future release); the compiler always produces valid JavaScript.

---

## Runtime bridge (`src/runtime/bridge.ts`)

The pure-ES6 helpers `__set`, `__get`, and `__delete` implement immutable deep
set/get/delete with automatic creation of intermediate arrays (numeric segments)
or objects. They are inlined into every compiled file's preamble, so **no import,
no bundler, and no npm runtime dependency** is needed to run the output.

---

## Development

```bash
npm install
npm run typecheck   # strict TypeScript check
npm test            # vitest suite
npm run build       # build the CLI into dist/
```

## License

[Apache-2.0](LICENSE) · © 2026 Vexify. _Powered by Vexify._