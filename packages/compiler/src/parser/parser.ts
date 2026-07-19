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
  ContinueStatement,
  Expression,
  ExpressionStatement,
  FloatLiteral,
  ForInStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  IndexExpression,
  IntegerLiteral,
  MemberExpression,
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
  TopLevelDeclaration,
  TypeAnnotation,
  UnaryExpression,
  UpdateStatement,
  VariableDeclaration,
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
 *   program      = (functionDecl | structDecl)*
 *   functionDecl = "function" Ident "(" params? ")" ":" type block
 *   structDecl   = "struct" Ident "{" structField* "}"
 *   structField  = Ident ":" type ";"
 *   params       = param ("," param)*
 *   param        = Ident ":" type
 *   statement    = varDecl | assignment | updateStmt | returnStmt
 *                | ifStmt | whileStmt | forStmt | breakStmt | continueStmt | exprStmt
 *   varDecl      = ("let"|"const") Ident (":" type)? "=" expression ";"
 *   assignment   = assignable ("=" | "+=" | "-=") expression ";"
 *   assignable   = Ident | Ident "[" expression "]" | Ident ("." Ident)+
 *   updateStmt   = Ident ("++" | "--") ";"
 *   returnStmt   = "return" expression? ";"
 *   ifStmt       = "if" "(" expression ")" block
 *                  ("elseif" "(" expression ")" block)*
 *                  ("else" block)?
 *   whileStmt    = "while" "(" expression ")" block
 *   forStmt      = forCStyle | forIn
 *   forCStyle    = "for" "(" forInit condition? ";" forUpdate? ")" block
 *   forIn        = "for" "(" (("let"|"const")? Ident) "in" expression ")" block
 *   forInit      = varDecl | assignment | ";"
 *   forUpdate    = updateStmtNoSemi | assignmentNoSemi
 *   breakStmt    = "break" ";"
 *   continueStmt = "continue" ";"
 *   block        = "{" statement* "}"
 *   exprStmt     = callExpr ";"
 *   expression   = or
 *   primary      = "(" expression ")" | arrayLiteral | structLiteral | literal | Ident | callExpr
 *   postfix      = primary ("[" expression "]" | "." Ident ("(" args? ")")?)*
 *   arrayLiteral = "[" (expression ("," expression)*)? "]"
 *   structLiteral = Ident "{" (Ident ":" expression ("," Ident ":" expression)*)? "}"
 *   type         = Ident ("[" "]")*
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

    while (!this.check(TokenKind.Eof)) {
      if (this.check(TokenKind.Struct)) {
        const decl = this.parseStructDeclaration();
        if (decl) {
          body.push(decl);
        } else {
          break;
        }
      } else if (this.check(TokenKind.Function)) {
        const fn = this.parseFunctionDeclaration();
        if (fn) {
          body.push(fn);
        } else {
          break;
        }
      } else {
        this.diagnostics.error(
          `Expected 'function' or 'struct', found '${this.peek().lexeme}'`,
          this.peek().span,
          "E0103",
        );
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

  private parseStructDeclaration(): StructDeclaration | null {
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

    if (!this.expect(TokenKind.LBrace, "Expected '{' after struct name")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const fields: StructField[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const field = this.parseStructField();
      if (!field) {
        this.synchronizeToTopLevel();
        return null;
      }
      fields.push(field);
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after struct fields");
    if (!rbrace) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "StructDeclaration",
      name,
      fields,
      span: { start, end: rbrace.span.end },
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

  private parseFunctionDeclaration(): FunctionDeclaration | null {
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
      name,
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
    let object: Expression = {
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
    // Function call: Ident (
    if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.LParen)) {
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
    } else if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.LParen)) {
      expr = this.parseCallExpression();
    } else if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.LBrace)) {
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

        if (this.check(TokenKind.LParen)) {
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
    const nameToken = this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

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
      name,
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
    callee: Identifier | MemberExpression,
    start = callee.span.start,
  ): CallExpression | null {
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
      type = {
        kind: "NamedType",
        name: token.lexeme,
        span: token.span,
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
      if (this.check(TokenKind.Function) || this.check(TokenKind.Struct)) {
        return;
      }
      this.advance();
    }
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private checkNext(kind: TokenKind): boolean {
    const next = this.tokens[this.current + 1];
    return next?.kind === kind;
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
