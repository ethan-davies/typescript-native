import type { DiagnosticCollector, SourceLocation, SourceSpan } from "../diagnostics/diagnostic.js";
import { KEYWORDS, TokenKind, type Token } from "./tokens.js";

export class Lexer {
  private readonly source: string;
  private readonly diagnostics: DiagnosticCollector;
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(source: string, diagnostics: DiagnosticCollector) {
    this.source = source;
    this.diagnostics = diagnostics;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    for (;;) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.kind === TokenKind.Eof) {
        break;
      }
    }

    return tokens;
  }

  private nextToken(): Token {
    this.skipTrivia();

    const start = this.location();

    if (this.isAtEnd()) {
      return this.makeToken(TokenKind.Eof, "", start);
    }

    const ch = this.advance();

    if (isAlpha(ch) || ch === "_") {
      return this.identifierOrKeyword(start);
    }

    if (ch === '"' || ch === "'") {
      return this.stringLiteral(ch, start);
    }

    switch (ch) {
      case "(":
        return this.makeToken(TokenKind.LParen, ch, start);
      case ")":
        return this.makeToken(TokenKind.RParen, ch, start);
      case "{":
        return this.makeToken(TokenKind.LBrace, ch, start);
      case "}":
        return this.makeToken(TokenKind.RBrace, ch, start);
      case ";":
        return this.makeToken(TokenKind.Semicolon, ch, start);
    }

    this.diagnostics.error(`Unexpected character '${ch}'`, span(start, this.location()), "E0001");
    return this.makeToken(TokenKind.Invalid, ch, start);
  }

  private identifierOrKeyword(start: SourceLocation): Token {
    while (!this.isAtEnd() && isAlphaNumeric(this.peek())) {
      this.advance();
    }

    const lexeme = this.source.slice(start.offset, this.offset);
    const kind = KEYWORDS.get(lexeme) ?? TokenKind.Identifier;
    return this.makeToken(kind, lexeme, start);
  }

  private stringLiteral(quote: string, start: SourceLocation): Token {
    let value = "";

    while (!this.isAtEnd() && this.peek() !== quote) {
      if (this.peek() === "\n") {
        this.line += 1;
        this.column = 0;
      }

      if (this.peek() === "\\") {
        this.advance();
        if (this.isAtEnd()) {
          break;
        }
        const escaped = this.advance();
        value += decodeEscape(escaped);
        continue;
      }

      value += this.advance();
    }

    if (this.isAtEnd()) {
      this.diagnostics.error("Unterminated string literal", span(start, this.location()), "E0002");
      const lexeme = this.source.slice(start.offset, this.offset);
      return this.makeToken(TokenKind.Invalid, lexeme, start);
    }

    this.advance(); // closing quote
    const lexeme = this.source.slice(start.offset, this.offset);
    return this.makeToken(TokenKind.String, lexeme, start, value);
  }

  private skipTrivia(): void {
    for (;;) {
      if (this.isAtEnd()) {
        return;
      }

      const ch = this.peek();

      if (ch === " " || ch === "\t" || ch === "\r") {
        this.advance();
        continue;
      }

      if (ch === "\n") {
        this.advance();
        this.line += 1;
        this.column = 1;
        continue;
      }

      if (ch === "/" && this.peekNext() === "/") {
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }

      if (ch === "/" && this.peekNext() === "*") {
        this.advance();
        this.advance();
        while (!this.isAtEnd()) {
          if (this.peek() === "*" && this.peekNext() === "/") {
            this.advance();
            this.advance();
            break;
          }
          if (this.peek() === "\n") {
            this.advance();
            this.line += 1;
            this.column = 1;
          } else {
            this.advance();
          }
        }
        continue;
      }

      return;
    }
  }

  private makeToken(
    kind: TokenKind,
    lexeme: string,
    start: SourceLocation,
    value?: string,
  ): Token {
    return {
      kind,
      lexeme,
      span: span(start, this.location()),
      ...(value !== undefined ? { value } : {}),
    };
  }

  private location(): SourceLocation {
    return { line: this.line, column: this.column, offset: this.offset };
  }

  private isAtEnd(): boolean {
    return this.offset >= this.source.length;
  }

  private peek(): string {
    return this.source[this.offset] ?? "\0";
  }

  private peekNext(): string {
    return this.source[this.offset + 1] ?? "\0";
  }

  private advance(): string {
    const ch = this.source[this.offset] ?? "\0";
    this.offset += 1;
    this.column += 1;
    return ch;
  }
}

function span(start: SourceLocation, end: SourceLocation): SourceSpan {
  return { start, end };
}

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlphaNumeric(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch) || ch === "_";
}

function decodeEscape(ch: string): string {
  switch (ch) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "\\":
      return "\\";
    case '"':
      return '"';
    case "'":
      return "'";
    case "0":
      return "\0";
    default:
      return ch;
  }
}
