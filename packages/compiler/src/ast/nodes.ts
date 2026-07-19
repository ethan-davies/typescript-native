import type { SourceSpan } from "../diagnostics/diagnostic.js";

export type AstNode =
  | Program
  | FunctionDeclaration
  | ExpressionStatement
  | CallExpression
  | Identifier
  | StringLiteral;

interface AstNodeBase {
  readonly kind: string;
  readonly span: SourceSpan;
}

export interface Program extends AstNodeBase {
  readonly kind: "Program";
  readonly body: FunctionDeclaration[];
}

export type Statement = ExpressionStatement;

export interface FunctionDeclaration extends AstNodeBase {
  readonly kind: "FunctionDeclaration";
  readonly name: Identifier;
  readonly body: Statement[];
}

export interface ExpressionStatement extends AstNodeBase {
  readonly kind: "ExpressionStatement";
  readonly expression: CallExpression;
}

export type Expression = CallExpression | Identifier | StringLiteral;

export interface CallExpression extends AstNodeBase {
  readonly kind: "CallExpression";
  readonly callee: Identifier;
  readonly args: Expression[];
}

export interface Identifier extends AstNodeBase {
  readonly kind: "Identifier";
  readonly name: string;
}

export interface StringLiteral extends AstNodeBase {
  readonly kind: "StringLiteral";
  /** Decoded string contents (quotes stripped, escapes resolved). */
  readonly value: string;
  /** Original lexeme including quotes. */
  readonly raw: string;
}
