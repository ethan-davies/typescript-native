import type {
  CallExpression,
  ExpressionStatement,
  FunctionDeclaration,
  Identifier,
  Program,
  Statement,
  StringLiteral,
} from "../ast/nodes.js";
import type { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import { TokenKind, type Token } from "../lexer/tokens.js";

/**
 * Recursive-descent parser for the v0 grammar:
 *
 *   program     = functionDecl EOF
 *   functionDecl = "function" Identifier "(" ")" "{" statement* "}"
 *   statement   = "print" "(" String ")" ";"
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
    const functions: FunctionDeclaration[] = [];

    if (!this.check(TokenKind.Eof)) {
      const fn = this.parseFunctionDeclaration();
      if (fn) {
        functions.push(fn);
      }

      while (!this.isAtEnd()) {
        this.diagnostics.error(
          `Unexpected token '${this.peek().lexeme}'`,
          this.peek().span,
          "E0101",
        );
        this.advance();
      }
    }

    const eof = this.peek();
    return {
      kind: "Program",
      body: functions,
      span: { start, end: eof.span.end },
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
    if (!this.expect(TokenKind.RParen, "Expected ')' after parameter list")) {
      this.synchronizeToTopLevel();
      return null;
    }
    if (!this.expect(TokenKind.LBrace, "Expected '{' before function body")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const body: Statement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (stmt) {
        body.push(stmt);
      } else {
        this.synchronizeStatement();
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after function body");
    const end = rbrace?.span.end ?? this.peek().span.end;

    return {
      kind: "FunctionDeclaration",
      name,
      body,
      span: { start, end },
    };
  }

  private parseStatement(): Statement | null {
    const start = this.peek().span.start;

    const calleeToken = this.expect(TokenKind.Identifier, "Expected a statement");
    if (!calleeToken) {
      return null;
    }

    if (calleeToken.lexeme !== "print") {
      this.diagnostics.error(
        `Only 'print(...)' statements are supported; found '${calleeToken.lexeme}'`,
        calleeToken.span,
        "E0102",
      );
      return null;
    }

    const callee: Identifier = {
      kind: "Identifier",
      name: calleeToken.lexeme,
      span: calleeToken.span,
    };

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'print'")) {
      return null;
    }

    const stringToken = this.expect(TokenKind.String, "Expected a string literal argument to print");
    if (!stringToken) {
      return null;
    }

    const arg: StringLiteral = {
      kind: "StringLiteral",
      value: stringToken.value ?? "",
      raw: stringToken.lexeme,
      span: stringToken.span,
    };

    if (!this.expect(TokenKind.RParen, "Expected ')' after print argument")) {
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after print statement");
    const end = semicolon?.span.end ?? this.peek().span.end;

    const call: CallExpression = {
      kind: "CallExpression",
      callee,
      args: [arg],
      span: { start, end },
    };

    const stmt: ExpressionStatement = {
      kind: "ExpressionStatement",
      expression: call,
      span: { start, end },
    };

    return stmt;
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
      this.advance();
    }
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
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
