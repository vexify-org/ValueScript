import { defineConfig } from 'tsup';

export default defineConfig({
  // Key `cli/index` produces dist/cli/index.js, matching the "bin" entry in package.json.
  entry: {
    'cli/index': 'src/cli/index.ts',
  },
  format: ['cjs'],
  target: 'esnext',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  treeshake: true,
  minify: false,
});