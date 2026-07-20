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
      function main(): void {
        print("Hello, world!");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Function,
      TokenKind.Identifier,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.Colon,
      TokenKind.Identifier,
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
    expect(tokens[5]?.lexeme).toBe("void");
    expect(tokens[7]?.lexeme).toBe("print");
    expect(tokens[9]?.value).toBe("Hello, world!");
  });

  it("tokenizes numbers, keywords, and operators", () => {
    const { tokens, diagnostics } = lex(
      `let x = 42; const pi = 3.14; true false return + - * / % , : =`,
    );
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Let,
      TokenKind.Identifier,
      TokenKind.Equal,
      TokenKind.Integer,
      TokenKind.Semicolon,
      TokenKind.Const,
      TokenKind.Identifier,
      TokenKind.Equal,
      TokenKind.Float,
      TokenKind.Semicolon,
      TokenKind.True,
      TokenKind.False,
      TokenKind.Return,
      TokenKind.Plus,
      TokenKind.Minus,
      TokenKind.Star,
      TokenKind.Slash,
      TokenKind.Percent,
      TokenKind.Comma,
      TokenKind.Colon,
      TokenKind.Equal,
      TokenKind.Eof,
    ]);
    expect(tokens[3]?.lexeme).toBe("42");
    expect(tokens[8]?.lexeme).toBe("3.14");
  });

  it("tokenizes comparison, logical, and if keywords", () => {
    const { tokens, diagnostics } = lex(
      `== != < > <= >= && || ! if else elseif`,
    );
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.EqualEqual,
      TokenKind.BangEqual,
      TokenKind.Less,
      TokenKind.Greater,
      TokenKind.LessEqual,
      TokenKind.GreaterEqual,
      TokenKind.AmpAmp,
      TokenKind.PipePipe,
      TokenKind.Bang,
      TokenKind.If,
      TokenKind.Else,
      TokenKind.ElseIf,
      TokenKind.Eof,
    ]);
  });

  it("tokenizes the struct keyword", () => {
    const { tokens, diagnostics } = lex(`struct Person { age: i32; }`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Struct,
      TokenKind.Identifier,
      TokenKind.LBrace,
      TokenKind.Identifier,
      TokenKind.Colon,
      TokenKind.Identifier,
      TokenKind.Semicolon,
      TokenKind.RBrace,
      TokenKind.Eof,
    ]);
  });

  it("tokenizes the enum keyword", () => {
    const { tokens, diagnostics } = lex(`enum Direction { Up, Down }`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Enum,
      TokenKind.Identifier,
      TokenKind.LBrace,
      TokenKind.Identifier,
      TokenKind.Comma,
      TokenKind.Identifier,
      TokenKind.RBrace,
      TokenKind.Eof,
    ]);
  });

  it("tokenizes loop keywords and update operators", () => {
    const { tokens, diagnostics } = lex(
      `while for break continue ++ -- += -=`,
    );
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.While,
      TokenKind.For,
      TokenKind.Break,
      TokenKind.Continue,
      TokenKind.PlusPlus,
      TokenKind.MinusMinus,
      TokenKind.PlusEqual,
      TokenKind.MinusEqual,
      TokenKind.Eof,
    ]);
  });

  it("tokenizes brackets, dot, and in keyword", () => {
    const { tokens, diagnostics } = lex(`i32[] numbers[0].push in`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Identifier,
      TokenKind.LBracket,
      TokenKind.RBracket,
      TokenKind.Identifier,
      TokenKind.LBracket,
      TokenKind.Integer,
      TokenKind.RBracket,
      TokenKind.Dot,
      TokenKind.Identifier,
      TokenKind.In,
      TokenKind.Eof,
    ]);
  });

  it("rejects single & and |", () => {
    const amp = lex("&");
    expect(amp.diagnostics.hasErrors).toBe(true);
    expect(amp.diagnostics.diagnostics[0]?.code).toBe("E0001");

    const pipe = lex("|");
    expect(pipe.diagnostics.hasErrors).toBe(true);
    expect(pipe.diagnostics.diagnostics[0]?.code).toBe("E0001");
  });

  it("tokenizes identifiers with underscores", () => {
    const { tokens, diagnostics } = lex(`_foo bar_baz`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens[0]).toMatchObject({ kind: TokenKind.Identifier, lexeme: "_foo" });
    expect(tokens[1]).toMatchObject({ kind: TokenKind.Identifier, lexeme: "bar_baz" });
  });

  it("keeps // as a line comment, not division", () => {
    const { tokens, diagnostics } = lex(`10 // comment\n/ 2`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Integer,
      TokenKind.Slash,
      TokenKind.Integer,
      TokenKind.Eof,
    ]);
  });

  it("tokenizes char literals separately from strings", () => {
    const { tokens, diagnostics } = lex(`'a' "b"`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens[0]?.kind).toBe(TokenKind.Char);
    expect(tokens[0]?.value).toBe("a");
    expect(tokens[1]?.kind).toBe(TokenKind.String);
    expect(tokens[1]?.value).toBe("b");
  });

  it("decodes string escape sequences", () => {
    const { tokens, diagnostics } = lex(`"a\\nb\\t\\"c"`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens[0]?.kind).toBe(TokenKind.String);
    expect(tokens[0]?.value).toBe('a\nb\t"c');
  });

  it("decodes char escape sequences", () => {
    const { tokens, diagnostics } = lex(`'\\n' '\\t' '\\''`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens[0]?.value).toBe("\n");
    expect(tokens[1]?.value).toBe("\t");
    expect(tokens[2]?.value).toBe("'");
  });

  it("skips line and block comments", () => {
    const { tokens, diagnostics } = lex(`
      // line comment
      function /* block */ main(): void {}
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Function,
      TokenKind.Identifier,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.Colon,
      TokenKind.Identifier,
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

  it("reports unterminated strings", () => {
    const { diagnostics } = lex(`"hello`);
    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0002")).toBe(true);
  });

  it("tokenizes import, export, and as keywords", () => {
    const { tokens, diagnostics } = lex(`import "math" as m; export function add(): i32 {}`);
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toEqual([
      TokenKind.Import,
      TokenKind.String,
      TokenKind.As,
      TokenKind.Identifier,
      TokenKind.Semicolon,
      TokenKind.Export,
      TokenKind.Function,
      TokenKind.Identifier,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.Colon,
      TokenKind.Identifier,
      TokenKind.LBrace,
      TokenKind.RBrace,
      TokenKind.Eof,
    ]);
    expect(tokens[1]?.value).toBe("math");
  });

  it("tokenizes interface and implements keywords", () => {
    const { tokens, diagnostics } = lex(
      `interface Drawable { draw(): void; } class C implements Drawable {}`,
    );
    expect(diagnostics.hasErrors).toBe(false);
    expect(tokens.map((t) => t.kind)).toContain(TokenKind.Interface);
    expect(tokens.map((t) => t.kind)).toContain(TokenKind.Implements);
  });
});
