#!/usr/bin/env node
/**
 * @fileoverview ValueScript CLI (Vexify).
 *
 *   vsc compile <file.vs> --out-dir dist
 *   vsc compile <file.vs> --out-dir dist --watch
 *   vsc <file.vs> -o dist
 *
 * Reads a `.vs` source file, compiles it to self-contained JavaScript, and
 * writes the result next to the same basename with a `.js` extension inside the
 * output directory (default: `./dist`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { transformValueScript } from '../compiler/transformer.js';

interface CliOptions {
  /** The input `.vs` file path (last positional argument). */
  input?: string;
  /** Output directory for the compiled `.js` file. */
  outDir: string;
  /** Watch the input file and recompile on change. */
  watch: boolean;
}

const VERSION = '0.1.0';

function printHelp(): void {
  const text = `
valuescript - ValueScript compiler (Powered by Vexify)

Usage:
  vsc <input.vs> [options]
  vsc compile <input.vs> [options]

Options:
  -o, --out-dir <dir>   Output directory (default: ./dist)
  -w, --watch           Recompile when the input file changes
  -v, --version         Print the version and exit
  -h, --help            Show this help
`;
  process.stdout.write(text);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: './dist', watch: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '-v' || arg === '--version') {
      process.stdout.write(`valuescript v${VERSION}\n`);
      process.exit(0);
    } else if (arg === '-o' || arg === '--out-dir') {
      const value = argv[++i];
      if (!value) {
        console.error(`vsc: option ${arg} requires a value`);
        process.exit(1);
      }
      options.outDir = value;
    } else if (arg === '-w' || arg === '--watch') {
      options.watch = true;
    } else if (arg === 'compile') {
      // Subcommand tag; ignore.
      positional.push('compile');
    } else if (arg.startsWith('-') && arg !== '-') {
      console.error(`vsc: unknown option: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  const candidates = positional.filter((p) => p !== 'compile');
  options.input = candidates[candidates.length - 1];
  return options;
}

/** Compiles a single `.vs` file and writes the `.js` result. */
function compileFile(input: string, outDir: string): string {
  const absInput = path.resolve(input);
  if (!fs.existsSync(absInput)) {
    console.error(`vsc: input file not found: ${absInput}`);
    process.exit(1);
  }
  if (fs.statSync(absInput).isDirectory()) {
    console.error(`vsc: input is a directory, expected a .vs file: ${absInput}`);
    process.exit(1);
  }

  const source = fs.readFileSync(absInput, 'utf8');
  let output: string;
  try {
    output = transformValueScript(source, absInput);
  } catch (err) {
    console.error(`vsc: failed to compile ${absInput}`);
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
  const { input, outDir, watch } = parseArgs(process.argv.slice(2));

  if (!input) {
    console.error('vsc: missing input file');
    printHelp();
    process.exit(1);
  }

  if (!input.endsWith('.vs')) {
    console.warn(`vsc: warning: "${input}" does not have a .vs extension; compiling anyway`);
  }

  const outFile = compileFile(input, outDir);
  console.log(`vsc: compiled ${input} -> ${outFile}`);

  if (!watch) return;

  let timer: NodeJS.Timeout | undefined;
  const absInput = path.resolve(input);
  console.log(`vsc: watching ${absInput} (Ctrl+C to stop)`);
  fs.watch(absInput, (eventType) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const out = compileFile(input, outDir);
        console.log(`vsc: [${eventType}] recompiled ${input} -> ${out}`);
      } catch (err) {
        console.error('vsc: watch recompile error:', err instanceof Error ? err.message : err);
      }
    }, 80);
  });
}

main();