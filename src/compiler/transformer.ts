/**
 * @fileoverview The ValueScript compiler core (Vexify).
 *
 * Takes a `.vs` source string, parses it with the TypeScript compiler API,
 * rewrites all mutable operations to immutable ones, and prints the resulting
 * plain JavaScript.
 *
 * Transformation rules:
 *   1. Property assignment  `obj.a.b.c = v`  ->  `__set(obj, 'a.b.c', v)`
 *   2. Array in-place mutators are rewritten to immutable reassignments:
 *        push(a)    ->  [...arr, a]
 *        pop()      ->  arr.slice(0, -1)
 *        shift()    ->  arr.slice(1)
 *        unshift(a) ->  [a, ...arr]
 *        splice(s,d,...i) -> [...arr.slice(0,s), ...i, ...arr.slice(s+d)]
 *        sort()     ->  [...arr].sort()
 *        reverse()  ->  [...arr].reverse()
 *   3. `let` becomes `const` unless the variable is reassigned at runtime, in
 *      which case it must stay `let` (required so array mutator reassignments
 *      and re-assigned variables remain legal).
 *
 * The emitted output starts with an inline runtime preamble (the bridge helpers)
 * so the `.js` file is fully self-contained and has zero dependencies.
 */

import ts from 'typescript';
import { runtimePreamble } from '../runtime/bridge.js';

/** Array mutator method names handled by the compiler. */
const ARRAY_MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
]);

/** Compiles `.vs` source into plain, self-contained JavaScript. */
export function transformValueScript(source: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // Decide which variables are reassigned before rewriting.
  const reassigned = collectReassignedIdentifiers(sourceFile);

  const result = ts.transform(sourceFile, [transformerWithReassigned(reassigned)]);

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  const body = result.transformed.map((sf) => printer.printFile(sf)).join('\n');

  // Inline preamble + one blank line + compiled program.
  return runtimePreamble() + '\n\n' + body + '\n';
}

/* -----------------------------------------------------------------------------
 * Reassignment analysis
 * ---------------------------------------------------------------------------*/

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * Collects the names of every variable that is reassigned in the program. A
 * name is considered "reassigned" when it appears as the target of a plain
 * assignment (`x = ...`, `x += ...`, compound operators), when it is updated
 * with `++`/`--`, or when it is the receiver of an array mutator call (because
 * the rewrite rebinds that identifier).
 *
 * Property assignments (`obj.x = v`) do NOT mark `obj` as reassigned — they are
 * rewritten to `__set(obj, ...)` which never reassigns the base variable.
 */
function collectReassignedIdentifiers(sourceFile: ts.SourceFile): Set<string> {
  const set = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs)) set.add(lhs.text);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      // x++ / ++x / x-- / --x
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        if (ts.isIdentifier(node.operand)) set.add(node.operand.text);
      }
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ARRAY_MUTATORS.has(node.expression.name.text) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        set.add(node.expression.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return set;
}

/* -----------------------------------------------------------------------------
 * The transformer factory
 * ---------------------------------------------------------------------------*/

function transformerWithReassigned(
  reassigned: Set<string>,
): ts.TransformerFactory<ts.SourceFile> {
  const factory = ts.factory;

  /** Extracts a flattened path from a chain of property/element accesses. */
  function extractPath(expr: ts.Expression): { base: ts.Expression; path: string } | null {
    const parts: string[] = [];
    let cur = expr;
    while (true) {
      if (ts.isPropertyAccessExpression(cur)) {
        parts.unshift(cur.name.text);
        cur = cur.expression;
      } else if (ts.isElementAccessExpression(cur)) {
        const arg = cur.argumentExpression;
        if (ts.isStringLiteral(arg)) {
          parts.unshift(arg.text);
        } else if (ts.isNumericLiteral(arg)) {
          parts.unshift(arg.text);
        } else if (ts.isNoSubstitutionTemplateLiteral(arg)) {
          parts.unshift(arg.text);
        } else {
          // Dynamic index — cannot flatten into a path string.
          return null;
        }
        cur = cur.expression;
      } else {
        break;
      }
    }
    if (parts.length === 0) return null;
    return { base: cur, path: parts.join('.') };
  }

  /** Builds `base.path = rhs` and routes it through `__set` when nested. */
  function buildAssignment(lhs: ts.Expression, rhs: ts.Expression): ts.Expression {
    if (ts.isIdentifier(lhs)) {
      return factory.createBinaryExpression(
        lhs,
        factory.createToken(ts.SyntaxKind.EqualsToken),
        rhs,
      );
    }
    const extracted = extractPath(lhs);
    if (extracted && extracted.path.length > 0) {
      return factory.createCallExpression(factory.createIdentifier('__set'), undefined, [
        extracted.base,
        factory.createStringLiteral(extracted.path),
        rhs,
      ]);
    }
    // Fallback: generic assignment.
    return factory.createBinaryExpression(
      lhs,
      factory.createToken(ts.SyntaxKind.EqualsToken),
      rhs,
    );
  }

  /** Rewrites `obj.a.b = v` into `__set(obj, 'a.b', v)`. */
  function toSetCall(node: ts.BinaryExpression): ts.Expression | null {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
    const extracted = extractPath(node.left);
    if (!extracted || extracted.path.length === 0) return null;
    return factory.createCallExpression(factory.createIdentifier('__set'), undefined, [
      extracted.base,
      factory.createStringLiteral(extracted.path),
      node.right,
    ]);
  }

  /** Spreads a receiver inside an array literal: `[...recv]`. */
  function spread(expr: ts.Expression): ts.SpreadElement {
    return factory.createSpreadElement(expr);
  }

  /** Calls `recv.slice(a, b)` (b optional). */
  function slice(recv: ts.Expression, from: ts.Expression, to?: ts.Expression): ts.Expression {
    const args: ts.Expression[] = [from];
    if (to) args.push(to);
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(recv, 'slice'),
      undefined,
      args,
    );
  }

  /** Builds the immutable RHS expression for each array mutator. */
  function buildArrayRhs(
    method: string,
    recv: ts.Expression,
    args: ts.NodeArray<ts.Expression>,
  ): ts.Expression {
    switch (method) {
      case 'push': {
        // arr.push(...items) -> [...arr, ...items]
        return factory.createArrayLiteralExpression([spread(recv), ...args], false);
      }
      case 'pop': {
        // arr.pop() -> arr.slice(0, -1)
        const negOne = factory.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          factory.createNumericLiteral(1),
        );
        return slice(recv, factory.createNumericLiteral(0), negOne);
      }
      case 'shift': {
        // arr.shift() -> arr.slice(1)
        return slice(recv, factory.createNumericLiteral(1));
      }
      case 'unshift': {
        // arr.unshift(...items) -> [...items, ...arr]
        return factory.createArrayLiteralExpression([...args, spread(recv)], false);
      }
      case 'splice': {
        // arr.splice(start, deleteCount, ...items)
        // -> [...arr.slice(0, start), ...items, ...arr.slice(start + deleteCount)]
        const start = args[0] ?? factory.createNumericLiteral(0);
        const deleteCount =
          args[1] ??
          factory.createBinaryExpression(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(recv, 'length'),
              undefined,
              [],
            ),
            factory.createToken(ts.SyntaxKind.MinusToken),
            start,
          );
        const items = args.slice(2);
        const head = spread(slice(recv, factory.createNumericLiteral(0), start));
        const tailStart = factory.createBinaryExpression(
          start,
          factory.createToken(ts.SyntaxKind.PlusToken),
          deleteCount,
        );
        const tail = spread(slice(recv, tailStart));
        return factory.createArrayLiteralExpression([head, ...items, tail], false);
      }
      case 'sort': {
        // arr.sort(comp?) -> [...arr].sort(comp)
        const sorted = factory.createArrayLiteralExpression([spread(recv)], false);
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(sorted, 'sort'),
          undefined,
          [...args],
        );
      }
      case 'reverse': {
        // arr.reverse() -> [...arr].reverse()
        const reversed = factory.createArrayLiteralExpression([spread(recv)], false);
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(reversed, 'reverse'),
          undefined,
          [],
        );
      }
      default:
        throw new Error(`Unreachable array mutator: ${method}`);
    }
  }

  /** Rewrites `arr.push(x)` etc. into an immutable reassignment. */
  function toArrayMutation(node: ts.CallExpression): ts.Expression | null {
    const expr = node.expression;
    if (!ts.isPropertyAccessExpression(expr)) return null;
    const method = expr.name.text;
    if (!ARRAY_MUTATORS.has(method)) return null;
    const recv = expr.expression;
    const rhs = buildArrayRhs(method, recv, node.arguments);
    return buildAssignment(recv, rhs);
  }

  /** Applies the let->const rule to a declaration list. */
  function fixDeclarationList(node: ts.VariableDeclarationList): ts.Node {
    const isLet = (node.flags & ts.NodeFlags.Let) !== 0;
    const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
    if (!isLet && !isConst) return node;

    let requiresLet = false;
    for (const decl of node.declarations) {
      for (const name of collectBoundNames(decl.name)) {
        if (reassigned.has(name)) {
          requiresLet = true;
          break;
        }
      }
      if (requiresLet) break;
    }

    let newFlags = node.flags;
    if (requiresLet) {
      newFlags = newFlags & ~ts.NodeFlags.Const;
      if (!isLet) newFlags |= ts.NodeFlags.Let;
    } else {
      newFlags = (newFlags & ~ts.NodeFlags.Let) | ts.NodeFlags.Const;
    }
    if (newFlags === node.flags) return node;
    return ts.factory.createVariableDeclarationList(node.declarations, newFlags);
  }

  return (context) => {
    const visit: ts.Visitor = (node): ts.Node => {
      node = ts.visitEachChild(node, visit, context);

      if (ts.isVariableDeclarationList(node)) {
        return fixDeclarationList(node);
      }
      if (ts.isBinaryExpression(node)) {
        const setCall = toSetCall(node);
        if (setCall) return setCall;
      }
      if (ts.isCallExpression(node)) {
        const assignment = toArrayMutation(node);
        if (assignment) return assignment;
      }
      return node;
    };

    return (sourceFile) =>
      ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };
}

/** Collects every identifier bound by a binding name (incl. destructuring). */
function collectBoundNames(name: ts.BindingName): string[] {
  const names: string[] = [];
  if (ts.isIdentifier(name)) {
    names.push(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      names.push(...collectBoundNames(el.name));
    }
  }
  return names;
}