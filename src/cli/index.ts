#!/usr/bin/env node
/**
 * @fileoverview ValueScript CLI (Vexify).
 *
 *   valuescript compile <file.vs> --out-dir dist
 *   valuescript compile <file.vs> --out-dir dist --watch
 *   valuescript <file.vs> -o dist
 *
 * Uses `@vexify-org/yaggs` (a zero-dependency CLI argument parser) for argv
 * handling. The compiler core itself has no external dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaggs from '@vexify-org/yaggs';
import { transformValueScript } from '../compiler/transformer.js';

const VERSION = '0.1.0';

// `yaggs` is a factory that returns a Yaggs instance (it is not itself a
// parser). With `pkg` set, `--version`/`--help` are handled by yaggs, which
// prints and exits cleanly via the default exitProcess behavior.
const cli = yaggs({ pkg: { version: VERSION } })
  .usage('$0 <input.vs> [options]')
  .option('out-dir', {
    alias: ['o'],
    type: 'string',
    description: 'Output directory (default: ./dist)',
    default: './dist',
  })
  .option('watch', {
    alias: ['w'],
    type: 'boolean',
    description: 'Recompile when the input file changes',
    default: false,
  });
// `--help` / `--version` are provided by yaggs' built-in options.

const argv = cli.parse(process.argv.slice(2)) as {
  input?: string;
  _: Array<string | number>;
  'out-dir'?: string;
  outDir?: string;
  watch?: boolean;
  version?: boolean;
};

const outDir = argv.outDir ?? argv['out-dir'] ?? './dist';
const watch = !!argv.watch;

function resolveInput(argvParsed: {
  input?: string;
  _: Array<string | number>;
}): string | undefined {
  if (argvParsed.input) return argvParsed.input;
  const positional = (argvParsed._ as Array<string | number>).filter(
    (x): x is string => typeof x === 'string',
  );
  const last = positional.filter((p) => p !== 'compile');
  return last[last.length - 1];
}

/** Compiles a single `.vs` file and writes the `.js` result. */
function compileFile(input: string, outDir: string): string {
  const absInput = path.resolve(input);
  if (!fs.existsSync(absInput)) {
    console.error(`valuescript: input file not found: ${absInput}`);
    process.exit(1);
  }
  if (fs.statSync(absInput).isDirectory()) {
    console.error(`valuescript: input is a directory, expected a .vs file: ${absInput}`);
    process.exit(1);
  }

  const source = fs.readFileSync(absInput, 'utf8');
  let output: string;
  try {
    output = transformValueScript(source, absInput);
  } catch (err) {
    console.error(`valuescript: failed to compile ${absInput}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }

  const baseName = path.basename(absInput, path.extname(absInput)) + '.js';
  const outFile = path.join(path.resolve(outDir), baseName);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output, 'utf8');
  return outFile;
}

function main(): void {
  // Note: `--version` / `--help` are handled and exited by `cli.parse()` above.
  const input = resolveInput(argv);
  if (!input) {
    console.error('valuescript: missing input file');
    cli.showHelp();
    process.exit(1);
  }

  if (!input.endsWith('.vs')) {
    console.warn(`valuescript: warning: "${input}" does not have a .vs extension; compiling anyway`);
  }

  const outFile = compileFile(input, outDir);
  console.log(`valuescript: compiled ${input} -> ${outFile}`);

  if (!watch) return;

  let timer: NodeJS.Timeout | undefined;
  const absInput = path.resolve(input);
  console.log(`valuescript: watching ${absInput} (Ctrl+C to stop)`);
  fs.watch(absInput, (eventType) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const out = compileFile(input, outDir);
        console.log(`valuescript: [${eventType}] recompiled ${input} -> ${out}`);
      } catch (err) {
        console.error('valuescript: watch recompile error:', err instanceof Error ? err.message : err);
      }
    }, 80);
  });
}

main();