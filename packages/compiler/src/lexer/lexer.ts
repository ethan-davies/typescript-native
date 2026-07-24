import type { DiagnosticCollector, SourceLocation, SourceSpan } from "../diagnostics/diagnostic.js";
import type { SourceComment } from "./comments.js";
import { KEYWORDS, TokenKind, type Token } from "./tokens.js";

export class Lexer {
  private readonly source: string;
  private readonly diagnostics: DiagnosticCollector;
  private offset = 0;
  private line = 1;
  private column = 1;
  /** >0 while lexing inside a `${ ... }` expression of a template literal. */
  private templateExprDepth = 0;
  private readonly comments: SourceComment[] = [];

  constructor(source: string, diagnostics: DiagnosticCollector) {
    this.source = source;
    this.diagnostics = diagnostics;
  }

  tokenize(): Token[] {
    return this.tokenizeWithComments().tokens;
  }

  /** Tokenize and also collect comments discarded from the token stream. */
  tokenizeWithComments(): { tokens: Token[]; comments: SourceComment[] } {
    this.comments.length = 0;
    const tokens: Token[] = [];

    for (;;) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.kind === TokenKind.Eof) {
        break;
      }
    }

    return { tokens, comments: [...this.comments] };
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

    if (isDigit(ch)) {
      return this.numberLiteral(start);
    }

    if (ch === '"') {
      return this.stringLiteral(start);
    }

    if (ch === "'") {
      return this.charLiteral(start);
    }

    if (ch === "`") {
      return this.templateLiteral(start, /*continuation*/ false);
    }

    switch (ch) {
      case "(":
        return this.makeToken(TokenKind.LParen, ch, start);
      case ")":
        return this.makeToken(TokenKind.RParen, ch, start);
      case "{":
        if (this.templateExprDepth > 0) {
          this.templateExprDepth += 1;
        }
        return this.makeToken(TokenKind.LBrace, ch, start);
      case "}":
        if (this.templateExprDepth > 0) {
          this.templateExprDepth -= 1;
          if (this.templateExprDepth === 0) {
            return this.templateLiteral(start, /*continuation*/ true);
          }
        }
        return this.makeToken(TokenKind.RBrace, ch, start);
      case "[":
        return this.makeToken(TokenKind.LBracket, ch, start);
      case "]":
        return this.makeToken(TokenKind.RBracket, ch, start);
      case ";":
        return this.makeToken(TokenKind.Semicolon, ch, start);
      case ":":
        return this.makeToken(TokenKind.Colon, ch, start);
      case ",":
        return this.makeToken(TokenKind.Comma, ch, start);
      case ".":
        return this.makeToken(TokenKind.Dot, ch, start);
      case "+":
        if (this.peek() === "+") {
          this.advance();
          return this.makeToken(TokenKind.PlusPlus, "++", start);
        }
        if (this.peek() === "=") {
          this.advance();
          return this.makeToken(TokenKind.PlusEqual, "+=", start);
        }
        return this.makeToken(TokenKind.Plus, ch, start);
      case "-":
        if (this.peek() === "-") {
          this.advance();
          return this.makeToken(TokenKind.MinusMinus, "--", start);
        }
        if (this.peek() === "=") {
          this.advance();
          return this.makeToken(TokenKind.MinusEqual, "-=", start);
        }
        return this.makeToken(TokenKind.Minus, ch, start);
      case "*":
        return this.makeToken(TokenKind.Star, ch, start);
      case "/":
        return this.makeToken(TokenKind.Slash, ch, start);
      case "%":
        return this.makeToken(TokenKind.Percent, ch, start);
      case "=":
        if (this.peek() === "=") {
          this.advance();
          return this.makeToken(TokenKind.EqualEqual, "==", start);
        }
        if (this.peek() === ">") {
          this.advance();
          return this.makeToken(TokenKind.Arrow, "=>", start);
        }
        return this.makeToken(TokenKind.Equal, ch, start);
      case "!":
        if (this.peek() === "=") {
          this.advance();
          return this.makeToken(TokenKind.BangEqual, "!=", start);
        }
        return this.makeToken(TokenKind.Bang, ch, start);
      case "<":
        if (this.peek() === "=") {
          this.advance();
          return this.makeToken(TokenKind.LessEqual, "<=", start);
        }
        return this.makeToken(TokenKind.Less, ch, start);
      case ">":
        if (this.peek() === "=") {
          this.advance();
          return this.makeToken(TokenKind.GreaterEqual, ">=", start);
        }
        return this.makeToken(TokenKind.Greater, ch, start);
      case "&":
        if (this.peek() === "&") {
          this.advance();
          return this.makeToken(TokenKind.AmpAmp, "&&", start);
        }
        return this.makeToken(TokenKind.Amp, ch, start);
      case "|":
        if (this.peek() === "|") {
          this.advance();
          return this.makeToken(TokenKind.PipePipe, "||", start);
        }
        return this.makeToken(TokenKind.Pipe, ch, start);
      case "?":
        if (this.peek() === "?") {
          this.advance();
          return this.makeToken(TokenKind.QuestionQuestion, "??", start);
        }
        if (this.peek() === ".") {
          this.advance();
          return this.makeToken(TokenKind.QuestionDot, "?.", start);
        }
        return this.makeToken(TokenKind.Question, ch, start);
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

  private numberLiteral(start: SourceLocation): Token {
    while (!this.isAtEnd() && isDigit(this.peek())) {
      this.advance();
    }

    if (this.peek() === "." && isDigit(this.peekNext())) {
      this.advance(); // '.'
      while (!this.isAtEnd() && isDigit(this.peek())) {
        this.advance();
      }
      const lexeme = this.source.slice(start.offset, this.offset);
      return this.makeToken(TokenKind.Float, lexeme, start);
    }

    const lexeme = this.source.slice(start.offset, this.offset);
    return this.makeToken(TokenKind.Integer, lexeme, start);
  }

  private stringLiteral(start: SourceLocation): Token {
    let value = "";

    while (!this.isAtEnd() && this.peek() !== '"') {
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

  /**
   * Scan a template literal segment.
   * - continuation=false: just consumed opening backtick
   * - continuation=true: just consumed the `}` that closed `${...}`
   */
  private templateLiteral(start: SourceLocation, continuation: boolean): Token {
    let value = "";

    while (!this.isAtEnd()) {
      if (this.peek() === "`") {
        this.advance();
        const lexeme = this.source.slice(start.offset, this.offset);
        if (continuation) {
          return this.makeToken(TokenKind.TemplateTail, lexeme, start, value);
        }
        return this.makeToken(TokenKind.TemplateNoSub, lexeme, start, value);
      }

      if (this.peek() === "$" && this.peekNext() === "{") {
        this.advance(); // $
        this.advance(); // {
        this.templateExprDepth = 1;
        const lexeme = this.source.slice(start.offset, this.offset);
        if (continuation) {
          return this.makeToken(TokenKind.TemplateMiddle, lexeme, start, value);
        }
        return this.makeToken(TokenKind.TemplateHead, lexeme, start, value);
      }

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

    this.diagnostics.error(
      "Unterminated template literal",
      span(start, this.location()),
      "E0002",
    );
    const lexeme = this.source.slice(start.offset, this.offset);
    return this.makeToken(TokenKind.Invalid, lexeme, start);
  }

  private charLiteral(start: SourceLocation): Token {
    if (this.isAtEnd()) {
      this.diagnostics.error("Unterminated character literal", span(start, this.location()), "E0002");
      return this.makeToken(TokenKind.Invalid, "'", start);
    }

    let value = "";
    if (this.peek() === "\\") {
      this.advance();
      if (this.isAtEnd()) {
        this.diagnostics.error("Unterminated character literal", span(start, this.location()), "E0002");
        const lexeme = this.source.slice(start.offset, this.offset);
        return this.makeToken(TokenKind.Invalid, lexeme, start);
      }
      value = decodeEscape(this.advance());
    } else if (this.peek() === "'") {
      this.diagnostics.error("Empty character literal", span(start, this.location()), "E0003");
      this.advance();
      const lexeme = this.source.slice(start.offset, this.offset);
      return this.makeToken(TokenKind.Invalid, lexeme, start);
    } else if (this.peek() === "\n") {
      this.diagnostics.error("Unterminated character literal", span(start, this.location()), "E0002");
      const lexeme = this.source.slice(start.offset, this.offset);
      return this.makeToken(TokenKind.Invalid, lexeme, start);
    } else {
      value = this.advance();
    }

    if (this.isAtEnd() || this.peek() !== "'") {
      this.diagnostics.error(
        "Character literal must contain exactly one character",
        span(start, this.location()),
        "E0003",
      );
      while (!this.isAtEnd() && this.peek() !== "'" && this.peek() !== "\n") {
        this.advance();
      }
      if (this.peek() === "'") {
        this.advance();
      }
      const lexeme = this.source.slice(start.offset, this.offset);
      return this.makeToken(TokenKind.Invalid, lexeme, start);
    }

    this.advance(); // closing quote
    const lexeme = this.source.slice(start.offset, this.offset);
    return this.makeToken(TokenKind.Char, lexeme, start, value);
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
        const start = this.location();
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        const text = this.source.slice(start.offset, this.offset);
        this.comments.push({
          kind: "line",
          text,
          span: span(start, this.location()),
        });
        continue;
      }

      if (ch === "/" && this.peekNext() === "*") {
        const start = this.location();
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
        const text = this.source.slice(start.offset, this.offset);
        this.comments.push({
          kind: "block",
          text,
          span: span(start, this.location()),
        });
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
    case "`":
      return "`";
    case "0":
      return "\0";
    default:
      return ch;
  }
}
