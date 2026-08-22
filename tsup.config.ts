import { defineConfig } from 'tsup';

export default defineConfig({
  // Key `cli/index` produces dist/cli/index.js, matching the "bin" entry in package.json.
  entry: {
    'cli/index': 'src/cli/index.ts',
  },
  format: ['cjs'],
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  treeshake: true,
  minify: false,
  // Bundle the (tiny, zero-dep) yaggs CLI parser into the single output file so
  // the official `dist/cli/index.js` is fully self-contained. Node builtins and
  // the compiler core stay default-inlined already. `typescript` is intentionally
  // NOT a runtime dependency and is never imported by the core.
  noExternal: ['@vexify-org/yaggs'],
});