import type {
  ArrayBindingElement,
  ArrayBindingPattern,
  ArrayLiteral,
  Assignable,
  AssignmentStatement,
  BinaryExpression,
  BinaryOperator,
  BindingPattern,
  BooleanLiteral,
  BreakStatement,
  CatchClause,
  CallArgument,
  CallExpression,
  CharLiteral,
  ClassDeclaration,
  ClassField,
  ClassMember,
  ClassMethod,
  ConditionalType,
  ConstructorDeclaration,
  ContinueStatement,
  EnumDeclaration,
  EnumVariant,
  Expression,
  ExpressionStatement,
  FloatLiteral,
  ForInStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  ImportDeclaration,
  IndexedAccessType,
  IndexExpression,
  IntegerLiteral,
  InterfaceDeclaration,
  InterfaceIndexSignature,
  InterfaceMethodSignature,
  IntersectionType,
  IsExpression,
  FunctionType,
  KeyofType,
  LambdaExpression,
  LambdaParameter,
  LiteralType,
  MappedType,
  MemberExpression,
  NamedArgument,
  NamedType,
  NewExpression,
  NonNullExpression,
  NullCoalescingExpression,
  NullLiteral,
  ObjectIndexSignature,
  ObjectType,
  ObjectTypeField,
  Parameter,
  PrimitiveTypeName,
  Program,
  ReturnStatement,
  Statement,
  StringLiteral,
  StructDeclaration,
  StructField,
  StructFieldInit,
  StructLiteral,
  StructMethod,
  SwitchCase,
  SwitchStatement,
  SuperExpression,
  ThisExpression,
  ThrowStatement,
  TopLevelDeclaration,
  TryStatement,
  TupleType,
  TypeAliasDeclaration,
  TypeAnnotation,
  TypeofExpression,
  TypeofType,
  TypeParameter,
  UnaryExpression,
  UnionType,
  UpdateStatement,
  VariableDeclaration,
  Visibility,
  WhileStatement,
} from "../ast/nodes.js";
import type { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import { TokenKind, type Token } from "../lexer/tokens.js";

const PRIMITIVE_TYPES = new Set<string>([
  "i32",
  "i64",
  "f32",
  "f64",
  "bool",
  "string",
  "char",
  "void",
  "null",
]);

const ASSIGNMENT_OPS = new Set<TokenKind>([
  TokenKind.Equal,
  TokenKind.PlusEqual,
  TokenKind.MinusEqual,
]);

const UPDATE_OPS = new Set<TokenKind>([TokenKind.PlusPlus, TokenKind.MinusMinus]);

/**
 * Recursive-descent parser:
 *
 *   program      = importDecl* (functionDecl | structDecl | enumDecl | classDecl | interfaceDecl | typeAlias)*
 *   type         = unionType
 *   unionType    = intersectionType ("|" intersectionType)*
 *   intersection = conditionalType ("&" conditionalType)*
 *   conditional  = postfixType ("extends" type "?" type ":" type)?
 *   postfix      = primaryType ("[]" | "[" type "]")*
 *   primary      = primitive | named | object | literal | keyof | typeof | tupleType | "(" type ")"
 *   tupleType    = "[" (type ("," type)*)? "]"
 *   binding      = Identifier | "[" (Identifier | ",")* "]"
 */
export class Parser {
  private readonly tokens: Token[];
  private readonly diagnostics: DiagnosticCollector;
  private current = 0;

  constructor(tokens: Token[], diagnostics: DiagnosticCollector) {
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  parse(): Program {
    const start = this.peek().span.start;
    const body: TopLevelDeclaration[] = [];
    let sawNonImport = false;

    while (!this.check(TokenKind.Eof)) {
      if (this.check(TokenKind.Import)) {
        if (sawNonImport) {
          this.diagnostics.error(
            "Import declarations must appear before other top-level declarations",
            this.peek().span,
            "E0105",
          );
        }
        const decl = this.parseImportDeclaration();
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
        continue;
      }

      sawNonImport = true;
      const exported = this.match(TokenKind.Export);
      const isAbstract = this.match(TokenKind.Abstract);

      if (isAbstract && !this.check(TokenKind.Class)) {
        this.diagnostics.error(
          `Expected 'class' after 'abstract', found '${this.peek().lexeme}'`,
          this.peek().span,
          "E0103",
        );
        this.synchronizeToTopLevel();
        if (this.check(TokenKind.Eof)) {
          break;
        }
        continue;
      }

      if (this.check(TokenKind.Struct)) {
        if (isAbstract) {
          this.diagnostics.error(
            "'abstract' can only be used with classes",
            this.peek().span,
            "E0103",
          );
        }
        const decl = this.parseStructDeclaration(exported);
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
      } else if (this.check(TokenKind.Enum)) {
        if (isAbstract) {
          this.diagnostics.error(
            "'abstract' can only be used with classes",
            this.peek().span,
            "E0103",
          );
        }
        const decl = this.parseEnumDeclaration(exported);
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
      } else if (this.check(TokenKind.Interface)) {
        if (isAbstract) {
          this.diagnostics.error(
            "'abstract' can only be used with classes",
            this.peek().span,
            "E0103",
          );
        }
        const decl = this.parseInterfaceDeclaration(exported);
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
      } else if (this.check(TokenKind.Type)) {
        if (isAbstract) {
          this.diagnostics.error(
            "'abstract' can only be used with classes",
            this.peek().span,
            "E0103",
          );
        }
        const decl = this.parseTypeAliasDeclaration(exported);
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
      } else if (this.check(TokenKind.Class)) {
        const decl = this.parseClassDeclaration(exported, isAbstract);
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
      } else if (this.check(TokenKind.Function)) {
        if (isAbstract) {
          this.diagnostics.error(
            "'abstract' can only be used with classes",
            this.peek().span,
            "E0103",
          );
        }
        const fn = this.parseFunctionDeclaration(exported);
        if (fn) {
          body.push(fn);
        } else {
          break;
        }
      } else {
        if (exported || isAbstract) {
          this.diagnostics.error(
            `Expected 'function', 'struct', 'enum', 'class', 'interface', or 'type' after modifiers, found '${this.peek().lexeme}'`,
            this.peek().span,
            "E0103",
          );
        } else {
          this.diagnostics.error(
            `Expected 'function', 'struct', 'enum', 'class', 'interface', 'type', or 'import', found '${this.peek().lexeme}'`,
            this.peek().span,
            "E0103",
          );
        }
        this.synchronizeToTopLevel();
        if (this.check(TokenKind.Eof)) {
          break;
        }
      }
    }

    const eof = this.peek();
    return {
      kind: "Program",
      body,
      span: { start, end: eof.span.end },
    };
  }

  private parseImportDeclaration(): ImportDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Import, "Expected 'import'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const sourceToken = this.expect(TokenKind.String, "Expected a string module path after 'import'");
    if (!sourceToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const source: StringLiteral = {
      kind: "StringLiteral",
      value: sourceToken.value ?? "",
      raw: sourceToken.lexeme,
      span: sourceToken.span,
    };

    let alias: Identifier | null = null;
    if (this.check(TokenKind.As)) {
      this.advance();
      const aliasToken = this.expect(TokenKind.Identifier, "Expected identifier after 'as'");
      if (!aliasToken) {
        this.synchronizeToTopLevel();
        return null;
      }
      alias = {
        kind: "Identifier",
        name: aliasToken.lexeme,
        span: aliasToken.span,
      };
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after import");
    if (!semicolon) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "ImportDeclaration",
      source,
      alias,
      span: { start, end: semicolon.span.end },
    };
  }

  private parseStructDeclaration(exported: boolean): StructDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Struct, "Expected 'struct'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected struct name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.LBrace, "Expected '{' after struct name")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const fields: StructField[] = [];
    const methods: StructMethod[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      if (this.isStructMethodStart()) {
        const method = this.parseStructMethod();
        if (!method) {
          this.synchronizeToTopLevel();
          return null;
        }
        methods.push(method);
      } else {
        const field = this.parseStructField();
        if (!field) {
          this.synchronizeToTopLevel();
          return null;
        }
        fields.push(field);
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after struct body");
    if (!rbrace) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "StructDeclaration",
      exported,
      name,
      typeParams,
      fields,
      methods,
      span: { start, end: rbrace.span.end },
    };
  }

  /** Method: Ident "(" / Ident "<" ... vs field: Ident ":" */
  private isStructMethodStart(): boolean {
    return (
      this.check(TokenKind.Identifier) &&
      (this.checkNext(TokenKind.LParen) || this.checkNext(TokenKind.Less))
    );
  }

  private parseStructMethod(): StructMethod | null {
    const start = this.peek().span.start;
    const nameToken = this.expect(TokenKind.Identifier, "Expected method name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after method name")) {
      return null;
    }

    const params = this.parseParameterList();
    if (params === null) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after parameter list")) {
      return null;
    }

    if (!this.expect(TokenKind.Colon, "Expected ':' before return type")) {
      return null;
    }

    const returnType = this.parseType();
    if (!returnType) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "StructMethod",
      name,
      typeParams,
      params,
      returnType,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseStructField(): StructField | null {
    const start = this.peek().span.start;
    const nameToken = this.expect(TokenKind.Identifier, "Expected field name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.Colon, "Expected ':' after field name")) {
      return null;
    }

    const typeAnnotation = this.parseType();
    if (!typeAnnotation) {
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after field type");
    const end = semicolon?.span.end ?? typeAnnotation.span.end;

    return {
      kind: "StructField",
      name,
      typeAnnotation,
      span: { start, end },
    };
  }

  private parseClassDeclaration(
    exported: boolean,
    isAbstract: boolean,
  ): ClassDeclaration | null {
    const start = isAbstract
      ? this.tokens[Math.max(0, this.current - 1)]!.span.start
      : this.peek().span.start;

    if (!this.expect(TokenKind.Class, "Expected 'class'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected class name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      this.synchronizeToTopLevel();
      return null;
    }

    let superclass: NamedType | null = null;
    if (this.match(TokenKind.Extends)) {
      const superType = this.parseType();
      if (!superType) {
        this.synchronizeToTopLevel();
        return null;
      }
      if (superType.kind !== "NamedType") {
        this.diagnostics.error(
          "Superclass must be a named class type",
          superType.span,
          "E0103",
        );
        this.synchronizeToTopLevel();
        return null;
      }
      superclass = superType;
    }

    const implementsTypes: NamedType[] = [];
    if (this.match(TokenKind.Implements)) {
      do {
        const ifaceType = this.parseType();
        if (!ifaceType) {
          this.synchronizeToTopLevel();
          return null;
        }
        if (ifaceType.kind !== "NamedType") {
          this.diagnostics.error(
            "Implemented type must be a named interface type",
            ifaceType.span,
            "E0103",
          );
          this.synchronizeToTopLevel();
          return null;
        }
        implementsTypes.push(ifaceType);
      } while (this.match(TokenKind.Comma));
    }

    if (!this.expect(TokenKind.LBrace, "Expected '{' after class header")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const members: ClassMember[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const member = this.parseClassMember();
      if (!member) {
        this.synchronizeToTopLevel();
        return null;
      }
      members.push(member);
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after class body");
    if (!rbrace) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "ClassDeclaration",
      exported,
      isAbstract,
      name,
      typeParams,
      superclass,
      implementsTypes,
      members,
      span: { start, end: rbrace.span.end },
    };
  }

  private parseInterfaceDeclaration(exported: boolean): InterfaceDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Interface, "Expected 'interface'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected interface name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      this.synchronizeToTopLevel();
      return null;
    }

    const bases: NamedType[] = [];
    if (this.match(TokenKind.Extends)) {
      do {
        const baseType = this.parseType();
        if (!baseType) {
          this.synchronizeToTopLevel();
          return null;
        }
        if (baseType.kind !== "NamedType") {
          this.diagnostics.error(
            "Extended type must be a named interface type",
            baseType.span,
            "E0103",
          );
          this.synchronizeToTopLevel();
          return null;
        }
        bases.push(baseType);
      } while (this.match(TokenKind.Comma));
    }

    if (!this.expect(TokenKind.LBrace, "Expected '{' after interface header")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const methods: InterfaceMethodSignature[] = [];
    let indexSignature: InterfaceIndexSignature | null = null;
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      if (this.check(TokenKind.LBracket)) {
        const idx = this.parseInterfaceIndexSignature();
        if (!idx) {
          this.synchronizeToTopLevel();
          return null;
        }
        if (indexSignature) {
          this.diagnostics.error(
            "Interfaces may only declare one index signature",
            idx.span,
            "E0371",
          );
        } else {
          indexSignature = idx;
        }
        continue;
      }
      const method = this.parseInterfaceMethod();
      if (method === "skipped") {
        continue;
      }
      if (!method) {
        this.synchronizeToTopLevel();
        return null;
      }
      methods.push(method);
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after interface body");
    if (!rbrace) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "InterfaceDeclaration",
      exported,
      name,
      typeParams,
      bases,
      methods,
      indexSignature,
      span: { start, end: rbrace.span.end },
    };
  }

  private parseInterfaceIndexSignature(): InterfaceIndexSignature | null {
    const start = this.peek().span.start;
    if (!this.expect(TokenKind.LBracket, "Expected '['")) {
      return null;
    }
    const keyToken = this.expect(TokenKind.Identifier, "Expected index parameter name");
    if (!keyToken) {
      return null;
    }
    if (!this.expect(TokenKind.Colon, "Expected ':' after index parameter name")) {
      return null;
    }
    const keyType = this.parseType();
    if (!keyType) {
      return null;
    }
    if (!this.expect(TokenKind.RBracket, "Expected ']' after index signature key type")) {
      return null;
    }
    if (!this.expect(TokenKind.Colon, "Expected ':' after index signature")) {
      return null;
    }
    const valueType = this.parseType();
    if (!valueType) {
      return null;
    }
    const semi = this.expect(TokenKind.Semicolon, "Expected ';' after index signature");
    if (!semi) {
      return null;
    }
    return {
      kind: "InterfaceIndexSignature",
      keyName: { kind: "Identifier", name: keyToken.lexeme, span: keyToken.span },
      keyType,
      valueType,
      span: { start, end: semi.span.end },
    };
  }

  private parseTypeAliasDeclaration(exported: boolean): TypeAliasDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Type, "Expected 'type'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected type alias name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.Equal, "Expected '=' after type alias name")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const type = this.parseType();
    if (!type) {
      this.synchronizeToTopLevel();
      return null;
    }

    const semi = this.expect(TokenKind.Semicolon, "Expected ';' after type alias");
    if (!semi) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "TypeAliasDeclaration",
      exported,
      name,
      typeParams,
      type,
      span: { start, end: semi.span.end },
    };
  }

  /** Returns a signature, null on hard failure, or "skipped" after recovering from a field member. */
  private parseInterfaceMethod(): InterfaceMethodSignature | null | "skipped" {
    const start = this.peek().span.start;
    const nameToken = this.expect(TokenKind.Identifier, "Expected method name");
    if (!nameToken) {
      return null;
    }

    // Field-shaped members are not allowed in interfaces.
    if (this.check(TokenKind.Colon)) {
      this.diagnostics.error(
        "Interfaces may only declare methods, not fields",
        nameToken.span,
        "E0370",
      );
      this.advance(); // colon
      while (
        !this.check(TokenKind.Semicolon) &&
        !this.check(TokenKind.RBrace) &&
        !this.isAtEnd()
      ) {
        this.advance();
      }
      this.match(TokenKind.Semicolon);
      return "skipped";
    }

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after method name")) {
      return null;
    }

    const params = this.parseParameterList();
    if (params === null) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after parameters")) {
      return null;
    }

    if (!this.expect(TokenKind.Colon, "Expected ':' before return type")) {
      return null;
    }

    const returnType = this.parseType();
    if (!returnType) {
      return null;
    }

    const semi = this.expect(TokenKind.Semicolon, "Expected ';' after interface method");
    if (!semi) {
      return null;
    }

    return {
      kind: "InterfaceMethodSignature",
      name: { kind: "Identifier", name: nameToken.lexeme, span: nameToken.span },
      typeParams,
      params,
      returnType,
      span: { start, end: semi.span.end },
    };
  }

  private parseClassMember(): ClassMember | null {
    const start = this.peek().span.start;
    let visibility: Visibility = "public";
    if (this.match(TokenKind.Public)) {
      visibility = "public";
    } else if (this.match(TokenKind.Private)) {
      visibility = "private";
    }

    const isAbstract = this.match(TokenKind.Abstract);
    const isStatic = this.match(TokenKind.Static);
    const isReadonly = this.match(TokenKind.Readonly);

    if (this.check(TokenKind.Constructor)) {
      if (isAbstract || isStatic || isReadonly) {
        this.diagnostics.error(
          "Constructor cannot be abstract, static, or readonly",
          this.peek().span,
          "E0103",
        );
      }
      return this.parseConstructor(visibility, start);
    }

    // Method: name( or abstract name(
    // Field: name:
    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.error(
        `Expected class member, found '${this.peek().lexeme}'`,
        this.peek().span,
        "E0103",
      );
      return null;
    }

    if (this.checkNext(TokenKind.LParen) || this.checkNext(TokenKind.Less)) {
      return this.parseClassMethod(visibility, isStatic, isAbstract, isReadonly, start);
    }

    if (isAbstract) {
      this.diagnostics.error("Fields cannot be abstract", this.peek().span, "E0103");
    }
    return this.parseClassField(visibility, isStatic, isReadonly, start);
  }

  private parseConstructor(
    visibility: Visibility,
    start: { line: number; column: number; offset: number },
  ): ConstructorDeclaration | null {
    if (!this.expect(TokenKind.Constructor, "Expected 'constructor'")) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'constructor'")) {
      return null;
    }

    const params = this.parseParameterList();
    if (params === null) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after parameter list")) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "ConstructorDeclaration",
      visibility,
      params,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseClassMethod(
    visibility: Visibility,
    isStatic: boolean,
    isAbstract: boolean,
    isReadonly: boolean,
    start: { line: number; column: number; offset: number },
  ): ClassMethod | null {
    if (isReadonly) {
      this.diagnostics.error("Methods cannot be readonly", this.peek().span, "E0103");
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected method name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after method name")) {
      return null;
    }

    const params = this.parseParameterList();
    if (params === null) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after parameter list")) {
      return null;
    }

    if (!this.expect(TokenKind.Colon, "Expected ':' before return type")) {
      return null;
    }

    const returnType = this.parseType();
    if (!returnType) {
      return null;
    }

    if (isAbstract) {
      const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after abstract method");
      const end = semicolon?.span.end ?? returnType.span.end;
      return {
        kind: "ClassMethod",
        visibility,
        isStatic,
        isAbstract: true,
        name,
        typeParams,
        params,
        returnType,
        body: null,
        span: { start, end },
      };
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "ClassMethod",
      visibility,
      isStatic,
      isAbstract: false,
      name,
      typeParams,
      params,
      returnType,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseClassField(
    visibility: Visibility,
    isStatic: boolean,
    isReadonly: boolean,
    start: { line: number; column: number; offset: number },
  ): ClassField | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected field name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.Colon, "Expected ':' after field name")) {
      return null;
    }

    const typeAnnotation = this.parseType();
    if (!typeAnnotation) {
      return null;
    }

    let initializer: Expression | null = null;
    if (this.match(TokenKind.Equal)) {
      initializer = this.parseExpression();
      if (!initializer) {
        return null;
      }
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after field");
    const end =
      semicolon?.span.end ?? initializer?.span.end ?? typeAnnotation.span.end;

    return {
      kind: "ClassField",
      visibility,
      isStatic,
      isReadonly,
      name,
      typeAnnotation,
      initializer,
      span: { start, end },
    };
  }

  private parseEnumDeclaration(exported: boolean): EnumDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Enum, "Expected 'enum'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected enum name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.LBrace, "Expected '{' after enum name")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const variants: EnumVariant[] = [];
    if (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const first = this.parseEnumVariant();
      if (!first) {
        this.synchronizeToTopLevel();
        return null;
      }
      variants.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        if (this.check(TokenKind.RBrace)) {
          break;
        }
        const variant = this.parseEnumVariant();
        if (!variant) {
          this.synchronizeToTopLevel();
          return null;
        }
        variants.push(variant);
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after enum variants");
    if (!rbrace) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "EnumDeclaration",
      exported,
      name,
      variants,
      span: { start, end: rbrace.span.end },
    };
  }

  private parseEnumVariant(): EnumVariant | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected enum variant name");
    if (!nameToken) {
      return null;
    }

    return {
      kind: "EnumVariant",
      name: {
        kind: "Identifier",
        name: nameToken.lexeme,
        span: nameToken.span,
      },
      span: nameToken.span,
    };
  }

  private parseFunctionDeclaration(exported: boolean): FunctionDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Function, "Expected 'function'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected function name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const typeParams = this.parseTypeParameterList();
    if (typeParams === null) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after function name")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const params = this.parseParameterList();
    if (params === null) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after parameter list")) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.Colon, "Expected ':' before return type")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const returnType = this.parseType();
    if (!returnType) {
      this.synchronizeToTopLevel();
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "FunctionDeclaration",
      exported,
      name,
      typeParams,
      params,
      returnType,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseParameterList(): Parameter[] | null {
    const params: Parameter[] = [];

    if (this.check(TokenKind.RParen)) {
      return params;
    }

    const first = this.parseParameter();
    if (!first) {
      return null;
    }
    params.push(first);

    while (this.check(TokenKind.Comma)) {
      this.advance();
      const param = this.parseParameter();
      if (!param) {
        return null;
      }
      params.push(param);
    }

    let sawDefault = false;
    for (const param of params) {
      if (param.defaultValue !== null) {
        sawDefault = true;
      } else if (sawDefault) {
        this.diagnostics.error(
          "Required parameters must come before parameters with default values",
          param.span,
          "E0102",
        );
        return null;
      }
    }

    return params;
  }

  private parseParameter(): Parameter | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected parameter name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.Colon, "Expected ':' after parameter name")) {
      return null;
    }

    const typeAnnotation = this.parseType();
    if (!typeAnnotation) {
      return null;
    }

    let defaultValue: Expression | null = null;
    if (this.match(TokenKind.Equal)) {
      defaultValue = this.parseExpression();
      if (!defaultValue) {
        return null;
      }
    }

    return {
      kind: "Parameter",
      name,
      typeAnnotation,
      defaultValue,
      span: {
        start: name.span.start,
        end: defaultValue?.span.end ?? typeAnnotation.span.end,
      },
    };
  }

  private parseStatement(): Statement | null {
    if (this.check(TokenKind.Let) || this.check(TokenKind.Const)) {
      return this.parseVariableDeclaration();
    }

    if (this.check(TokenKind.Return)) {
      return this.parseReturnStatement();
    }

    if (this.check(TokenKind.If)) {
      return this.parseIfStatement();
    }

    if (this.check(TokenKind.While)) {
      return this.parseWhileStatement();
    }

    if (this.check(TokenKind.For)) {
      return this.parseForStatement();
    }

    if (this.check(TokenKind.Switch)) {
      return this.parseSwitchStatement();
    }

    if (this.check(TokenKind.Break)) {
      return this.parseBreakStatement();
    }

    if (this.check(TokenKind.Continue)) {
      return this.parseContinueStatement();
    }

    if (this.check(TokenKind.Throw)) {
      return this.parseThrowStatement();
    }

    if (this.check(TokenKind.Try)) {
      return this.parseTryStatement();
    }

    if (this.check(TokenKind.Identifier)) {
      const next = this.tokens[this.current + 1];
      if (next && UPDATE_OPS.has(next.kind)) {
        return this.parseUpdateStatement(true);
      }
      if (next && ASSIGNMENT_OPS.has(next.kind)) {
        return this.parseAssignment(true);
      }
      // numbers[0] = ...
      if (next?.kind === TokenKind.LBracket) {
        return this.parseIndexAssignment(true);
      }
      // person.age = ... / a.b.c = ...
      if (next?.kind === TokenKind.Dot && this.looksLikeMemberAssignment()) {
        return this.parseMemberAssignment(true);
      }
    }

    // this.field = ...
    if (this.check(TokenKind.This) && this.checkNext(TokenKind.Dot) && this.looksLikeMemberAssignment()) {
      return this.parseMemberAssignment(true);
    }

    return this.parseExpressionStatement();
  }

  private parseBlock(): { statements: Statement[]; end: { line: number; column: number; offset: number } } | null {
    if (!this.expect(TokenKind.LBrace, "Expected '{'")) {
      return null;
    }

    const statements: Statement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      } else {
        this.synchronizeStatement();
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}'");
    const end = rbrace?.span.end ?? this.peek().span.end;
    return { statements, end };
  }

  private parseIfStatement(): IfStatement | null {
    const start = this.peek().span.start;
    this.advance(); // if

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'if'")) {
      return null;
    }

    const condition = this.parseExpression();
    if (!condition) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after if condition")) {
      return null;
    }

    const consequentBlock = this.parseBlock();
    if (!consequentBlock) {
      return null;
    }

    let alternate: IfStatement | Statement[] | null = null;
    let end = consequentBlock.end;

    if (this.check(TokenKind.ElseIf)) {
      const elseif = this.parseElseIfChain();
      if (!elseif) {
        return null;
      }
      alternate = elseif;
      end = elseif.span.end;
    } else if (this.check(TokenKind.Else)) {
      this.advance();
      const elseBlock = this.parseBlock();
      if (!elseBlock) {
        return null;
      }
      alternate = elseBlock.statements;
      end = elseBlock.end;
    }

    return {
      kind: "IfStatement",
      condition,
      consequent: consequentBlock.statements,
      alternate,
      span: { start, end },
    };
  }

  private parseWhileStatement(): WhileStatement | null {
    const start = this.peek().span.start;
    this.advance(); // while

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'while'")) {
      return null;
    }

    const condition = this.parseExpression();
    if (!condition) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after while condition")) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "WhileStatement",
      condition,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseForStatement(): ForStatement | ForInStatement | null {
    const start = this.peek().span.start;
    this.advance(); // for

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'for'")) {
      return null;
    }

    // for (i in ...) | for (let i in ...) | for (const i in ...)
    if (this.isForInStart()) {
      return this.parseForInRemainder(start);
    }

    const initializer = this.parseForInitializer();
    if (initializer === undefined) {
      return null;
    }

    let condition: Expression | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      condition = this.parseExpression();
      if (!condition) {
        return null;
      }
    }
    if (!this.expect(TokenKind.Semicolon, "Expected ';' after for condition")) {
      return null;
    }

    let update: UpdateStatement | AssignmentStatement | null = null;
    if (!this.check(TokenKind.RParen)) {
      update = this.parseForUpdate();
      if (!update) {
        return null;
      }
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after for clauses")) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "ForStatement",
      initializer,
      condition,
      update,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private isForInStart(): boolean {
    if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.In)) {
      return true;
    }
    if (
      (this.check(TokenKind.Let) || this.check(TokenKind.Const)) &&
      this.tokens[this.current + 1]?.kind === TokenKind.Identifier &&
      this.tokens[this.current + 2]?.kind === TokenKind.In
    ) {
      return true;
    }
    return false;
  }

  private parseForInRemainder(start: { line: number; column: number; offset: number }): ForInStatement | null {
    let mutability: "let" | "const" | null = null;
    if (this.check(TokenKind.Let) || this.check(TokenKind.Const)) {
      const token = this.advance();
      mutability = token.kind === TokenKind.Const ? "const" : "let";
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected loop variable name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.In, "Expected 'in' in for-in loop")) {
      return null;
    }

    const iterable = this.parseExpression();
    if (!iterable) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after for-in clause")) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "ForInStatement",
      mutability,
      name,
      iterable,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  /** Returns null for empty init, undefined on parse failure. */
  private parseForInitializer(): VariableDeclaration | AssignmentStatement | null | undefined {
    if (this.check(TokenKind.Semicolon)) {
      this.advance();
      return null;
    }

    if (this.check(TokenKind.Let) || this.check(TokenKind.Const)) {
      return this.parseVariableDeclaration();
    }

    if (this.check(TokenKind.Identifier)) {
      const next = this.tokens[this.current + 1];
      if (next && ASSIGNMENT_OPS.has(next.kind)) {
        return this.parseAssignment(true);
      }
      if (next?.kind === TokenKind.LBracket) {
        return this.parseIndexAssignment(true);
      }
      if (next?.kind === TokenKind.Dot && this.looksLikeMemberAssignment()) {
        return this.parseMemberAssignment(true);
      }
    }

    this.diagnostics.error("Expected for-loop initializer", this.peek().span, "E0102");
    return undefined;
  }

  private parseForUpdate(): UpdateStatement | AssignmentStatement | null {
    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.error("Expected for-loop update", this.peek().span, "E0102");
      return null;
    }

    const next = this.tokens[this.current + 1];
    if (next && UPDATE_OPS.has(next.kind)) {
      return this.parseUpdateStatement(false);
    }
    if (next && ASSIGNMENT_OPS.has(next.kind)) {
      return this.parseAssignment(false);
    }
    if (next?.kind === TokenKind.LBracket) {
      return this.parseIndexAssignment(false);
    }
    if (next?.kind === TokenKind.Dot && this.looksLikeMemberAssignment()) {
      return this.parseMemberAssignment(false);
    }

    this.diagnostics.error("Expected for-loop update", this.peek().span, "E0102");
    return null;
  }

  private parseBreakStatement(): BreakStatement | null {
    const start = this.peek().span.start;
    this.advance(); // break
    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after 'break'");
    const end = semicolon?.span.end ?? this.peek().span.end;
    return {
      kind: "BreakStatement",
      span: { start, end },
    };
  }

  private parseContinueStatement(): ContinueStatement | null {
    const start = this.peek().span.start;
    this.advance(); // continue
    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after 'continue'");
    const end = semicolon?.span.end ?? this.peek().span.end;
    return {
      kind: "ContinueStatement",
      span: { start, end },
    };
  }

  private parseThrowStatement(): ThrowStatement | null {
    const start = this.peek().span.start;
    this.advance(); // throw
    const expression = this.parseExpression();
    if (!expression) {
      return null;
    }
    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after throw expression");
    const end = semicolon?.span.end ?? expression.span.end;
    return {
      kind: "ThrowStatement",
      expression,
      span: { start, end },
    };
  }

  private parseTryStatement(): TryStatement | null {
    const start = this.peek().span.start;
    this.advance(); // try

    const tryBlockResult = this.parseBlock();
    if (!tryBlockResult) {
      return null;
    }

    let catchClause: CatchClause | null = null;
    if (this.check(TokenKind.Catch)) {
      const catchStart = this.peek().span.start;
      this.advance(); // catch
      if (!this.expect(TokenKind.LParen, "Expected '(' after 'catch'")) {
        return null;
      }
      const paramToken = this.expect(TokenKind.Identifier, "Expected catch parameter name");
      if (!paramToken) {
        return null;
      }
      const parameter: Identifier = {
        kind: "Identifier",
        name: paramToken.lexeme,
        span: paramToken.span,
      };
      if (this.check(TokenKind.Colon)) {
        this.diagnostics.error(
          "Catch clause must not have a type annotation",
          this.peek().span,
          "E0383",
        );
        this.synchronizeStatement();
        return null;
      }
      if (!this.expect(TokenKind.RParen, "Expected ')' after catch parameter")) {
        return null;
      }
      const catchBody = this.parseBlock();
      if (!catchBody) {
        return null;
      }
      const catchEnd =
        catchBody.statements.length > 0
          ? catchBody.statements[catchBody.statements.length - 1]!.span.end
          : catchBody.end;
      catchClause = {
        kind: "CatchClause",
        parameter,
        body: catchBody.statements,
        span: { start: catchStart, end: catchEnd },
      };
    }

    let finallyBlock: Statement[] | null = null;
    if (this.check(TokenKind.Finally)) {
      this.advance(); // finally
      const finallyResult = this.parseBlock();
      if (!finallyResult) {
        return null;
      }
      finallyBlock = finallyResult.statements;
    }

    if (!catchClause && !finallyBlock) {
      this.diagnostics.error(
        "try must have catch and/or finally",
        { start, end: tryBlockResult.end },
        "E0381",
      );
      return null;
    }

    const end =
      finallyBlock && finallyBlock.length > 0
        ? finallyBlock[finallyBlock.length - 1]!.span.end
        : catchClause
          ? catchClause.span.end
          : tryBlockResult.end;

    return {
      kind: "TryStatement",
      tryBlock: tryBlockResult.statements,
      catchClause,
      finallyBlock,
      span: { start, end },
    };
  }

  private parseSwitchStatement(): SwitchStatement | null {
    const start = this.peek().span.start;
    this.advance(); // switch

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'switch'")) {
      return null;
    }

    const discriminant = this.parseExpression();
    if (!discriminant) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after switch expression")) {
      return null;
    }

    if (!this.expect(TokenKind.LBrace, "Expected '{' after switch")) {
      return null;
    }

    const cases: SwitchCase[] = [];
    let hasDefault = false;

    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      if (this.check(TokenKind.Case)) {
        const caseStart = this.peek().span.start;
        this.advance(); // case
        const test = this.parseExpression();
        if (!test) {
          return null;
        }
        if (!this.expect(TokenKind.Colon, "Expected ':' after case expression")) {
          return null;
        }
        const body = this.parseSwitchCaseBody();
        const caseEnd =
          body.length > 0 ? body[body.length - 1]!.span.end : this.peek().span.start;
        cases.push({
          kind: "SwitchCase",
          isDefault: false,
          test,
          body,
          span: { start: caseStart, end: caseEnd },
        });
      } else if (this.check(TokenKind.Default)) {
        const defaultStart = this.peek().span.start;
        if (hasDefault) {
          this.diagnostics.error("Duplicate default case", this.peek().span, "E0337");
          return null;
        }
        hasDefault = true;
        this.advance(); // default
        if (!this.expect(TokenKind.Colon, "Expected ':' after 'default'")) {
          return null;
        }
        const body = this.parseSwitchCaseBody();
        const caseEnd =
          body.length > 0 ? body[body.length - 1]!.span.end : this.peek().span.start;
        cases.push({
          kind: "SwitchCase",
          isDefault: true,
          test: null,
          body,
          span: { start: defaultStart, end: caseEnd },
        });
      } else {
        this.diagnostics.error(
          "Expected 'case' or 'default' in switch body",
          this.peek().span,
          "E0102",
        );
        this.synchronizeStatement();
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after switch body");
    const end = rbrace?.span.end ?? this.peek().span.end;

    return {
      kind: "SwitchStatement",
      discriminant,
      cases,
      span: { start, end },
    };
  }

  private parseSwitchCaseBody(): Statement[] {
    const statements: Statement[] = [];
    while (
      !this.check(TokenKind.Case) &&
      !this.check(TokenKind.Default) &&
      !this.check(TokenKind.RBrace) &&
      !this.isAtEnd()
    ) {
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      } else {
        this.synchronizeStatement();
      }
    }
    return statements;
  }

  /** Parse `elseif (cond) { ... }` as an IfStatement, chaining further elseif/else. */
  private parseElseIfChain(): IfStatement | null {
    const start = this.peek().span.start;
    this.advance(); // elseif

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'elseif'")) {
      return null;
    }

    const condition = this.parseExpression();
    if (!condition) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after elseif condition")) {
      return null;
    }

    const consequentBlock = this.parseBlock();
    if (!consequentBlock) {
      return null;
    }

    let alternate: IfStatement | Statement[] | null = null;
    let end = consequentBlock.end;

    if (this.check(TokenKind.ElseIf)) {
      const nested = this.parseElseIfChain();
      if (!nested) {
        return null;
      }
      alternate = nested;
      end = nested.span.end;
    } else if (this.check(TokenKind.Else)) {
      this.advance();
      const elseBlock = this.parseBlock();
      if (!elseBlock) {
        return null;
      }
      alternate = elseBlock.statements;
      end = elseBlock.end;
    }

    return {
      kind: "IfStatement",
      condition,
      consequent: consequentBlock.statements,
      alternate,
      span: { start, end },
    };
  }

  private parseVariableDeclaration(): VariableDeclaration | null {
    const start = this.peek().span.start;
    const mutabilityToken = this.advance();
    const mutability = mutabilityToken.kind === TokenKind.Const ? "const" : "let";

    let binding: BindingPattern | null = null;
    if (this.check(TokenKind.LBracket)) {
      binding = this.parseArrayBindingPattern();
      if (!binding) {
        return null;
      }
    } else {
      const nameToken = this.expect(TokenKind.Identifier, "Expected variable name");
      if (!nameToken) {
        return null;
      }
      binding = {
        kind: "Identifier",
        name: nameToken.lexeme,
        span: nameToken.span,
      };
    }

    let typeAnnotation: TypeAnnotation | null = null;
    if (this.check(TokenKind.Colon)) {
      this.advance();
      typeAnnotation = this.parseType();
      if (!typeAnnotation) {
        return null;
      }
    }

    let initializer: Expression | null = null;
    if (this.check(TokenKind.Equal)) {
      this.advance();
      initializer = this.parseExpression();
      if (!initializer) {
        return null;
      }
    } else if (binding.kind === "ArrayBindingPattern") {
      this.diagnostics.error(
        "Destructuring declarations must have an initializer",
        binding.span,
        "E0102",
      );
      return null;
    } else if (mutability === "const") {
      this.diagnostics.error(
        "const declarations must have an initializer",
        binding.span,
        "E0102",
      );
      return null;
    } else if (!typeAnnotation) {
      this.diagnostics.error(
        "Expected '=' after variable name",
        this.peek().span,
        "E0102",
      );
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after variable declaration");
    const end =
      semicolon?.span.end ??
      initializer?.span.end ??
      typeAnnotation?.span.end ??
      binding.span.end;

    return {
      kind: "VariableDeclaration",
      mutability,
      binding,
      typeAnnotation,
      initializer,
      span: { start, end },
    };
  }

  private parseArrayBindingPattern(): ArrayBindingPattern | null {
    const start = this.peek().span.start;
    this.advance(); // [

    const elements: ArrayBindingElement[] = [];
    if (!this.check(TokenKind.RBracket)) {
      for (;;) {
        if (this.check(TokenKind.Comma)) {
          const comma = this.advance();
          elements.push({
            kind: "ArrayBindingElement",
            name: null,
            span: comma.span,
          });
          if (this.check(TokenKind.RBracket)) {
            break;
          }
          continue;
        }

        const nameToken = this.expect(TokenKind.Identifier, "Expected binding name");
        if (!nameToken) {
          return null;
        }
        const name: Identifier = {
          kind: "Identifier",
          name: nameToken.lexeme,
          span: nameToken.span,
        };
        elements.push({
          kind: "ArrayBindingElement",
          name,
          span: name.span,
        });

        if (this.check(TokenKind.Comma)) {
          this.advance();
          if (this.check(TokenKind.RBracket)) {
            break; // trailing comma
          }
          continue;
        }
        break;
      }
    }

    const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after binding pattern");
    if (!rbracket) {
      return null;
    }

    return {
      kind: "ArrayBindingPattern",
      elements,
      span: { start, end: rbracket.span.end },
    };
  }

  private parseAssignment(requireSemicolon: boolean): AssignmentStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    const target: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    return this.finishAssignment(start, target, requireSemicolon);
  }

  private parseIndexAssignment(requireSemicolon: boolean): AssignmentStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    const object: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.LBracket, "Expected '['")) {
      return null;
    }

    const index = this.parseExpression();
    if (!index) {
      return null;
    }

    const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after index");
    if (!rbracket) {
      return null;
    }

    const target: IndexExpression = {
      kind: "IndexExpression",
      object,
      index,
      optional: false,
      span: { start: object.span.start, end: rbracket.span.end },
    };

    return this.finishAssignment(start, target, requireSemicolon);
  }

  /**
   * Peek ahead from current Ident to see if this is `a.b =` / `a.b.c +=` (not a method call).
   */
  private looksLikeMemberAssignment(): boolean {
    let i = this.current + 1;
    while (i < this.tokens.length) {
      const tok = this.tokens[i];
      if (!tok) {
        return false;
      }
      if (tok.kind === TokenKind.Dot) {
        const prop = this.tokens[i + 1];
        if (!prop || prop.kind !== TokenKind.Identifier) {
          return false;
        }
        i += 2;
        continue;
      }
      return ASSIGNMENT_OPS.has(tok.kind);
    }
    return false;
  }

  private parseMemberAssignment(requireSemicolon: boolean): AssignmentStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    let object: Expression =
      nameToken.kind === TokenKind.This
        ? { kind: "ThisExpression", span: nameToken.span }
        : {
            kind: "Identifier",
            name: nameToken.lexeme,
            span: nameToken.span,
          };

    let target: MemberExpression | null = null;
    while (this.check(TokenKind.Dot)) {
      this.advance();
      const propToken = this.expect(TokenKind.Identifier, "Expected property name after '.'");
      if (!propToken) {
        return null;
      }
      const property: Identifier = {
        kind: "Identifier",
        name: propToken.lexeme,
        span: propToken.span,
      };
      target = {
        kind: "MemberExpression",
        object,
        property,
        optional: false,
        span: { start: object.span.start, end: property.span.end },
      };
      object = target;
    }

    if (!target) {
      this.diagnostics.error("Expected member access in assignment", this.peek().span, "E0103");
      return null;
    }

    return this.finishAssignment(start, target, requireSemicolon);
  }

  private finishAssignment(
    start: { line: number; column: number; offset: number },
    target: Assignable,
    requireSemicolon: boolean,
  ): AssignmentStatement | null {
    const opToken = this.advance();
    let operator: "=" | "+=" | "-=";
    if (opToken.kind === TokenKind.Equal) {
      operator = "=";
    } else if (opToken.kind === TokenKind.PlusEqual) {
      operator = "+=";
    } else if (opToken.kind === TokenKind.MinusEqual) {
      operator = "-=";
    } else {
      this.diagnostics.error("Expected '=', '+=', or '-=' in assignment", opToken.span, "E0103");
      return null;
    }

    const value = this.parseExpression();
    if (!value) {
      return null;
    }

    let end = value.span.end;
    if (requireSemicolon) {
      const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after assignment");
      end = semicolon?.span.end ?? value.span.end;
    }

    return {
      kind: "AssignmentStatement",
      target,
      operator,
      value,
      span: { start, end },
    };
  }

  private parseUpdateStatement(requireSemicolon: boolean): UpdateStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const opToken = this.advance();
    let operator: "++" | "--";
    if (opToken.kind === TokenKind.PlusPlus) {
      operator = "++";
    } else if (opToken.kind === TokenKind.MinusMinus) {
      operator = "--";
    } else {
      this.diagnostics.error("Expected '++' or '--'", opToken.span, "E0103");
      return null;
    }

    let end = opToken.span.end;
    if (requireSemicolon) {
      const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after update");
      end = semicolon?.span.end ?? opToken.span.end;
    }

    return {
      kind: "UpdateStatement",
      name,
      operator,
      span: { start, end },
    };
  }

  private parseReturnStatement(): ReturnStatement | null {
    const start = this.peek().span.start;
    this.advance(); // return

    let value: Expression | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      value = this.parseExpression();
      if (!value) {
        return null;
      }
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after return");
    const end = semicolon?.span.end ?? value?.span.end ?? this.peek().span.end;

    return {
      kind: "ReturnStatement",
      value,
      span: { start, end },
    };
  }

  private parseExpressionStatement(): ExpressionStatement | null {
    const start = this.peek().span.start;

    // Method call: Ident . Ident ( ... ) or Ident [ ... ] . Ident ( ... )
    // Function call: Ident ( or Ident <TypeArgs>(
    if (
      this.check(TokenKind.Identifier) &&
      (this.checkNext(TokenKind.LParen) || this.looksLikeGenericCall())
    ) {
      const expression = this.parseCallExpression();
      if (!expression) {
        return null;
      }
      const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after expression");
      const end = semicolon?.span.end ?? expression.span.end;
      return {
        kind: "ExpressionStatement",
        expression,
        span: { start, end },
      };
    }

    // Parse a primary with postfix; must end as a CallExpression
    const expression = this.parsePrimary();
    if (!expression) {
      return null;
    }

    if (expression.kind !== "CallExpression") {
      this.diagnostics.error(
        "Expected a call statement",
        expression.span,
        "E0102",
      );
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after expression");
    const end = semicolon?.span.end ?? expression.span.end;

    return {
      kind: "ExpressionStatement",
      expression,
      span: { start, end },
    };
  }

  private parseExpression(): Expression | null {
    return this.parseOr();
  }

  private parseOr(): Expression | null {
    let left = this.parseNullishCoalesce();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.PipePipe)) {
      const opToken = this.advance();
      const right = this.parseNullishCoalesce();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseNullishCoalesce(): Expression | null {
    let left = this.parseAnd();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.QuestionQuestion)) {
      this.advance();
      const right = this.parseAnd();
      if (!right) {
        return null;
      }
      const coalesce: NullCoalescingExpression = {
        kind: "NullCoalescingExpression",
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = coalesce;
    }

    return left;
  }

  private parseAnd(): Expression | null {
    let left = this.parseEquality();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.AmpAmp)) {
      const opToken = this.advance();
      const right = this.parseEquality();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseEquality(): Expression | null {
    let left = this.parseRelational();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.EqualEqual) || this.check(TokenKind.BangEqual)) {
      const opToken = this.advance();
      const right = this.parseRelational();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseRelational(): Expression | null {
    let left = this.parseAdditive();
    if (!left) {
      return null;
    }

    while (
      this.check(TokenKind.Less) ||
      this.check(TokenKind.LessEqual) ||
      this.check(TokenKind.Greater) ||
      this.check(TokenKind.GreaterEqual)
    ) {
      const opToken = this.advance();
      const right = this.parseAdditive();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    // `value is Type` — same precedence band as relational comparisons
    while (this.check(TokenKind.Is)) {
      this.advance();
      const typeAnnotation = this.parseType();
      if (!typeAnnotation) {
        return null;
      }
      const isExpr: IsExpression = {
        kind: "IsExpression",
        value: left,
        typeAnnotation,
        span: { start: left.span.start, end: typeAnnotation.span.end },
      };
      left = isExpr;
    }

    return left;
  }

  private parseAdditive(): Expression | null {
    let left = this.parseMultiplicative();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.Plus) || this.check(TokenKind.Minus)) {
      const opToken = this.advance();
      const operator = opToken.lexeme as BinaryOperator;
      const right = this.parseMultiplicative();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseMultiplicative(): Expression | null {
    let left = this.parseUnary();
    if (!left) {
      return null;
    }

    while (
      this.check(TokenKind.Star) ||
      this.check(TokenKind.Slash) ||
      this.check(TokenKind.Percent)
    ) {
      const opToken = this.advance();
      const operator = opToken.lexeme as BinaryOperator;
      const right = this.parseUnary();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseUnary(): Expression | null {
    if (this.check(TokenKind.Typeof)) {
      const opToken = this.advance();
      const operand = this.parseUnary();
      if (!operand) {
        return null;
      }
      const typeofExpr: TypeofExpression = {
        kind: "TypeofExpression",
        operand,
        span: { start: opToken.span.start, end: operand.span.end },
      };
      return typeofExpr;
    }

    if (this.check(TokenKind.Minus) || this.check(TokenKind.Bang)) {
      const opToken = this.advance();
      const operand = this.parseUnary();
      if (!operand) {
        return null;
      }
      const unary: UnaryExpression = {
        kind: "UnaryExpression",
        operator: opToken.lexeme as "-" | "!",
        operand,
        span: { start: opToken.span.start, end: operand.span.end },
      };
      return unary;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): Expression | null {
    let expr: Expression | null = null;

    if (this.check(TokenKind.LParen) && this.looksLikeLambda()) {
      expr = this.parseLambdaExpression();
    } else if (this.check(TokenKind.LParen)) {
      this.advance();
      const inner = this.parseExpression();
      if (!inner) {
        return null;
      }
      if (!this.expect(TokenKind.RParen, "Expected ')' after expression")) {
        return null;
      }
      expr = inner;
    } else if (this.check(TokenKind.LBracket)) {
      expr = this.parseArrayLiteral();
    } else if (this.check(TokenKind.New)) {
      expr = this.parseNewExpression();
    } else if (this.check(TokenKind.This)) {
      const token = this.advance();
      const thisExpr: ThisExpression = {
        kind: "ThisExpression",
        span: token.span,
      };
      expr = thisExpr;
    } else if (this.check(TokenKind.Super)) {
      const token = this.advance();
      const superExpr: SuperExpression = {
        kind: "SuperExpression",
        span: token.span,
      };
      if (this.check(TokenKind.LParen)) {
        return this.parseCallArgs(superExpr, token.span.start);
      }
      expr = superExpr;
    } else if (
      this.check(TokenKind.Identifier) &&
      (this.checkNext(TokenKind.LParen) || this.looksLikeGenericCall())
    ) {
      expr = this.parseCallExpression();
    } else if (
      this.check(TokenKind.Identifier) &&
      this.checkNext(TokenKind.Dot) &&
      this.checkAhead(2, TokenKind.Identifier) &&
      (this.checkAhead(3, TokenKind.LBrace) || this.looksLikeGenericStructLiteral(3))
    ) {
      expr = this.parseStructLiteral();
    } else if (
      this.check(TokenKind.Identifier) &&
      (this.checkNext(TokenKind.LBrace) || this.looksLikeGenericStructLiteral(1))
    ) {
      expr = this.parseStructLiteral();
    } else if (this.check(TokenKind.Identifier)) {
      const token = this.advance();
      expr = {
        kind: "Identifier",
        name: token.lexeme,
        span: token.span,
      };
    } else if (this.check(TokenKind.String)) {
      const token = this.advance();
      const literal: StringLiteral = {
        kind: "StringLiteral",
        value: token.value ?? "",
        raw: token.lexeme,
        span: token.span,
      };
      expr = literal;
    } else if (this.check(TokenKind.Integer)) {
      const token = this.advance();
      const literal: IntegerLiteral = {
        kind: "IntegerLiteral",
        value: Number.parseInt(token.lexeme, 10),
        raw: token.lexeme,
        span: token.span,
      };
      expr = literal;
    } else if (this.check(TokenKind.Float)) {
      const token = this.advance();
      const literal: FloatLiteral = {
        kind: "FloatLiteral",
        value: Number.parseFloat(token.lexeme),
        raw: token.lexeme,
        span: token.span,
      };
      expr = literal;
    } else if (this.check(TokenKind.True) || this.check(TokenKind.False)) {
      const token = this.advance();
      const literal: BooleanLiteral = {
        kind: "BooleanLiteral",
        value: token.kind === TokenKind.True,
        span: token.span,
      };
      expr = literal;
    } else if (this.check(TokenKind.Null)) {
      const token = this.advance();
      const literal: NullLiteral = {
        kind: "NullLiteral",
        span: token.span,
      };
      expr = literal;
    } else if (this.check(TokenKind.Char)) {
      const token = this.advance();
      const literal: CharLiteral = {
        kind: "CharLiteral",
        value: token.value ?? "",
        raw: token.lexeme,
        span: token.span,
      };
      expr = literal;
    } else {
      this.diagnostics.error(`Expected an expression, found '${this.peek().lexeme}'`, this.peek().span, "E0103");
      return null;
    }

    if (!expr) {
      return null;
    }

    return this.parsePostfix(expr);
  }

  private parseNewExpression(): NewExpression | null {
    const start = this.peek().span.start;
    if (!this.expect(TokenKind.New, "Expected 'new'")) {
      return null;
    }

    const firstToken = this.expect(TokenKind.Identifier, "Expected class name after 'new'");
    if (!firstToken) {
      return null;
    }

    let namespace: Identifier | null = null;
    let className: Identifier;

    if (this.check(TokenKind.Dot)) {
      this.advance();
      const nameToken = this.expect(TokenKind.Identifier, "Expected class name after '.'");
      if (!nameToken) {
        return null;
      }
      namespace = {
        kind: "Identifier",
        name: firstToken.lexeme,
        span: firstToken.span,
      };
      className = {
        kind: "Identifier",
        name: nameToken.lexeme,
        span: nameToken.span,
      };
    } else {
      className = {
        kind: "Identifier",
        name: firstToken.lexeme,
        span: firstToken.span,
      };
    }

    const typeArgs = this.parseTypeArgumentListOptional(TokenKind.LParen);
    if (typeArgs === null) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after class name in 'new' expression")) {
      return null;
    }

    const args = this.parseArgumentList("Expected ')' after constructor arguments");
    if (args === null) {
      return null;
    }

    const end = args.end;

    return {
      kind: "NewExpression",
      namespace,
      className,
      typeArgs,
      args: args.args,
      span: { start, end },
    };
  }

  private parsePostfix(expr: Expression): Expression | null {
    let current = expr;

    for (;;) {
      if (this.check(TokenKind.QuestionDot)) {
        this.advance();
        if (this.check(TokenKind.LBracket)) {
          this.advance();
          const index = this.parseExpression();
          if (!index) {
            return null;
          }
          const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after optional index");
          if (!rbracket) {
            return null;
          }
          current = {
            kind: "IndexExpression",
            object: current,
            index,
            optional: true,
            span: { start: current.span.start, end: rbracket.span.end },
          };
          continue;
        }

        const propToken = this.expect(TokenKind.Identifier, "Expected property name after '?.'");
        if (!propToken) {
          return null;
        }
        const property: Identifier = {
          kind: "Identifier",
          name: propToken.lexeme,
          span: propToken.span,
        };
        const member: MemberExpression = {
          kind: "MemberExpression",
          object: current,
          property,
          optional: true,
          span: { start: current.span.start, end: property.span.end },
        };

        if (this.check(TokenKind.LParen) || this.looksLikeTypeArgsThen(TokenKind.LParen)) {
          const call = this.parseCallArgs(member, member.span.start, true);
          if (!call) {
            return null;
          }
          current = call;
        } else {
          current = member;
        }
        continue;
      }

      if (this.check(TokenKind.Question) && this.checkNext(TokenKind.LBracket)) {
        this.advance(); // ?
        this.advance(); // [
        const index = this.parseExpression();
        if (!index) {
          return null;
        }
        const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after optional index");
        if (!rbracket) {
          return null;
        }
        current = {
          kind: "IndexExpression",
          object: current,
          index,
          optional: true,
          span: { start: current.span.start, end: rbracket.span.end },
        };
        continue;
      }

      if (this.check(TokenKind.LBracket)) {
        this.advance();
        const index = this.parseExpression();
        if (!index) {
          return null;
        }
        const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after index");
        if (!rbracket) {
          return null;
        }
        current = {
          kind: "IndexExpression",
          object: current,
          index,
          optional: false,
          span: { start: current.span.start, end: rbracket.span.end },
        };
        continue;
      }

      if (this.check(TokenKind.Dot)) {
        this.advance();
        const propToken = this.expect(TokenKind.Identifier, "Expected property name after '.'");
        if (!propToken) {
          return null;
        }
        const property: Identifier = {
          kind: "Identifier",
          name: propToken.lexeme,
          span: propToken.span,
        };
        const member: MemberExpression = {
          kind: "MemberExpression",
          object: current,
          property,
          optional: false,
          span: { start: current.span.start, end: property.span.end },
        };

        if (this.check(TokenKind.LParen) || this.looksLikeTypeArgsThen(TokenKind.LParen)) {
          const call = this.parseCallArgs(member);
          if (!call) {
            return null;
          }
          current = call;
        } else {
          current = member;
        }
        continue;
      }

      if (this.check(TokenKind.LParen) || this.looksLikeTypeArgsThen(TokenKind.LParen)) {
        const call = this.parseCallArgs(current);
        if (!call) {
          return null;
        }
        current = call;
        continue;
      }

      if (this.check(TokenKind.Bang)) {
        this.advance();
        const nonNull: NonNullExpression = {
          kind: "NonNullExpression",
          expression: current,
          span: { start: current.span.start, end: this.previous().span.end },
        };
        current = nonNull;
        continue;
      }

      break;
    }

    return current;
  }

  private parseArrayLiteral(): ArrayLiteral | null {
    const start = this.peek().span.start;
    this.advance(); // [

    const elements: Expression[] = [];
    if (!this.check(TokenKind.RBracket)) {
      const first = this.parseExpression();
      if (!first) {
        return null;
      }
      elements.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        if (this.check(TokenKind.RBracket)) {
          break; // trailing comma
        }
        const elem = this.parseExpression();
        if (!elem) {
          return null;
        }
        elements.push(elem);
      }
    }

    const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after array elements");
    const end = rbracket?.span.end ?? this.peek().span.end;

    return {
      kind: "ArrayLiteral",
      elements,
      span: { start, end },
    };
  }

  private parseStructLiteral(): StructLiteral | null {
    const start = this.peek().span.start;
    const firstToken = this.advance();
    let namespace: Identifier | null = null;
    let name: Identifier;

    if (this.check(TokenKind.Dot)) {
      this.advance();
      const nameToken = this.expect(TokenKind.Identifier, "Expected struct name after '.'");
      if (!nameToken) {
        return null;
      }
      namespace = {
        kind: "Identifier",
        name: firstToken.lexeme,
        span: firstToken.span,
      };
      name = {
        kind: "Identifier",
        name: nameToken.lexeme,
        span: nameToken.span,
      };
    } else {
      name = {
        kind: "Identifier",
        name: firstToken.lexeme,
        span: firstToken.span,
      };
    }

    const typeArgs = this.parseTypeArgumentListOptional(TokenKind.LBrace);
    if (typeArgs === null) {
      return null;
    }

    if (!this.expect(TokenKind.LBrace, "Expected '{' after struct name")) {
      return null;
    }

    const fields: StructFieldInit[] = [];
    if (!this.check(TokenKind.RBrace)) {
      const first = this.parseStructFieldInit();
      if (!first) {
        return null;
      }
      fields.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        if (this.check(TokenKind.RBrace)) {
          break; // trailing comma
        }
        const field = this.parseStructFieldInit();
        if (!field) {
          return null;
        }
        fields.push(field);
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after struct fields");
    const end = rbrace?.span.end ?? this.peek().span.end;

    return {
      kind: "StructLiteral",
      namespace,
      name,
      typeArgs,
      fields,
      span: { start, end },
    };
  }

  private parseStructFieldInit(): StructFieldInit | null {
    const start = this.peek().span.start;
    const nameToken = this.expect(TokenKind.Identifier, "Expected field name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.Colon, "Expected ':' after field name")) {
      return null;
    }

    const value = this.parseExpression();
    if (!value) {
      return null;
    }

    return {
      kind: "StructFieldInit",
      name,
      value,
      span: { start, end: value.span.end },
    };
  }

  private parseCallExpression(): CallExpression | null {
    const start = this.peek().span.start;
    const calleeToken = this.expect(TokenKind.Identifier, "Expected function name");
    if (!calleeToken) {
      return null;
    }

    const callee: Identifier = {
      kind: "Identifier",
      name: calleeToken.lexeme,
      span: calleeToken.span,
    };

    return this.parseCallArgs(callee, start);
  }

  private parseCallArgs(
    callee: Expression,
    start = callee.span.start,
    optional = false,
  ): CallExpression | null {
    const typeArgs = this.parseTypeArgumentListOptional(TokenKind.LParen);
    if (typeArgs === null) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after function name")) {
      return null;
    }

    const parsed = this.parseArgumentList("Expected ')' after arguments");
    if (parsed === null) {
      return null;
    }

    return {
      kind: "CallExpression",
      callee,
      typeArgs,
      args: parsed.args,
      optional,
      span: { start, end: parsed.end },
    };
  }

  /**
   * Parse a comma-separated argument list ending at ')'.
   * Supports positional expressions and named arguments (`name: expr`).
   * Positional arguments must come before named arguments.
   */
  private parseArgumentList(
    rparenMessage: string,
  ): { args: CallArgument[]; end: { line: number; column: number; offset: number } } | null {
    const args: CallArgument[] = [];
    let sawNamed = false;

    if (!this.check(TokenKind.RParen)) {
      const first = this.parseCallArgument(sawNamed);
      if (!first) {
        return null;
      }
      if (first.kind === "NamedArgument") {
        sawNamed = true;
      }
      args.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        const arg = this.parseCallArgument(sawNamed);
        if (!arg) {
          return null;
        }
        if (arg.kind === "NamedArgument") {
          sawNamed = true;
        }
        args.push(arg);
      }
    }

    const rparen = this.expect(TokenKind.RParen, rparenMessage);
    const end = rparen?.span.end ?? this.peek().span.end;
    return { args, end };
  }

  private parseCallArgument(sawNamed: boolean): CallArgument | null {
    if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.Colon)) {
      const nameToken = this.advance();
      this.advance(); // ':'
      const value = this.parseExpression();
      if (!value) {
        return null;
      }
      const name: Identifier = {
        kind: "Identifier",
        name: nameToken.lexeme,
        span: nameToken.span,
      };
      return {
        kind: "NamedArgument",
        name,
        value,
        span: { start: name.span.start, end: value.span.end },
      };
    }

    const expr = this.parseExpression();
    if (!expr) {
      return null;
    }
    if (sawNamed) {
      this.diagnostics.error(
        "Positional arguments must come before named arguments",
        expr.span,
        "E0102",
      );
      return null;
    }
    return expr;
  }

  private parseType(): TypeAnnotation | null {
    return this.parseUnionType();
  }

  private parseUnionType(): TypeAnnotation | null {
    const first = this.parseIntersectionType();
    if (!first) {
      return null;
    }
    if (!this.check(TokenKind.Pipe)) {
      return first;
    }
    const types: TypeAnnotation[] = [first];
    while (this.match(TokenKind.Pipe)) {
      const next = this.parseIntersectionType();
      if (!next) {
        return null;
      }
      types.push(next);
    }
    const union: UnionType = {
      kind: "UnionType",
      types,
      span: { start: first.span.start, end: types[types.length - 1]!.span.end },
    };
    return union;
  }

  private parseIntersectionType(): TypeAnnotation | null {
    const first = this.parseConditionalType();
    if (!first) {
      return null;
    }
    if (!this.check(TokenKind.Amp)) {
      return first;
    }
    const types: TypeAnnotation[] = [first];
    while (this.match(TokenKind.Amp)) {
      const next = this.parseConditionalType();
      if (!next) {
        return null;
      }
      types.push(next);
    }
    const intersection: IntersectionType = {
      kind: "IntersectionType",
      types,
      span: { start: first.span.start, end: types[types.length - 1]!.span.end },
    };
    return intersection;
  }

  private parseConditionalType(): TypeAnnotation | null {
    const checkType = this.parsePostfixType();
    if (!checkType) {
      return null;
    }
    if (!this.check(TokenKind.Extends)) {
      return checkType;
    }
    // Only parse as conditional when `extends` is followed by type `?` true `:` false
    // Look ahead carefully: type params also use extends, but those are handled elsewhere.
    this.advance(); // extends
    const extendsType = this.parseType();
    if (!extendsType) {
      return null;
    }
    if (!this.match(TokenKind.Question)) {
      // Bare `T extends U` is not valid as a standalone type; treat as error recovery
      // by returning checkType and reporting.
      this.diagnostics.error(
        "Expected '?' after 'extends' clause in conditional type",
        this.peek().span,
        "E0103",
      );
      return null;
    }
    const trueType = this.parseType();
    if (!trueType) {
      return null;
    }
    if (!this.expect(TokenKind.Colon, "Expected ':' in conditional type")) {
      return null;
    }
    const falseType = this.parseType();
    if (!falseType) {
      return null;
    }
    const conditional: ConditionalType = {
      kind: "ConditionalType",
      checkType,
      extendsType,
      trueType,
      falseType,
      span: { start: checkType.span.start, end: falseType.span.end },
    };
    return conditional;
  }

  private parsePostfixType(): TypeAnnotation | null {
    let type = this.parsePrimaryType();
    if (!type) {
      return null;
    }
    for (;;) {
      if (this.check(TokenKind.LBracket)) {
        // Could be `[]` array or `[Type]` indexed access
        if (this.checkNext(TokenKind.RBracket)) {
          this.advance(); // [
          const rbracket = this.advance(); // ]
          type = {
            kind: "ArrayType",
            element: type,
            span: { start: type.span.start, end: rbracket.span.end },
          };
          continue;
        }
        this.advance(); // [
        const indexType = this.parseType();
        if (!indexType) {
          return null;
        }
        const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after indexed access type");
        if (!rbracket) {
          return null;
        }
        const indexed: IndexedAccessType = {
          kind: "IndexedAccessType",
          objectType: type,
          indexType,
          span: { start: type.span.start, end: rbracket.span.end },
        };
        type = indexed;
        continue;
      }
      break;
    }
    return type;
  }

  private parseTupleType(): TupleType | null {
    const start = this.peek().span.start;
    this.advance(); // [

    const elements: TypeAnnotation[] = [];
    if (!this.check(TokenKind.RBracket)) {
      const first = this.parseType();
      if (!first) {
        return null;
      }
      elements.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        if (this.check(TokenKind.RBracket)) {
          break; // trailing comma
        }
        const elem = this.parseType();
        if (!elem) {
          return null;
        }
        elements.push(elem);
      }
    }

    const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after tuple type");
    if (!rbracket) {
      return null;
    }

    return {
      kind: "TupleType",
      elements,
      span: { start, end: rbracket.span.end },
    };
  }

  private parsePrimaryType(): TypeAnnotation | null {
    if (this.check(TokenKind.LParen) && this.looksLikeFunctionType()) {
      return this.parseFunctionType();
    }

    if (this.check(TokenKind.LParen)) {
      this.advance();
      const inner = this.parseType();
      if (!inner) {
        return null;
      }
      if (!this.expect(TokenKind.RParen, "Expected ')' after type")) {
        return null;
      }
      return inner;
    }

    if (this.check(TokenKind.LBracket)) {
      return this.parseTupleType();
    }

    if (this.check(TokenKind.Keyof)) {
      const start = this.advance().span.start;
      const type = this.parsePostfixType();
      if (!type) {
        return null;
      }
      const keyofType: KeyofType = {
        kind: "KeyofType",
        type,
        span: { start, end: type.span.end },
      };
      return keyofType;
    }

    if (this.check(TokenKind.Typeof)) {
      const start = this.advance().span.start;
      const expression = this.parseTypeofTypeExpression();
      if (!expression) {
        return null;
      }
      const typeofType: TypeofType = {
        kind: "TypeofType",
        expression,
        span: { start, end: expression.span.end },
      };
      return typeofType;
    }

    if (this.check(TokenKind.LBrace)) {
      return this.parseObjectOrMappedType();
    }

    if (this.check(TokenKind.String)) {
      const token = this.advance();
      const lit: LiteralType = {
        kind: "LiteralType",
        value: token.value ?? "",
        literalKind: "string",
        span: token.span,
      };
      return lit;
    }

    if (this.check(TokenKind.Integer)) {
      const token = this.advance();
      const lit: LiteralType = {
        kind: "LiteralType",
        value: Number(token.lexeme),
        literalKind: "number",
        span: token.span,
      };
      return lit;
    }

    if (this.check(TokenKind.Null)) {
      const token = this.advance();
      return {
        kind: "PrimitiveType",
        name: "null",
        span: token.span,
      };
    }

    const token = this.expect(TokenKind.Identifier, "Expected a type name");
    if (!token) {
      return null;
    }

    if (PRIMITIVE_TYPES.has(token.lexeme)) {
      return {
        kind: "PrimitiveType",
        name: token.lexeme as PrimitiveTypeName,
        span: token.span,
      };
    }

    let namespace: string | null = null;
    let nameLexeme = token.lexeme;
    let nameEnd = token.span.end;

    if (this.check(TokenKind.Dot)) {
      this.advance();
      const nameToken = this.expect(TokenKind.Identifier, "Expected type name after '.'");
      if (!nameToken) {
        return null;
      }
      namespace = token.lexeme;
      nameLexeme = nameToken.lexeme;
      nameEnd = nameToken.span.end;
    }

    const typeArgs = this.parseTypeArgumentListInTypePosition();
    if (typeArgs === null) {
      return null;
    }
    const end = typeArgs.length > 0 ? this.previous().span.end : nameEnd;
    return {
      kind: "NamedType",
      namespace,
      name: nameLexeme,
      typeArgs,
      span: { start: token.span.start, end },
    };
  }

  /** Parse identifier or call used in `typeof` type position. */
  private parseTypeofTypeExpression(): Expression | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected identifier after 'typeof'");
    if (!nameToken) {
      return null;
    }
    let expr: Expression = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };
    // Optional call: typeof createPerson()
    if (this.check(TokenKind.LParen)) {
      this.advance();
      const parsed = this.parseArgumentList("Expected ')' after typeof call arguments");
      if (!parsed) {
        return null;
      }
      expr = {
        kind: "CallExpression",
        callee: expr as Identifier,
        typeArgs: [],
        args: parsed.args,
        optional: false,
        span: { start: nameToken.span.start, end: parsed.end },
      };
    }
    return expr;
  }

  private parseObjectOrMappedType(): TypeAnnotation | null {
    const start = this.peek().span.start;
    if (!this.expect(TokenKind.LBrace, "Expected '{'")) {
      return null;
    }

    // Mapped type: { readonly? [K in Type]: Type }
    if (
      (this.check(TokenKind.Readonly) && this.checkNext(TokenKind.LBracket)) ||
      (this.check(TokenKind.LBracket) && this.checkAhead(2, TokenKind.In))
    ) {
      const isReadonly = this.match(TokenKind.Readonly);
      if (!this.expect(TokenKind.LBracket, "Expected '[' in mapped type")) {
        return null;
      }
      const paramToken = this.expect(TokenKind.Identifier, "Expected type parameter in mapped type");
      if (!paramToken) {
        return null;
      }
      if (!this.expect(TokenKind.In, "Expected 'in' in mapped type")) {
        return null;
      }
      const constraint = this.parseType();
      if (!constraint) {
        return null;
      }
      if (!this.expect(TokenKind.RBracket, "Expected ']' after mapped type key")) {
        return null;
      }
      if (!this.expect(TokenKind.Colon, "Expected ':' after mapped type key")) {
        return null;
      }
      const valueType = this.parseType();
      if (!valueType) {
        return null;
      }
      if (!this.expect(TokenKind.Semicolon, "Expected ';' after mapped type member") && !this.check(TokenKind.RBrace)) {
        // allow missing semicolon before }
      }
      this.match(TokenKind.Semicolon);
      const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after mapped type");
      if (!rbrace) {
        return null;
      }
      const mapped: MappedType = {
        kind: "MappedType",
        readonly: isReadonly,
        typeParam: { kind: "Identifier", name: paramToken.lexeme, span: paramToken.span },
        constraint,
        type: valueType,
        span: { start, end: rbrace.span.end },
      };
      return mapped;
    }

    const fields: ObjectTypeField[] = [];
    let indexSignature: ObjectIndexSignature | null = null;

    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      if (this.check(TokenKind.LBracket)) {
        const idxStart = this.peek().span.start;
        this.advance();
        const keyToken = this.expect(TokenKind.Identifier, "Expected index parameter name");
        if (!keyToken) {
          return null;
        }
        if (!this.expect(TokenKind.Colon, "Expected ':' after index parameter name")) {
          return null;
        }
        const keyType = this.parseType();
        if (!keyType) {
          return null;
        }
        if (!this.expect(TokenKind.RBracket, "Expected ']' after index key type")) {
          return null;
        }
        if (!this.expect(TokenKind.Colon, "Expected ':' after index signature")) {
          return null;
        }
        const valueType = this.parseType();
        if (!valueType) {
          return null;
        }
        let end = valueType.span.end;
        if (this.check(TokenKind.Semicolon)) {
          end = this.advance().span.end;
        }
        indexSignature = {
          kind: "ObjectIndexSignature",
          keyName: { kind: "Identifier", name: keyToken.lexeme, span: keyToken.span },
          keyType,
          valueType,
          span: { start: idxStart, end },
        };
        continue;
      }

      const isReadonly = this.match(TokenKind.Readonly);
      const nameToken = this.expect(TokenKind.Identifier, "Expected property name");
      if (!nameToken) {
        return null;
      }
      if (!this.expect(TokenKind.Colon, "Expected ':' after property name")) {
        return null;
      }
      const typeAnnotation = this.parseType();
      if (!typeAnnotation) {
        return null;
      }
      const semi = this.expect(TokenKind.Semicolon, "Expected ';' after property");
      if (!semi) {
        return null;
      }
      fields.push({
        kind: "ObjectTypeField",
        readonly: isReadonly,
        name: { kind: "Identifier", name: nameToken.lexeme, span: nameToken.span },
        typeAnnotation,
        span: { start: nameToken.span.start, end: semi.span.end },
      });
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after object type");
    if (!rbrace) {
      return null;
    }

    const objectType: ObjectType = {
      kind: "ObjectType",
      fields,
      indexSignature,
      span: { start, end: rbrace.span.end },
    };
    return objectType;
  }

  /**
   * Parse `<T, U extends C>` after a declaration name.
   * Returns [] when no `<` is present; null on hard parse failure.
   */
  private parseTypeParameterList(): TypeParameter[] | null {
    if (!this.check(TokenKind.Less)) {
      return [];
    }
    this.advance(); // <

    const params: TypeParameter[] = [];
    const first = this.parseTypeParameter();
    if (!first) {
      return null;
    }
    params.push(first);

    while (this.check(TokenKind.Comma)) {
      this.advance();
      const param = this.parseTypeParameter();
      if (!param) {
        return null;
      }
      params.push(param);
    }

    if (!this.expect(TokenKind.Greater, "Expected '>' after type parameters")) {
      return null;
    }
    return params;
  }

  private parseTypeParameter(): TypeParameter | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected type parameter name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    let constraint: TypeAnnotation | null = null;
    let end = nameToken.span.end;
    if (this.match(TokenKind.Extends)) {
      constraint = this.parseType();
      if (!constraint) {
        return null;
      }
      end = constraint.span.end;
    }

    return {
      kind: "TypeParameter",
      name,
      constraint,
      span: { start: nameToken.span.start, end },
    };
  }

  /** Required type-argument list in type position (`Array<i32>`). Empty if no `<`. */
  private parseTypeArgumentListInTypePosition(): TypeAnnotation[] | null {
    if (!this.check(TokenKind.Less)) {
      return [];
    }
    return this.parseTypeArgumentListRequired();
  }

  /**
   * Optional type args in expression position: only consume if `<...>` is followed by `after`.
   * Returns [] when absent; null on hard failure after committing.
   */
  private parseTypeArgumentListOptional(after: TokenKind): TypeAnnotation[] | null {
    if (!this.check(TokenKind.Less)) {
      return [];
    }
    const saved = this.current;
    const diagCount = this.diagnostics.diagnostics.length;
    const args = this.parseTypeArgumentListRequired();
    if (args === null || !this.check(after)) {
      this.current = saved;
      this.diagnostics.truncate(diagCount);
      return [];
    }
    return args;
  }

  private parseTypeArgumentListRequired(): TypeAnnotation[] | null {
    if (!this.expect(TokenKind.Less, "Expected '<'")) {
      return null;
    }

    const args: TypeAnnotation[] = [];
    const first = this.parseType();
    if (!first) {
      return null;
    }
    args.push(first);

    while (this.check(TokenKind.Comma)) {
      this.advance();
      const arg = this.parseType();
      if (!arg) {
        return null;
      }
      args.push(arg);
    }

    if (!this.expect(TokenKind.Greater, "Expected '>' after type arguments")) {
      return null;
    }
    return args;
  }

  /** True when current `(` starts a lambda `(...) =>` or `(...): T =>`. */
  private looksLikeLambda(): boolean {
    if (!this.check(TokenKind.LParen)) {
      return false;
    }
    const saved = this.current;
    const diagCount = this.diagnostics.diagnostics.length;
    this.advance(); // (
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      const kind = this.peek().kind;
      if (kind === TokenKind.LParen) {
        depth++;
      } else if (kind === TokenKind.RParen) {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      this.advance();
    }
    if (!this.check(TokenKind.RParen)) {
      this.current = saved;
      this.diagnostics.truncate(diagCount);
      return false;
    }
    this.advance(); // )
    if (this.check(TokenKind.Colon)) {
      this.advance();
      const ret = this.parseType();
      if (!ret) {
        this.current = saved;
        this.diagnostics.truncate(diagCount);
        return false;
      }
    }
    const ok = this.check(TokenKind.Arrow);
    this.current = saved;
    this.diagnostics.truncate(diagCount);
    return ok;
  }

  /** True when current `(` starts a function type `(...) => T`. */
  private looksLikeFunctionType(): boolean {
    if (!this.check(TokenKind.LParen)) {
      return false;
    }
    const saved = this.current;
    const diagCount = this.diagnostics.diagnostics.length;
    this.advance(); // (
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      const kind = this.peek().kind;
      if (kind === TokenKind.LParen) {
        depth++;
      } else if (kind === TokenKind.RParen) {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      this.advance();
    }
    if (!this.check(TokenKind.RParen)) {
      this.current = saved;
      this.diagnostics.truncate(diagCount);
      return false;
    }
    this.advance(); // )
    const ok = this.check(TokenKind.Arrow);
    this.current = saved;
    this.diagnostics.truncate(diagCount);
    return ok;
  }

  private parseLambdaExpression(): LambdaExpression | null {
    const start = this.peek().span.start;
    if (!this.expect(TokenKind.LParen, "Expected '(' to start lambda")) {
      return null;
    }

    const params: LambdaParameter[] = [];
    if (!this.check(TokenKind.RParen)) {
      const first = this.parseLambdaParameter();
      if (!first) {
        return null;
      }
      params.push(first);
      while (this.check(TokenKind.Comma)) {
        this.advance();
        if (this.check(TokenKind.RParen)) {
          break;
        }
        const param = this.parseLambdaParameter();
        if (!param) {
          return null;
        }
        params.push(param);
      }
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after lambda parameters")) {
      return null;
    }

    let returnType: TypeAnnotation | null = null;
    if (this.check(TokenKind.Colon)) {
      this.advance();
      returnType = this.parseType();
      if (!returnType) {
        return null;
      }
    }

    if (!this.expect(TokenKind.Arrow, "Expected '=>' after lambda parameters")) {
      return null;
    }

    if (this.check(TokenKind.LBrace)) {
      const block = this.parseBlock();
      if (!block) {
        return null;
      }
      return {
        kind: "LambdaExpression",
        params,
        returnType,
        body: { kind: "block", statements: block.statements },
        span: { start, end: block.end },
      };
    }

    const expression = this.parseExpression();
    if (!expression) {
      return null;
    }
    return {
      kind: "LambdaExpression",
      params,
      returnType,
      body: { kind: "expression", expression },
      span: { start, end: expression.span.end },
    };
  }

  private parseLambdaParameter(): LambdaParameter | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected parameter name");
    if (!nameToken) {
      return null;
    }
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };
    let typeAnnotation: TypeAnnotation | null = null;
    if (this.check(TokenKind.Colon)) {
      this.advance();
      typeAnnotation = this.parseType();
      if (!typeAnnotation) {
        return null;
      }
    }
    return {
      kind: "LambdaParameter",
      name,
      typeAnnotation,
      span: {
        start: name.span.start,
        end: typeAnnotation ? typeAnnotation.span.end : name.span.end,
      },
    };
  }

  private parseFunctionType(): FunctionType | null {
    const start = this.peek().span.start;
    if (!this.expect(TokenKind.LParen, "Expected '(' to start function type")) {
      return null;
    }

    const params: TypeAnnotation[] = [];
    if (!this.check(TokenKind.RParen)) {
      const first = this.parseType();
      if (!first) {
        return null;
      }
      params.push(first);
      while (this.check(TokenKind.Comma)) {
        this.advance();
        if (this.check(TokenKind.RParen)) {
          break;
        }
        const param = this.parseType();
        if (!param) {
          return null;
        }
        params.push(param);
      }
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after function type parameters")) {
      return null;
    }
    if (!this.expect(TokenKind.Arrow, "Expected '=>' in function type")) {
      return null;
    }
    const returnType = this.parseType();
    if (!returnType) {
      return null;
    }
    return {
      kind: "FunctionType",
      params,
      returnType,
      span: { start, end: returnType.span.end },
    };
  }

  /** True when current Ident is followed by `<...>(`. */
  private looksLikeGenericCall(): boolean {
    if (!this.check(TokenKind.Identifier) || !this.checkNext(TokenKind.Less)) {
      return false;
    }
    const saved = this.current;
    const diagCount = this.diagnostics.diagnostics.length;
    this.advance(); // Ident
    const args = this.parseTypeArgumentListRequired();
    const ok = args !== null && this.check(TokenKind.LParen);
    this.current = saved;
    this.diagnostics.truncate(diagCount);
    return ok;
  }

  /** True when tokens starting at `offset` look like `<...>{`. Offset is relative to current. */
  private looksLikeGenericStructLiteral(offset: number): boolean {
    if (!this.checkAhead(offset, TokenKind.Less)) {
      return false;
    }
    const saved = this.current;
    const diagCount = this.diagnostics.diagnostics.length;
    this.current = saved + offset;
    const args = this.parseTypeArgumentListRequired();
    const ok = args !== null && this.check(TokenKind.LBrace);
    this.current = saved;
    this.diagnostics.truncate(diagCount);
    return ok;
  }

  /** True when current position starts with `<...>` followed by `after`. */
  private looksLikeTypeArgsThen(after: TokenKind): boolean {
    if (!this.check(TokenKind.Less)) {
      return false;
    }
    const saved = this.current;
    const diagCount = this.diagnostics.diagnostics.length;
    const args = this.parseTypeArgumentListRequired();
    const ok = args !== null && this.check(after);
    this.current = saved;
    this.diagnostics.truncate(diagCount);
    return ok;
  }

  private previous(): Token {
    return this.tokens[this.current - 1]!;
  }

  private match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, message: string): Token | null {
    if (this.check(kind)) {
      return this.advance();
    }
    this.diagnostics.error(message, this.peek().span, "E0103");
    return null;
  }

  private synchronizeStatement(): void {
    while (!this.isAtEnd()) {
      if (this.check(TokenKind.Semicolon)) {
        this.advance();
        return;
      }
      if (this.check(TokenKind.RBrace)) {
        return;
      }
      this.advance();
    }
  }

  private synchronizeToTopLevel(): void {
    while (!this.isAtEnd()) {
      if (
        this.check(TokenKind.Import) ||
        this.check(TokenKind.Export) ||
        this.check(TokenKind.Function) ||
        this.check(TokenKind.Struct) ||
        this.check(TokenKind.Enum) ||
        this.check(TokenKind.Class) ||
        this.check(TokenKind.Interface) ||
        this.check(TokenKind.Type) ||
        this.check(TokenKind.Abstract)
      ) {
        return;
      }
      this.advance();
    }
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private checkNext(kind: TokenKind): boolean {
    return this.checkAhead(1, kind);
  }

  private checkAhead(offset: number, kind: TokenKind): boolean {
    const token = this.tokens[this.current + offset];
    return token?.kind === kind;
  }

  private peek(): Token {
    return this.tokens[this.current] ?? this.tokens[this.tokens.length - 1]!;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === TokenKind.Eof;
  }

  private advance(): Token {
    const token = this.peek();
    if (!this.isAtEnd()) {
      this.current += 1;
    }
    return token;
  }
}
