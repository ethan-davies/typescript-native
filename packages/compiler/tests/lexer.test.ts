import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import { Lexer, TokenKind } from "../src/lexer/index.js";

function lex(source: string) {
  const diagnostics = new DiagnosticCollector();
  const tokens = new Lexer(source, diagnostics).tokenize();
  return { tokens, diagnostics };
}

describe("Lexer", () => {
  it("tokenizes an empty source as EOF", () => {
    const { tokens, diagnostics } = lex("");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.kind).toBe(TokenKind.Eof);
    expect(diagnostics.hasErrors).toBe(false);
  });

  it("tokenizes a hello-world program", () => {
    const { tokens, diagnostics } = lex(`
      function main() {
        print("Hello, world!");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Function,
      TokenKind.Identifier,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.LBrace,
      TokenKind.Identifier,
      TokenKind.LParen,
      TokenKind.String,
      TokenKind.RParen,
      TokenKind.Semicolon,
      TokenKind.RBrace,
      TokenKind.Eof,
    ]);
    expect(tokens[1]?.lexeme).toBe("main");
    expect(tokens[5]?.lexeme).toBe("print");
    expect(tokens[7]?.value).toBe("Hello, world!");
  });

  it("decodes string escape sequences", () => {
    const { tokens, diagnostics } = lex(`"a\\nb\\t\\"c"`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens[0]?.kind).toBe(TokenKind.String);
    expect(tokens[0]?.value).toBe('a\nb\t"c');
  });

  it("skips line and block comments", () => {
    const { tokens, diagnostics } = lex(`
      // line comment
      function /* block */ main() {}
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Function,
      TokenKind.Identifier,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.LBrace,
      TokenKind.RBrace,
      TokenKind.Eof,
    ]);
  });

  it("tracks source locations", () => {
    const { tokens } = lex("a\nb");
    expect(tokens[0]?.span.start).toEqual({ line: 1, column: 1, offset: 0 });
    expect(tokens[1]?.span.start).toEqual({ line: 2, column: 1, offset: 2 });
  });

  it("reports unexpected characters", () => {
    const { tokens, diagnostics } = lex("@");
    expect(diagnostics.hasErrors).toBe(true);
    expect(tokens[0]?.kind).toBe(TokenKind.Invalid);
    expect(diagnostics.diagnostics[0]?.code).toBe("E0001");
  });
});
