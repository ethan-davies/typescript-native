import type { SourceSpan } from "../diagnostics/diagnostic.js";

export type PrimitiveTypeName =
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "bool"
  | "string"
  | "char"
  | "void";

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

export type AstNode =
  | Program
  | FunctionDeclaration
  | StructDeclaration
  | StructField
  | Parameter
  | VariableDeclaration
  | AssignmentStatement
  | UpdateStatement
  | ExpressionStatement
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForInStatement
  | BreakStatement
  | ContinueStatement
  | CallExpression
  | BinaryExpression
  | UnaryExpression
  | IndexExpression
  | MemberExpression
  | ArrayLiteral
  | StructLiteral
  | StructFieldInit
  | Identifier
  | StringLiteral
  | IntegerLiteral
  | FloatLiteral
  | BooleanLiteral
  | CharLiteral
  | TypeAnnotation;

interface AstNodeBase {
  readonly kind: string;
  readonly span: SourceSpan;
}

export type TopLevelDeclaration = FunctionDeclaration | StructDeclaration;

export interface Program extends AstNodeBase {
  readonly kind: "Program";
  readonly body: TopLevelDeclaration[];
}

export type Statement =
  | VariableDeclaration
  | AssignmentStatement
  | UpdateStatement
  | ExpressionStatement
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | ForInStatement
  | BreakStatement
  | ContinueStatement;

export interface Parameter extends AstNodeBase {
  readonly kind: "Parameter";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
}

export interface FunctionDeclaration extends AstNodeBase {
  readonly kind: "FunctionDeclaration";
  readonly name: Identifier;
  readonly params: Parameter[];
  readonly returnType: TypeAnnotation;
  readonly body: Statement[];
}

export interface StructField extends AstNodeBase {
  readonly kind: "StructField";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
}

export interface StructDeclaration extends AstNodeBase {
  readonly kind: "StructDeclaration";
  readonly name: Identifier;
  readonly fields: StructField[];
}

export interface VariableDeclaration extends AstNodeBase {
  readonly kind: "VariableDeclaration";
  readonly mutability: "let" | "const";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  readonly initializer: Expression;
}

export type Assignable = Identifier | IndexExpression | MemberExpression;

export interface AssignmentStatement extends AstNodeBase {
  readonly kind: "AssignmentStatement";
  readonly target: Assignable;
  readonly operator: "=" | "+=" | "-=";
  readonly value: Expression;
}

export interface UpdateStatement extends AstNodeBase {
  readonly kind: "UpdateStatement";
  readonly name: Identifier;
  readonly operator: "++" | "--";
}

export interface ExpressionStatement extends AstNodeBase {
  readonly kind: "ExpressionStatement";
  readonly expression: Expression;
}

export interface ReturnStatement extends AstNodeBase {
  readonly kind: "ReturnStatement";
  readonly value: Expression | null;
}

export interface IfStatement extends AstNodeBase {
  readonly kind: "IfStatement";
  readonly condition: Expression;
  readonly consequent: Statement[];
  /** elseif → nested IfStatement; else { } → Statement[]; bare if → null */
  readonly alternate: IfStatement | Statement[] | null;
}

export interface WhileStatement extends AstNodeBase {
  readonly kind: "WhileStatement";
  readonly condition: Expression;
  readonly body: Statement[];
}

export interface ForStatement extends AstNodeBase {
  readonly kind: "ForStatement";
  readonly initializer: VariableDeclaration | AssignmentStatement | null;
  readonly condition: Expression | null;
  readonly update: UpdateStatement | AssignmentStatement | null;
  readonly body: Statement[];
}

export interface ForInStatement extends AstNodeBase {
  readonly kind: "ForInStatement";
  /** null = bare `for (i in xs)`; let/const introduce an explicit binding */
  readonly mutability: "let" | "const" | null;
  readonly name: Identifier;
  readonly iterable: Expression;
  readonly body: Statement[];
}

export interface BreakStatement extends AstNodeBase {
  readonly kind: "BreakStatement";
}

export interface ContinueStatement extends AstNodeBase {
  readonly kind: "ContinueStatement";
}

export type Expression =
  | CallExpression
  | BinaryExpression
  | UnaryExpression
  | IndexExpression
  | MemberExpression
  | ArrayLiteral
  | StructLiteral
  | Identifier
  | StringLiteral
  | IntegerLiteral
  | FloatLiteral
  | BooleanLiteral
  | CharLiteral;

export type CallCallee = Identifier | MemberExpression;

export interface CallExpression extends AstNodeBase {
  readonly kind: "CallExpression";
  readonly callee: CallCallee;
  readonly args: Expression[];
}

export interface BinaryExpression extends AstNodeBase {
  readonly kind: "BinaryExpression";
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface UnaryExpression extends AstNodeBase {
  readonly kind: "UnaryExpression";
  readonly operator: "-" | "!";
  readonly operand: Expression;
}

export interface IndexExpression extends AstNodeBase {
  readonly kind: "IndexExpression";
  readonly object: Expression;
  readonly index: Expression;
}

export interface MemberExpression extends AstNodeBase {
  readonly kind: "MemberExpression";
  readonly object: Expression;
  readonly property: Identifier;
}

export interface ArrayLiteral extends AstNodeBase {
  readonly kind: "ArrayLiteral";
  readonly elements: Expression[];
}

export interface StructFieldInit extends AstNodeBase {
  readonly kind: "StructFieldInit";
  readonly name: Identifier;
  readonly value: Expression;
}

export interface StructLiteral extends AstNodeBase {
  readonly kind: "StructLiteral";
  readonly name: Identifier;
  readonly fields: StructFieldInit[];
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

export interface IntegerLiteral extends AstNodeBase {
  readonly kind: "IntegerLiteral";
  readonly value: number;
  readonly raw: string;
}

export interface FloatLiteral extends AstNodeBase {
  readonly kind: "FloatLiteral";
  readonly value: number;
  readonly raw: string;
}

export interface BooleanLiteral extends AstNodeBase {
  readonly kind: "BooleanLiteral";
  readonly value: boolean;
}

export interface CharLiteral extends AstNodeBase {
  readonly kind: "CharLiteral";
  readonly value: string;
  readonly raw: string;
}

export type TypeAnnotation = PrimitiveType | ArrayType | NamedType;

export interface PrimitiveType extends AstNodeBase {
  readonly kind: "PrimitiveType";
  readonly name: PrimitiveTypeName;
}

export interface ArrayType extends AstNodeBase {
  readonly kind: "ArrayType";
  readonly element: TypeAnnotation;
}

export interface NamedType extends AstNodeBase {
  readonly kind: "NamedType";
  readonly name: string;
}
