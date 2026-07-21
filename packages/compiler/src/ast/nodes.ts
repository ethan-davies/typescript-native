import type { SourceSpan } from "../diagnostics/diagnostic.js";

export type PrimitiveTypeName =
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "bool"
  | "string"
  | "char"
  | "void"
  | "null";

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

export type Visibility = "public" | "private";

export type AstNode =
  | Program
  | ImportDeclaration
  | FunctionDeclaration
  | StructDeclaration
  | StructField
  | StructMethod
  | EnumDeclaration
  | EnumVariant
  | ClassDeclaration
  | ClassField
  | ClassMethod
  | ConstructorDeclaration
  | InterfaceDeclaration
  | InterfaceMethodSignature
  | InterfaceIndexSignature
  | TypeAliasDeclaration
  | TypeParameter
  | Parameter
  | NamedArgument
  | LambdaParameter
  | LambdaExpression
  | VariableDeclaration
  | ArrayBindingPattern
  | ArrayBindingElement
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
  | TypeofExpression
  | IsExpression
  | IndexExpression
  | MemberExpression
  | ArrayLiteral
  | StructLiteral
  | StructFieldInit
  | NewExpression
  | ThisExpression
  | SuperExpression
  | Identifier
  | StringLiteral
  | IntegerLiteral
  | FloatLiteral
  | BooleanLiteral
  | CharLiteral
  | NullLiteral
  | TypeAnnotation;

interface AstNodeBase {
  readonly kind: string;
  readonly span: SourceSpan;
}

export type TopLevelDeclaration =
  | ImportDeclaration
  | FunctionDeclaration
  | StructDeclaration
  | EnumDeclaration
  | ClassDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration;

export interface Program extends AstNodeBase {
  readonly kind: "Program";
  readonly body: TopLevelDeclaration[];
}

export interface ImportDeclaration extends AstNodeBase {
  readonly kind: "ImportDeclaration";
  readonly source: StringLiteral;
  /** Namespace binding; null means use the resolved file basename. */
  readonly alias: Identifier | null;
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

export interface TypeParameter extends AstNodeBase {
  readonly kind: "TypeParameter";
  readonly name: Identifier;
  /** Constraint from `extends`; null when unconstrained. */
  readonly constraint: TypeAnnotation | null;
}

export interface Parameter extends AstNodeBase {
  readonly kind: "Parameter";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
  /** Optional default; evaluated at the call site when the argument is omitted. */
  readonly defaultValue: Expression | null;
}

/** Named argument at a call site: `foo(name: value)`. Not a standalone expression. */
export interface NamedArgument extends AstNodeBase {
  readonly kind: "NamedArgument";
  readonly name: Identifier;
  readonly value: Expression;
}

export type CallArgument = Expression | NamedArgument;

export interface FunctionDeclaration extends AstNodeBase {
  readonly kind: "FunctionDeclaration";
  readonly exported: boolean;
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  readonly params: Parameter[];
  readonly returnType: TypeAnnotation;
  readonly body: Statement[];
}

export interface StructField extends AstNodeBase {
  readonly kind: "StructField";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
}

export interface StructMethod extends AstNodeBase {
  readonly kind: "StructMethod";
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  readonly params: Parameter[];
  readonly returnType: TypeAnnotation;
  readonly body: Statement[];
}

export interface StructDeclaration extends AstNodeBase {
  readonly kind: "StructDeclaration";
  readonly exported: boolean;
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  readonly fields: StructField[];
  readonly methods: StructMethod[];
}

export interface EnumVariant extends AstNodeBase {
  readonly kind: "EnumVariant";
  readonly name: Identifier;
}

export interface EnumDeclaration extends AstNodeBase {
  readonly kind: "EnumDeclaration";
  readonly exported: boolean;
  readonly name: Identifier;
  readonly variants: EnumVariant[];
}

export interface ClassField extends AstNodeBase {
  readonly kind: "ClassField";
  readonly visibility: Visibility;
  readonly isStatic: boolean;
  readonly isReadonly: boolean;
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
  /** Allowed for static fields; null means zero/default init at codegen. */
  readonly initializer: Expression | null;
}

export interface ClassMethod extends AstNodeBase {
  readonly kind: "ClassMethod";
  readonly visibility: Visibility;
  readonly isStatic: boolean;
  readonly isAbstract: boolean;
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  readonly params: Parameter[];
  readonly returnType: TypeAnnotation;
  /** null when abstract. */
  readonly body: Statement[] | null;
}

export interface ConstructorDeclaration extends AstNodeBase {
  readonly kind: "ConstructorDeclaration";
  readonly visibility: Visibility;
  readonly params: Parameter[];
  readonly body: Statement[];
}

export type ClassMember = ClassField | ClassMethod | ConstructorDeclaration;

export interface ClassDeclaration extends AstNodeBase {
  readonly kind: "ClassDeclaration";
  readonly exported: boolean;
  readonly isAbstract: boolean;
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  /** Local or qualified superclass name; null if none. */
  readonly superclass: NamedType | null;
  /** Interfaces this class promises to implement. */
  readonly implementsTypes: NamedType[];
  readonly members: ClassMember[];
}

export interface InterfaceMethodSignature extends AstNodeBase {
  readonly kind: "InterfaceMethodSignature";
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  readonly params: Parameter[];
  readonly returnType: TypeAnnotation;
}

export interface InterfaceIndexSignature extends AstNodeBase {
  readonly kind: "InterfaceIndexSignature";
  readonly keyName: Identifier;
  readonly keyType: TypeAnnotation;
  readonly valueType: TypeAnnotation;
}

export interface InterfaceDeclaration extends AstNodeBase {
  readonly kind: "InterfaceDeclaration";
  readonly exported: boolean;
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  /** Interfaces this interface extends. */
  readonly bases: NamedType[];
  readonly methods: InterfaceMethodSignature[];
  readonly indexSignature: InterfaceIndexSignature | null;
}

export interface TypeAliasDeclaration extends AstNodeBase {
  readonly kind: "TypeAliasDeclaration";
  readonly exported: boolean;
  readonly name: Identifier;
  readonly typeParams: TypeParameter[];
  readonly type: TypeAnnotation;
}

export interface ArrayBindingElement extends AstNodeBase {
  readonly kind: "ArrayBindingElement";
  /** null when the element is a hole (`let [a, , b] = …`). */
  readonly name: Identifier | null;
}

export interface ArrayBindingPattern extends AstNodeBase {
  readonly kind: "ArrayBindingPattern";
  readonly elements: ArrayBindingElement[];
}

export type BindingPattern = Identifier | ArrayBindingPattern;

export interface VariableDeclaration extends AstNodeBase {
  readonly kind: "VariableDeclaration";
  readonly mutability: "let" | "const";
  readonly binding: BindingPattern;
  readonly typeAnnotation: TypeAnnotation | null;
  /** null when declared as `let x: T;` without an initializer. */
  readonly initializer: Expression | null;
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
  | LambdaExpression
  | BinaryExpression
  | UnaryExpression
  | TypeofExpression
  | IsExpression
  | IndexExpression
  | MemberExpression
  | ArrayLiteral
  | StructLiteral
  | NewExpression
  | ThisExpression
  | SuperExpression
  | Identifier
  | StringLiteral
  | IntegerLiteral
  | FloatLiteral
  | BooleanLiteral
  | CharLiteral
  | NullLiteral;

export type CallCallee = Expression;

export interface CallExpression extends AstNodeBase {
  readonly kind: "CallExpression";
  readonly callee: CallCallee;
  /** Explicit type arguments from `foo<T>(...)`; empty when inferred or non-generic. */
  readonly typeArgs: TypeAnnotation[];
  readonly args: CallArgument[];
}

export interface LambdaParameter extends AstNodeBase {
  readonly kind: "LambdaParameter";
  readonly name: Identifier;
  /** Null when the type is inferred from context. */
  readonly typeAnnotation: TypeAnnotation | null;
}

export type LambdaBody =
  | { readonly kind: "expression"; readonly expression: Expression }
  | { readonly kind: "block"; readonly statements: Statement[] };

export interface LambdaExpression extends AstNodeBase {
  readonly kind: "LambdaExpression";
  readonly params: LambdaParameter[];
  readonly returnType: TypeAnnotation | null;
  readonly body: LambdaBody;
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

export interface TypeofExpression extends AstNodeBase {
  readonly kind: "TypeofExpression";
  readonly operand: Expression;
}

export interface IsExpression extends AstNodeBase {
  readonly kind: "IsExpression";
  readonly value: Expression;
  readonly typeAnnotation: TypeAnnotation;
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
  /** Import alias when written as `math.Point { ... }`; null for bare `Point { ... }`. */
  readonly namespace: Identifier | null;
  readonly name: Identifier;
  readonly typeArgs: TypeAnnotation[];
  readonly fields: StructFieldInit[];
}

export interface NewExpression extends AstNodeBase {
  readonly kind: "NewExpression";
  /** Import alias when written as `new math.Person(...)`; null for bare `new Person(...)`. */
  readonly namespace: Identifier | null;
  readonly className: Identifier;
  readonly typeArgs: TypeAnnotation[];
  readonly args: CallArgument[];
}

export interface ThisExpression extends AstNodeBase {
  readonly kind: "ThisExpression";
}

export interface SuperExpression extends AstNodeBase {
  readonly kind: "SuperExpression";
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

export interface NullLiteral extends AstNodeBase {
  readonly kind: "NullLiteral";
}

export interface CharLiteral extends AstNodeBase {
  readonly kind: "CharLiteral";
  readonly value: string;
  readonly raw: string;
}

export type TypeAnnotation =
  | PrimitiveType
  | ArrayType
  | TupleType
  | NamedType
  | UnionType
  | IntersectionType
  | ObjectType
  | LiteralType
  | KeyofType
  | TypeofType
  | ConditionalType
  | MappedType
  | IndexedAccessType
  | FunctionType;

export interface FunctionType extends AstNodeBase {
  readonly kind: "FunctionType";
  readonly params: TypeAnnotation[];
  readonly returnType: TypeAnnotation;
}

export interface PrimitiveType extends AstNodeBase {
  readonly kind: "PrimitiveType";
  readonly name: PrimitiveTypeName;
}

export interface ArrayType extends AstNodeBase {
  readonly kind: "ArrayType";
  readonly element: TypeAnnotation;
}

export interface TupleType extends AstNodeBase {
  readonly kind: "TupleType";
  readonly elements: TypeAnnotation[];
}

export interface NamedType extends AstNodeBase {
  readonly kind: "NamedType";
  /** Import alias when written as `math.Point`; null for bare `Point`. */
  readonly namespace: string | null;
  readonly name: string;
  readonly typeArgs: TypeAnnotation[];
}

export interface UnionType extends AstNodeBase {
  readonly kind: "UnionType";
  readonly types: TypeAnnotation[];
}

export interface IntersectionType extends AstNodeBase {
  readonly kind: "IntersectionType";
  readonly types: TypeAnnotation[];
}

export interface ObjectTypeField extends AstNodeBase {
  readonly kind: "ObjectTypeField";
  readonly readonly: boolean;
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
}

export interface ObjectIndexSignature extends AstNodeBase {
  readonly kind: "ObjectIndexSignature";
  readonly keyName: Identifier;
  readonly keyType: TypeAnnotation;
  readonly valueType: TypeAnnotation;
}

export interface ObjectType extends AstNodeBase {
  readonly kind: "ObjectType";
  readonly fields: ObjectTypeField[];
  readonly indexSignature: ObjectIndexSignature | null;
}

export interface LiteralType extends AstNodeBase {
  readonly kind: "LiteralType";
  readonly value: string | number;
  readonly literalKind: "string" | "number";
}

export interface KeyofType extends AstNodeBase {
  readonly kind: "KeyofType";
  readonly type: TypeAnnotation;
}

export interface TypeofType extends AstNodeBase {
  readonly kind: "TypeofType";
  /** Expression whose type is queried (identifier or call). */
  readonly expression: Expression;
}

export interface ConditionalType extends AstNodeBase {
  readonly kind: "ConditionalType";
  readonly checkType: TypeAnnotation;
  readonly extendsType: TypeAnnotation;
  readonly trueType: TypeAnnotation;
  readonly falseType: TypeAnnotation;
}

export interface MappedType extends AstNodeBase {
  readonly kind: "MappedType";
  readonly readonly: boolean;
  readonly typeParam: Identifier;
  readonly constraint: TypeAnnotation;
  readonly type: TypeAnnotation;
}

export interface IndexedAccessType extends AstNodeBase {
  readonly kind: "IndexedAccessType";
  readonly objectType: TypeAnnotation;
  readonly indexType: TypeAnnotation;
}
