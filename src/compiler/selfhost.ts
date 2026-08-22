/**
 * @fileoverview ValueScript self-hosting compiler core (Vexify).
 *
 * ZERO-dependency replacement for the TypeScript-compiler-API based core.
 * This module contains its own
 *   - tokenizer (scanner)
 *   - recursive-descent parser  -> lightweight AST
 *   - emitter                    -> applies the three transformation rules and
 *                                    prints plain, self-contained JavaScript
 *
 * It intentionally does NOT import `typescript` (or any other library) at
 * runtime, so the compiled official CLI has no external dependencies.
 *
 * Transformation rules:
 *   1. Property assignment `obj.a.b.c = v` -> `__set(obj, 'a.b.c', v)`
 *   2. Array mutators -> immutable reassignments (push/pop/shift/unshift/
 *      splice/sort/reverse), rebinding the receiver (kept as `let`), or routing
 *      nested receivers through `__set`.
 *   3. `let` -> `const` unless the variable is reassigned somewhere.
 */

import { runtimePreamble } from '../runtime/bridge.js';

const ARRAY_MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
]);

const ASSIGN_OPS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
]);

/** Public entry: compile `.vs` source into self-contained JavaScript. */
export function transformValueScript(source: string, fileName: string): string {
  void fileName;
  const body = compileBody(source);
  return runtimePreamble() + '\n\n' + body + '\n';
}

/* -----------------------------------------------------------------------------
 * Tokenizer
 * ---------------------------------------------------------------------------*/

type TokType = 'ident' | 'num' | 'str' | 'tmpl' | 'op' | 'eof';

interface Token {
  type: TokType;
  value: string;
  nl: boolean;
}

const MULTI_OPS = [
  '++',
  '--',
  '>>>',
  '===',
  '!==',
  '**=',
  '...',
  '>>=',
  '<<=',
  '>=',
  '<=',
  '==',
  '!=',
  '&&',
  '||',
  '??',
  '**',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<',
  '>>',
  '=>',
].sort((a, b) => b.length - a.length);

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);

function tokenize(source: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let nl = false;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    if (c === '\n' || c === '\r' || c === ' ' || c === '\t') {
      if (c === '\n') nl = true;
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = q;
      while (j < n) {
        const ch = source[j];
        if (ch === '\\') {
          s += ch + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (ch === q) break;
        s += ch;
        j++;
      }
      s += q;
      toks.push({ type: 'str', value: s, nl });
      nl = false;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let s = '`';
      while (j < n) {
        const ch = source[j];
        if (ch === '\\') {
          s += ch + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (ch === '`') break;
        s += ch;
        j++;
      }
      s += '`';
      toks.push({ type: 'tmpl', value: s, nl });
      nl = false;
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        let j = i + 2;
        let s = source[i] + source[i + 1];
        while (j < n && /[0-9a-fA-F]/.test(source[j])) {
          s += source[j];
          j++;
        }
        toks.push({ type: 'num', value: s, nl });
        nl = false;
        i = j;
        continue;
      }
      let j = i;
      let s = '';
      while (j < n && /[0-9._eE]/.test(source[j])) {
        s += source[j];
        j++;
      }
      toks.push({ type: 'num', value: s, nl });
      nl = false;
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      let s = '';
      while (j < n && isIdentPart(source[j])) {
        s += source[j];
        j++;
      }
      toks.push({ type: 'ident', value: s, nl });
      nl = false;
      i = j;
      continue;
    }
    let matched = false;
    for (const op of MULTI_OPS) {
      if (source.startsWith(op, i)) {
        toks.push({ type: 'op', value: op, nl });
        nl = false;
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if ("{}()[];,:?.=<>!+-*/%&|^~".includes(c)) {
      toks.push({ type: 'op', value: c, nl });
      nl = false;
      i++;
      continue;
    }
    i++;
  }
  toks.push({ type: 'eof', value: 'eof', nl });
  return toks;
}

/* -----------------------------------------------------------------------------
 * AST
 * ---------------------------------------------------------------------------*/

type Expr =
  | { k: 'id'; n: string }
  | { k: 'num'; t: string }
  | { k: 'str'; t: string }
  | { k: 'tmpl'; t: string }
  | { k: 'lit'; v: string }
  | { k: 'array'; elems: Array<Expr | SpreadElem> }
  | { k: 'obj'; props: Array<ObjProp> }
  | { k: 'paren'; e: Expr }
  | { k: 'un'; op: string; a: Expr }
  | { k: 'post'; op: string; a: Expr }
  | { k: 'bin'; l: Expr; op: string; r: Expr }
  | { k: 'call'; callee: Expr; args: Expr[] }
  | { k: 'mem'; obj: Expr; prop: string; computed?: boolean; idx?: Expr };

type SpreadElem = { k: 'spread'; a: Expr };

interface ObjProp {
  k: 'prop' | 'spread';
  key: string;
  val?: Expr;
}

type Stmt =
  | { k: 'var'; decls: Array<{ name: string; init?: Expr }> }
  | { k: 'expr'; e: Expr }
  | { k: 'ret'; v?: Expr }
  | { k: 'func'; name: string; params: string[]; body: Stmt[] }
  | { k: 'block'; body: Stmt[] }
  | { k: 'if'; test: Expr; then: Stmt; els?: Stmt }
  | { k: 'for'; init?: Stmt; test?: Expr; update?: Expr; body: Stmt }
  | { k: 'while'; test: Expr; body: Stmt }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'empty' };

/* -----------------------------------------------------------------------------
 * Parser
 * ---------------------------------------------------------------------------*/

const BIN_PREC: Record<string, number> = {
  '||': 1,
  '??': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '===': 6,
  '!==': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  'in': 7,
  'instanceof': 7,
  '<<': 8,
  '>>': 8,
  '>>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
  '**': 11,
};

const LIT_KEYS = new Set(['true', 'false', 'null', 'undefined', 'this']);
const PREFIX_OPS = new Set(['!', '~', '-', '+', 'typeof', 'void', 'delete']);
const VAR_KEYS = new Set(['let', 'const', 'var']);

function compileBody(source: string): string {
  const parser = new Parser(tokenize(source));
  const program = parser.parseProgram();
  return new Emitter().emit(program);
}

class Parser {
  private toks: Token[];
  private pos = 0;

  constructor(toks: Token[]) {
    this.toks = toks;
  }

  peek(): Token {
    return this.toks[this.pos];
  }
  next(): Token {
    return this.toks[this.pos++];
  }
  at(value: string): boolean {
    return this.peek().value === value;
  }
  atIdent(value: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value === value;
  }
  expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) {
      throw new Error(`parse error: expected "${value}" but found "${t.value}"`);
    }
    return t;
  }
  semi(): void {
    if (this.at(';')) this.next();
  }

  parseProgram(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.at('eof')) {
      if (this.at(';')) {
        this.next();
        continue;
      }
      out.push(this.parseStatement());
    }
    return out;
  }

  parseBlock(): Stmt {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.at('}') && !this.at('eof')) {
      if (this.at(';')) {
        this.next();
        continue;
      }
      body.push(this.parseStatement());
    }
    this.expect('}');
    return { k: 'block', body };
  }

  parseStatement(): Stmt {
    const t = this.peek();
    if (t.type === 'ident') {
      switch (t.value) {
        case 'let':
        case 'const':
        case 'var':
          return this.parseVar();
        case 'function':
          return this.parseFunc();
        case 'return':
          this.next();
          if (this.at(';')) {
            this.next();
            return { k: 'ret' };
          }
          {
            const v = this.parseExpression();
            this.semi();
            return { k: 'ret', v };
          }
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
          this.next();
          this.expect('(');
          {
            const test = this.parseExpression();
            this.expect(')');
            const body = this.parseStatement();
            return { k: 'while', test, body };
          }
        case 'break':
          this.next();
          this.semi();
          return { k: 'break' };
        case 'continue':
          this.next();
          this.semi();
          return { k: 'continue' };
      }
    }
    if (this.at('{')) return this.parseBlock();
    if (this.at(';')) {
      this.next();
      return { k: 'empty' };
    }
    const e = this.parseExpression();
    this.semi();
    return { k: 'expr', e };
  }

  parseVar(): Stmt {
    // Consume the kind keyword but do not need to remember it: the emitter
    // decides const/let entirely from reassignment analysis.
    this.next();
    const decls: Array<{ name: string; init?: Expr }> = [];
    decls.push(this.parseDeclarator());
    while (this.at(',')) {
      this.next();
      decls.push(this.parseDeclarator());
    }
    this.semi();
    return { k: 'var', decls };
  }

  parseDeclarator(): { name: string; init?: Expr } {
    const name = this.parseBindingName();
    let init: Expr | undefined;
    if (this.at('=')) {
      this.next();
      init = this.parseExpression();
    }
    return { name, init };
  }

  parseBindingName(): string {
    const t = this.next();
    if (t.type !== 'ident') throw new Error(`parse error: expected variable name, got ${t.value}`);
    return t.value;
  }

  parseFunc(): Stmt {
    this.next(); // function
    const name = this.parseBindingName();
    this.expect('(');
    const params: string[] = [];
    while (!this.at(')') && !this.at('eof')) {
      params.push(this.parseBindingName());
      if (!this.at(',')) break;
      this.next();
    }
    this.expect(')');
    const blockNode = this.parseBlock() as { k: 'block'; body: Stmt[] };
    return { k: 'func', name, params, body: blockNode.body };
  }

  parseIf(): Stmt {
    this.next(); // if
    this.expect('(');
    const test = this.parseExpression();
    this.expect(')');
    const then = this.parseStatement();
    let els: Stmt | undefined;
    if (this.atIdent('else')) {
      this.next();
      els = this.parseStatement();
    }
    return { k: 'if', test, then, els };
  }

  parseFor(): Stmt {
    this.next(); // for
    this.expect('(');
    let init: Stmt | undefined;
    if (this.at(';')) {
      this.next();
    } else if (VAR_KEYS.has(this.peek().value)) {
      const decls: Array<{ name: string; init?: Expr }> = [];
      this.next(); // kind
      decls.push(this.parseDeclarator());
      while (this.at(',')) {
        this.next();
        decls.push(this.parseDeclarator());
      }
      this.semi(); // consumes the first ';' after init
      init = { k: 'var', decls };
    } else {
      init = { k: 'expr', e: this.parseExpression() };
      this.expect(';');
    }
    let test: Expr | undefined;
    if (this.at(';')) {
      this.next();
    } else {
      test = this.parseExpression();
      this.expect(';');
    }
    let update: Expr | undefined;
    if (this.at(')')) {
      /* no update */
    } else {
      update = this.parseExpression();
    }
    this.expect(')');
    const body = this.parseStatement();
    return { k: 'for', init, test, update, body };
  }

  parseExpression(): Expr {
    return this.parseAssignment();
  }

  parseAssignment(): Expr {
    const l = this.parseBinary(1);
    if (ASSIGN_OPS.has(this.peek().value)) {
      const op = this.next().value;
      const r = this.parseAssignment();
      return { k: 'bin', l, op, r };
    }
    return l;
  }

  parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'ident' && t.type !== 'op') break;
      const p = BIN_PREC[t.value];
      if (p === undefined || p < minPrec) break;
      const op = this.next().value;
      const isRightAssoc = op === '**';
      const right = this.parseBinary(isRightAssoc ? p : p + 1);
      left = { k: 'bin', l: left, op, r: right };
    }
    return left;
  }

  parseUnary(): Expr {
    const t = this.peek();
    const isPrefixIncr = (t.type === 'op' || t.type === 'ident') && (t.value === '++' || t.value === '--');
    if (PREFIX_OPS.has(t.value) || isPrefixIncr) {
      const op = this.next().value;
      const a = this.parseUnary();
      return { k: 'un', op, a };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(e: Expr): Expr {
    for (;;) {
      if (this.at('.') ) {
        this.next();
        const prop = this.parseBindingName();
        e = { k: 'mem', obj: e, prop };
      } else if (this.at('?.')) {
        this.next();
        // Optional chaining: treat as plain member access.
        if (this.at('[')) {
          this.next();
          const idx = this.parseExpression();
          this.expect(']');
          e = { k: 'mem', obj: e, prop: '', computed: true, idx };
        } else {
          const prop = this.parseBindingName();
          e = { k: 'mem', obj: e, prop };
        }
      } else if (this.at('[')) {
        this.next();
        const idx = this.parseExpression();
        this.expect(']');
        e = { k: 'mem', obj: e, prop: '', computed: true, idx };
      } else if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.at(')') && !this.at('eof')) {
          args.push(this.parseExpression());
          if (!this.at(',')) break;
          this.next();
        }
        this.expect(')');
        e = { k: 'call', callee: e, args };
      } else if (t_incr(this.peek())) {
        const op = this.next().value;
        e = { k: 'post', op, a: e };
      } else {
        break;
      }
    }
    return e;
  }

  parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === 'ident') {
      if (LIT_KEYS.has(t.value)) {
        this.next();
        return { k: 'lit', v: t.value };
      }
      this.next();
      return { k: 'id', n: t.value };
    }
    if (t.type === 'num') {
      this.next();
      return { k: 'num', t: t.value };
    }
    if (t.type === 'str') {
      this.next();
      return { k: 'str', t: t.value };
    }
    if (t.type === 'tmpl') {
      this.next();
      return { k: 'tmpl', t: t.value };
    }
    if (this.at('(')) {
      this.next();
      const e = this.parseExpression();
      this.expect(')');
      return { k: 'paren', e };
    }
    if (this.at('[')) {
      return this.parseArrayLiteral();
    }
    if (this.at('{')) {
      return this.parseObjectLiteral();
    }
    throw new Error(`parse error: unexpected token "${t.value}"`);
  }

  parseArrayLiteral(): Expr {
    this.expect('[');
    const elems: Array<Expr | SpreadElem> = [];
    while (!this.at(']') && !this.at('eof')) {
      if (this.at('...')) {
        this.next();
        elems.push({ k: 'spread', a: this.parseExpression() });
      } else {
        elems.push(this.parseExpression());
      }
      if (this.at(',')) this.next();
      else break;
    }
    this.expect(']');
    return { k: 'array', elems };
  }

  parseObjectLiteral(): Expr {
    this.expect('{');
    const props: Array<ObjProp> = [];
    while (!this.at('}') && !this.at('eof')) {
      if (this.at('...')) {
        this.next();
        props.push({ k: 'spread', key: '', val: this.parseExpression() });
      } else {
        const keyTok = this.next();
        const key = keyTok.value;
        let val: Expr | undefined;
        if (this.at(':')) {
          this.next();
          val = this.parseExpression();
        }
        props.push({ k: 'prop', key, val });
      }
      if (this.at(',')) this.next();
      else break;
    }
    this.expect('}');
    return { k: 'obj', props };
  }
}

function t_incr(t: Token): boolean {
  return (t.type === 'op' || t.type === 'ident') && (t.value === '++' || t.value === '--');
}

/* -----------------------------------------------------------------------------
 * Emitter
 * ---------------------------------------------------------------------------*/

interface Flat {
  base: string;
  parts: string[];
}

class Emitter {
  private reassigned: Set<string> = new Set();
  private INDENT = '  ';

  emit(program: Stmt[]): string {
    this.reassigned = analyseReassigned(program);
    return this.emitStatements(program, 0);
  }

  private emitStatements(list: Stmt[], ind: number): string {
    const lines: string[] = [];
    for (const s of list) {
      const out = this.emitStmt(s, ind);
      if (out.trim().length > 0) lines.push(out);
    }
    return lines.join('\n');
  }

  private emitStmt(s: Stmt, ind: number): string {
    const pad = this.INDENT.repeat(ind);
    const padIn = this.INDENT.repeat(ind + 1);
    switch (s.k) {
      case 'var': {
        const kw = this.declKeyword(s);
        const parts = s.decls.map((d) => {
          const base = `${d.name}`;
          if (d.init) return `${base} = ${this.emitExpr(d.init, 0)}`;
          return base;
        });
        return `${pad}${kw} ${parts.join(', ')};`;
      }
      case 'expr':
        return `${pad}${this.emitExprStmt(s.e)};`;
      case 'ret':
        return `${pad}return${s.v ? ` ${this.emitExpr(s.v, 0)}` : ''};`;
      case 'func': {
        const params = s.params.join(', ');
        const body = this.emitStatements(s.body, ind + 1);
        return `${pad}function ${s.name}(${params}) {\n${body}\n${pad}}`;
      }
      case 'block': {
        const body = this.emitStatements(s.body, ind + 1);
        return `${pad}{\n${body}\n${pad}}`;
      }
      case 'if': {
        let out = `${pad}if (${this.emitExpr(s.test, 0)}) ${this.emitInline(s.then, ind)}`;
        if (s.els) {
          out += ` else ${this.emitInline(s.els, ind)}`;
        }
        return out;
      }
      case 'for': {
        const init = s.init ? this.emitForInit(s.init) : '';
        const test = s.test ? this.emitExpr(s.test, 0) : '';
        const update = s.update ? this.emitExpr(s.update, 0) : '';
        const body = this.emitInline(s.body, ind);
        return `${pad}for (${init}; ${test}; ${update}) ${body}`;
      }
      case 'while': {
        const body = this.emitInline(s.body, ind);
        return `${pad}while (${this.emitExpr(s.test, 0)}) ${body}`;
      }
      case 'break':
        return `${pad}break;`;
      case 'continue':
        return `${pad}continue;`;
      case 'empty':
        return '';
      default:
        return '';
    }
  }

  /** Basic helper: if the child is a block, returns multiline; else single line. */
  private emitInline(s: Stmt, ind: number): string {
    const padIn = this.INDENT.repeat(ind + 1);
    if (s.k === 'block') {
      const body = this.emitStatements(s.body, ind + 1);
      return `{\n${body}\n${padIn}}`;
    }
    const out = this.emitStmt(s, ind + 1);
    // single-statement block-like printing: if, for, while nested
    return out.trimStart() === '' ? ';' : out.slice(padIn.length);
  }

  private emitForInit(s: Stmt): string {
    if (s.k === 'var') {
      const kw = this.declKeyword(s);
      const parts = s.decls.map((d) => {
        const base = `${d.name}`;
        return d.init ? `${base} = ${this.emitExpr(d.init, 0)}` : base;
      });
      return `${kw} ${parts.join(', ')}`;
    }
    if (s.k === 'expr') {
      return this.emitExprStmt(s.e);
    }
    return '';
  }

  private declKeyword(s: { decls: Array<{ name: string }> }): string {
    for (const d of s.decls) {
      if (this.reassigned.has(d.name)) return 'let';
    }
    return 'const';
  }

  /** Emits an expression-statement, applying the __set and array rules. */
  private emitExprStmt(e: Expr): string {
    // Rule: property assignment -> __set(base, "path", value)
    if (e.k === 'bin' && e.op === '=' ) {
      const flat = this.flattenMember(e.l);
      if (flat && flat.parts.length > 0) {
        return `__set(${flat.base}, ${JSON.stringify(flat.parts.join('.'))}, ${this.emitExpr(e.r, 0)})`;
      }
    }
    // Rule: array mutator statement
    if (e.k === 'call' && e.callee.k === 'mem' && ARRAY_MUTATORS.has(e.callee.prop)) {
      const recv = e.callee.obj;
      const method = e.callee.prop;
      const rtext = this.emitExpr(recv, 0);
      const args = e.args.map((a) => this.emitExpr(a, 0));
      const val = this.buildArrayValue(method, rtext, args);
      if (recv.k === 'id') {
        return `${rtext} = ${val}`;
      }
      const flat = this.flattenMember(recv);
      if (flat && flat.parts.length > 0) {
        return `__set(${flat.base}, ${JSON.stringify(flat.parts.join('.'))}, ${val})`;
      }
      return `${rtext} = ${val}`;
    }
    return this.emitExpr(e, 0);
  }

  private buildArrayValue(method: string, recv: string, args: string[]): string {
    switch (method) {
      case 'push':
        return `[...${recv}${args.length ? ', ' + args.join(', ') : ''}]`;
      case 'pop':
        return `${recv}.slice(0, -1)`;
      case 'shift':
        return `${recv}.slice(1)`;
      case 'unshift':
        return `[${args.join(', ')}${args.length ? ', ' : ''}...${recv}]`;
      case 'splice': {
        const start = args[0] ?? '0';
        const dc = args[1] ?? `${recv}.length - ${start}`;
        const items = args.slice(2);
        const head = `...${recv}.slice(0, ${start})`;
        const tail = `...${recv}.slice(${start} + ${dc})`;
        return `[${[head, ...items, tail].join(', ')}]`;
      }
      case 'sort':
        return `[...${recv}].sort(${args.join(', ')})`;
      case 'reverse':
        return `[...${recv}].reverse()`;
      default:
        throw new Error(`unreachable array mutator: ${method}`);
    }
  }

  private flattenMember(e: Expr): Flat | null {
    const parts: string[] = [];
    let cur = e;
    while (cur.k === 'mem') {
      if (cur.computed) {
        const i = cur.idx;
        if (!i) return null;
        if (i.k === 'str') {
          parts.unshift(i.t.slice(1, -1));
        } else if (i.k === 'num') {
          parts.unshift(i.t);
        } else {
          return null; // dynamic index
        }
      } else {
        parts.unshift(cur.prop);
      }
      cur = cur.obj;
    }
    return { base: this.emitExpr(cur, 0), parts };
  }

  private emitExpr(e: Expr, min: number): string {
    switch (e.k) {
      case 'id':
        return e.n;
      case 'num':
        return e.t;
      case 'str':
      case 'tmpl':
        return e.t;
      case 'lit':
        return e.v;
      case 'paren':
        return `(${this.emitExpr(e.e, 0)})`;
      case 'array': {
        const parts = e.elems.map((el) =>
          el.k === 'spread' ? '...' + this.emitExpr(el.a, 0) : this.emitExpr(el, 0),
        );
        return `[${parts.join(', ')}]`;
      }
      case 'obj': {
        const parts = e.props.map((p) => {
          if (p.k === 'spread') return '...' + (p.val ? this.emitExpr(p.val, 0) : '');
          return p.val ? `${p.key}: ${this.emitExpr(p.val, 0)}` : `${p.key}`;
        });
        return `{ ${parts.join(', ')} }`;
      }
      case 'un': {
        const needSpace = e.op === 'typeof' || e.op === 'void' || e.op === 'delete';
        const operand = this.emitOperand(e.a, 16);
        return `${e.op}${needSpace ? ' ' : ''}${operand}`;
      }
      case 'post': {
        return `${this.emitOperand(e.a, 17)}${e.op}`;
      }
      case 'mem': {
        const obj = this.emitOperand(e.obj, 17);
        if (e.computed) {
          return `${obj}[${this.emitExpr(e.idx as Expr, 0)}]`;
        }
        return `${obj}.${e.prop}`;
      }
      case 'call': {
        const callee = this.emitOperand(e.callee, 17);
        const args = e.args.map((a) => this.emitExpr(a, 0));
        return `${callee}(${args.join(', ')})`;
      }
      case 'bin': {
        const prec = this.binPrec(e.op);
        let s = `${this.emitOperand(e.l, prec)} ${e.op} ${this.emitOperand(e.r, prec + 1)}`;
        if (prec < min) s = `(${s})`;
        return s;
      }
      default:
        return '';
    }
  }

  private emitOperand(e: Expr, min: number): string {
    return this.emitExpr(e, min);
  }

  private binPrec(op: string): number {
    if (ASSIGN_OPS.has(op)) return 0;
    return BIN_PREC[op] ?? 0;
  }
}

/* -----------------------------------------------------------------------------
 * Reassignment analysis
 * ---------------------------------------------------------------------------*/

function analyseReassigned(program: Stmt[]): Set<string> {
  const set = new Set<string>();
  const addId = (e: Expr) => void 0;
  void addId;

  function visitExpr(e: Expr | undefined | null): void {
    if (!e) return;
    switch (e.k) {
      case 'id':
        return;
      case 'num':
      case 'str':
      case 'tmpl':
      case 'lit':
        return;
      case 'paren':
        visitExpr(e.e);
        return;
      case 'array':
        for (const el of e.elems) visitExpr(el.k === 'spread' ? el.a : el);
        return;
      case 'obj':
        for (const p of e.props) {
          if (p.k === 'spread') visitExpr(p.val);
          else visitExpr(p.val);
        }
        return;
      case 'un':
      case 'post':
        if ((e.op === '++' || e.op === '--') && e.a.k === 'id') set.add(e.a.n);
        visitExpr(e.a);
        return;
      case 'bin':
        if (ASSIGN_OPS.has(e.op)) {
          if (e.l.k === 'id') set.add(e.l.n);
          visitExpr(e.l);
          visitExpr(e.r);
          return;
        }
        visitExpr(e.l);
        visitExpr(e.r);
        return;
      case 'call':
        visitExpr(e.callee);
        for (const a of e.args) visitExpr(a);
        if (e.callee.k === 'mem' && ARRAY_MUTATORS.has(e.callee.prop) && e.callee.obj.k === 'id') {
          set.add(e.callee.obj.n);
        }
        return;
      case 'mem':
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.idx);
        return;
      default:
        return;
    }
  }

  function visitStmt(s: Stmt): void {
    switch (s.k) {
      case 'var':
        for (const d of s.decls) visitExpr(d.init);
        return;
      case 'expr':
        visitExpr(s.e);
        return;
      case 'ret':
        visitExpr(s.v);
        return;
      case 'func':
        for (const b of s.body) visitStmt(b);
        return;
      case 'block':
        for (const b of s.body) visitStmt(b);
        return;
      case 'if':
        visitExpr(s.test);
        visitStmt(s.then);
        if (s.els) visitStmt(s.els);
        return;
      case 'for':
        if (s.init) visitStmt(s.init);
        visitExpr(s.test);
        visitExpr(s.update);
        visitStmt(s.body);
        return;
      case 'while':
        visitExpr(s.test);
        visitStmt(s.body);
        return;
      default:
        return;
    }
  }

  for (const s of program) visitStmt(s);
  return set;
}