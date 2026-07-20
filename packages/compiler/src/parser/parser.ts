import type {
  ArrayLiteral,
  Assignable,
  AssignmentStatement,
  BinaryExpression,
  BinaryOperator,
  BooleanLiteral,
  BreakStatement,
  CallExpression,
  CharLiteral,
  ClassDeclaration,
  ClassField,
  ClassMember,
  ClassMethod,
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
  IndexExpression,
  IntegerLiteral,
  InterfaceDeclaration,
  InterfaceMethodSignature,
  MemberExpression,
  NamedType,
  NewExpression,
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
  SuperExpression,
  ThisExpression,
  TopLevelDeclaration,
  TypeAnnotation,
  TypeParameter,
  UnaryExpression,
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
 *   program      = importDecl* (functionDecl | structDecl | enumDecl | classDecl | interfaceDecl)*
 *   importDecl   = "import" String ("as" Ident)? ";"
 *   functionDecl = "export"? "function" Ident typeParams? "(" params? ")" ":" type block
 *   structDecl   = "export"? "struct" Ident typeParams? "{" (structField | structMethod)* "}"
 *   enumDecl     = "export"? "enum" Ident "{" (Ident ("," Ident)* ","?)? "}"
 *   classDecl    = "export"? "abstract"? "class" Ident typeParams? ("extends" type)? ("implements" type ("," type)*)? "{" classMember* "}"
 *   interfaceDecl = "export"? "interface" Ident typeParams? ("extends" type ("," type)*)? "{" ifaceMethod* "}"
 *   structLiteral = (Ident | Ident "." Ident) typeArgs? "{" fields? "}"
 *   type         = Ident ("." Ident)? typeArgs? ("[" "]")*
 *   typeParams   = "<" typeParam ("," typeParam)* ">"
 *   typeParam    = Ident ("extends" type)?
 *   typeArgs     = "<" type ("," type)* ">"
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
            `Expected 'function', 'struct', 'enum', 'class', or 'interface' after modifiers, found '${this.peek().lexeme}'`,
            this.peek().span,
            "E0103",
          );
        } else {
          this.diagnostics.error(
            `Expected 'function', 'struct', 'enum', 'class', 'interface', or 'import', found '${this.peek().lexeme}'`,
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
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
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
      span: { start, end: rbrace.span.end },
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

    return {
      kind: "Parameter",
      name,
      typeAnnotation,
      span: { start: name.span.start, end: typeAnnotation.span.end },
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

    if (this.check(TokenKind.Break)) {
      return this.parseBreakStatement();
    }

    if (this.check(TokenKind.Continue)) {
      return this.parseContinueStatement();
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

    const nameToken = this.expect(TokenKind.Identifier, "Expected variable name");
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

    if (!this.expect(TokenKind.Equal, "Expected '=' after variable name")) {
      return null;
    }

    const initializer = this.parseExpression();
    if (!initializer) {
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after variable declaration");
    const end = semicolon?.span.end ?? initializer.span.end;

    return {
      kind: "VariableDeclaration",
      mutability,
      name,
      typeAnnotation,
      initializer,
      span: { start, end },
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
    let left = this.parseAnd();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.PipePipe)) {
      const opToken = this.advance();
      const right = this.parseAnd();
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

    if (this.check(TokenKind.LParen)) {
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

    const args: Expression[] = [];
    if (!this.check(TokenKind.RParen)) {
      const first = this.parseExpression();
      if (!first) {
        return null;
      }
      args.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        const arg = this.parseExpression();
        if (!arg) {
          return null;
        }
        args.push(arg);
      }
    }

    const rparen = this.expect(TokenKind.RParen, "Expected ')' after constructor arguments");
    const end = rparen?.span.end ?? this.peek().span.end;

    return {
      kind: "NewExpression",
      namespace,
      className,
      typeArgs,
      args,
      span: { start, end },
    };
  }

  private parsePostfix(expr: Expression): Expression | null {
    let current = expr;

    for (;;) {
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
    callee: Identifier | MemberExpression | SuperExpression,
    start = callee.span.start,
  ): CallExpression | null {
    const typeArgs = this.parseTypeArgumentListOptional(TokenKind.LParen);
    if (typeArgs === null) {
      return null;
    }

    if (!this.expect(TokenKind.LParen, "Expected '(' after function name")) {
      return null;
    }

    const args: Expression[] = [];
    if (!this.check(TokenKind.RParen)) {
      const first = this.parseExpression();
      if (!first) {
        return null;
      }
      args.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        const arg = this.parseExpression();
        if (!arg) {
          return null;
        }
        args.push(arg);
      }
    }

    const rparen = this.expect(TokenKind.RParen, "Expected ')' after arguments");
    const end = rparen?.span.end ?? this.peek().span.end;

    return {
      kind: "CallExpression",
      callee,
      typeArgs,
      args,
      span: { start, end },
    };
  }

  private parseType(): TypeAnnotation | null {
    const token = this.expect(TokenKind.Identifier, "Expected a type name");
    if (!token) {
      return null;
    }

    let type: TypeAnnotation;
    if (PRIMITIVE_TYPES.has(token.lexeme)) {
      type = {
        kind: "PrimitiveType",
        name: token.lexeme as PrimitiveTypeName,
        span: token.span,
      };
    } else {
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
      type = {
        kind: "NamedType",
        namespace,
        name: nameLexeme,
        typeArgs,
        span: { start: token.span.start, end },
      };
    }

    while (this.check(TokenKind.LBracket)) {
      this.advance();
      const rbracket = this.expect(TokenKind.RBracket, "Expected ']' after '[' in array type");
      if (!rbracket) {
        return null;
      }
      type = {
        kind: "ArrayType",
        element: type,
        span: { start: type.span.start, end: rbracket.span.end },
      };
    }

    return type;
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
