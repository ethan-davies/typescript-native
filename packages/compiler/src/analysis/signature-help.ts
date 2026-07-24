import type {
  CallExpression,
  Expression,
  NewExpression,
  Program,
  Statement,
} from "../ast/nodes.js";
import type { CallSignatureInfo, SemanticModel } from "./semantic.js";
import { semanticKey } from "./semantic.js";

export interface SignatureHelpInfo {
  readonly signatures: readonly CallSignatureInfo[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

/**
 * Signature help at `offset` inside a call/new argument list.
 * Prefers the innermost enclosing call with a recorded signature.
 */
export function signatureHelpAt(
  model: SemanticModel,
  file: string,
  offset: number,
  sourceText?: string,
): SignatureHelpInfo | null {
  const mod = model.modules.find((m) => m.path === file);
  if (!mod) {
    return null;
  }
  const source = sourceText ?? mod.source;

  // Prefer recorded signatures (typechecker-resolved).
  let bestRecorded: CallSignatureInfo | null = null;
  for (const [key, info] of model.callSignatures) {
    if (!key.startsWith(`${file}:`)) {
      continue;
    }
    if (
      offset < info.callSpan.start.offset ||
      offset > info.callSpan.end.offset
    ) {
      continue;
    }
    if (
      !bestRecorded ||
      info.callSpan.end.offset - info.callSpan.start.offset <
        bestRecorded.callSpan.end.offset - bestRecorded.callSpan.start.offset
    ) {
      bestRecorded = info;
    }
  }

  if (bestRecorded) {
    const call = findCallAt(mod.ast, bestRecorded.callSpan.start.offset);
    const activeParameter = call
      ? activeParamIndex(call, source, offset)
      : activeParamFromSource(source, bestRecorded.callSpan.start.offset, offset);
    return {
      signatures: [bestRecorded],
      activeSignature: 0,
      activeParameter: clampActive(
        activeParameter,
        bestRecorded.parameters.length,
      ),
    };
  }

  // Incomplete call (no recorded sig) — find innermost AST call and bail if none.
  const call = findInnermostCall(mod.ast, offset);
  if (!call) {
    return null;
  }
  return null;
}

function clampActive(index: number, paramCount: number): number {
  if (paramCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, paramCount - 1));
}

function activeParamFromSource(
  source: string,
  callStart: number,
  offset: number,
): number {
  const open = source.indexOf("(", callStart);
  if (open < 0 || offset <= open) {
    return 0;
  }
  let commas = 0;
  let depth = 0;
  for (let i = open + 1; i < offset && i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      commas += 1;
    } else if (ch === '"' || ch === "'") {
      i = skipString(source, i);
    }
  }
  return commas;
}

function skipString(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      return i;
    }
    i += 1;
  }
  return i;
}

function activeParamIndex(
  call: CallExpression | NewExpression,
  source: string,
  offset: number,
): number {
  if (call.args.length > 0) {
    for (let i = 0; i < call.args.length; i += 1) {
      const arg = call.args[i]!;
      if (offset <= arg.span.end.offset) {
        return i;
      }
    }
    return Math.max(0, call.args.length - 1);
  }
  return activeParamFromSource(source, call.span.start.offset, offset);
}

function findCallAt(
  program: Program,
  startOffset: number,
): CallExpression | NewExpression | null {
  let found: CallExpression | NewExpression | null = null;
  visitProgram(program, (node) => {
    if (node.span.start.offset === startOffset) {
      found = node;
    }
  });
  return found;
}

function findInnermostCall(
  program: Program,
  offset: number,
): CallExpression | NewExpression | null {
  let best: CallExpression | NewExpression | null = null;
  visitProgram(program, (node) => {
    if (offset < node.span.start.offset || offset > node.span.end.offset) {
      return;
    }
    if (
      !best ||
      node.span.end.offset - node.span.start.offset <
        best.span.end.offset - best.span.start.offset
    ) {
      best = node;
    }
  });
  return best;
}

function visitProgram(
  program: Program,
  visit: (node: CallExpression | NewExpression) => void,
): void {
  const walkExpr = (expr: Expression | null | undefined) => {
    if (!expr) {
      return;
    }
    switch (expr.kind) {
      case "CallExpression":
        visit(expr);
        walkExpr(expr.callee);
        for (const arg of expr.args) {
          walkExpr(arg.kind === "NamedArgument" ? arg.value : arg);
        }
        break;
      case "NewExpression":
        visit(expr);
        for (const arg of expr.args) {
          walkExpr(arg.kind === "NamedArgument" ? arg.value : arg);
        }
        break;
      case "MemberExpression":
        walkExpr(expr.object);
        break;
      case "BinaryExpression":
        walkExpr(expr.left);
        walkExpr(expr.right);
        break;
      case "UnaryExpression":
        walkExpr(expr.operand);
        break;
      case "IndexExpression":
        walkExpr(expr.object);
        walkExpr(expr.index);
        break;
      case "AwaitExpression":
        walkExpr(expr.argument);
        break;
      case "IsExpression":
        walkExpr(expr.value);
        break;
      case "ArrayLiteral":
        for (const el of expr.elements) {
          walkExpr(el);
        }
        break;
      case "LambdaExpression": {
        const body = expr.body;
        if (body.kind === "block") {
          for (const stmt of body.statements) {
            walkStmt(stmt);
          }
        } else {
          walkExpr(body.expression);
        }
        break;
      }
      default:
        break;
    }
  };

  const walkStmt = (stmt: Statement) => {
    switch (stmt.kind) {
      case "ExpressionStatement":
        walkExpr(stmt.expression);
        break;
      case "VariableDeclaration":
        walkExpr(stmt.initializer);
        break;
      case "ReturnStatement":
        walkExpr(stmt.value);
        break;
      case "IfStatement":
        walkExpr(stmt.condition);
        for (const s of stmt.consequent) walkStmt(s);
        if (Array.isArray(stmt.alternate)) {
          for (const s of stmt.alternate) walkStmt(s);
        } else if (stmt.alternate) {
          walkStmt(stmt.alternate);
        }
        break;
      case "WhileStatement":
        walkExpr(stmt.condition);
        for (const s of stmt.body) walkStmt(s);
        break;
      case "ForStatement":
        if (stmt.initializer?.kind === "VariableDeclaration") {
          walkStmt(stmt.initializer);
        } else if (stmt.initializer?.kind === "AssignmentStatement") {
          walkStmt(stmt.initializer);
        }
        walkExpr(stmt.condition);
        if (stmt.update?.kind === "AssignmentStatement") {
          walkExpr(stmt.update.value);
        }
        for (const s of stmt.body) walkStmt(s);
        break;
      case "ForInStatement":
        walkExpr(stmt.iterable);
        for (const s of stmt.body) walkStmt(s);
        break;
      case "AssignmentStatement":
        walkExpr(stmt.value);
        break;
      case "ThrowStatement":
        walkExpr(stmt.expression);
        break;
      case "TryStatement":
        for (const s of stmt.tryBlock) walkStmt(s);
        if (stmt.catchClause) {
          for (const s of stmt.catchClause.body) walkStmt(s);
        }
        if (stmt.finallyBlock) {
          for (const s of stmt.finallyBlock) walkStmt(s);
        }
        break;
      case "SwitchStatement":
        walkExpr(stmt.discriminant);
        for (const arm of stmt.cases) {
          if (arm.test) walkExpr(arm.test);
          for (const s of arm.body) walkStmt(s);
        }
        break;
      default:
        break;
    }
  };

  for (const decl of program.body) {
    if (decl.kind === "FunctionDeclaration" && decl.body) {
      for (const stmt of decl.body) walkStmt(stmt);
    } else if (decl.kind === "ModuleVariableDeclaration") {
      walkExpr(decl.initializer);
    } else if (decl.kind === "StructDeclaration") {
      for (const member of decl.methods) {
        if (member.body) {
          for (const stmt of member.body) walkStmt(stmt);
        }
      }
    } else if (decl.kind === "ClassDeclaration") {
      for (const member of decl.members) {
        if (
          (member.kind === "ClassMethod" ||
            member.kind === "ConstructorDeclaration") &&
          member.body
        ) {
          for (const stmt of member.body) walkStmt(stmt);
        }
      }
    }
  }
}
