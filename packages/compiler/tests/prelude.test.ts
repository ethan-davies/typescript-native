import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import { Lexer, TokenKind } from "../src/lexer/index.js";
import { Parser } from "../src/parser/index.js";

describe("extern and extension methods", () => {
  it("parses extern functions and this receivers", () => {
    const source = `
      extern function tsn_str_contains(haystack: string, needle: string): bool;
      export function contains(this: string, needle: string): bool {
        return tsn_str_contains(this, needle);
      }
      function main(): void {}
    `;
    const diagnostics = new DiagnosticCollector();
    const ast = new Parser(new Lexer(source, diagnostics).tokenize(), diagnostics).parse();
    expect(diagnostics.hasErrors).toBe(false);
    const ext = ast.body.find(
      (d) => d.kind === "FunctionDeclaration" && d.name.name === "contains",
    );
    expect(ext?.kind).toBe("FunctionDeclaration");
    if (ext?.kind === "FunctionDeclaration") {
      expect(ext.isExtern).toBe(false);
      expect(ext.params[0]?.isReceiver).toBe(true);
    }
    const externDecl = ast.body.find(
      (d) => d.kind === "FunctionDeclaration" && d.name.name === "tsn_str_contains",
    );
    expect(externDecl?.kind).toBe("FunctionDeclaration");
    if (externDecl?.kind === "FunctionDeclaration") {
      expect(externDecl.isExtern).toBe(true);
      expect(externDecl.body).toBeNull();
    }
  });

  it("lexes the extern keyword", () => {
    const diagnostics = new DiagnosticCollector();
    const tokens = new Lexer("extern function f(): void;", diagnostics).tokenize();
    expect(tokens[0]?.kind).toBe(TokenKind.Extern);
  });

  it("compiles prelude string and array methods without imports", () => {
    const result = compile(`
      function main(): void {
        print("hello".contains("h"));
        let numbers: i32[] = [1, 2, 3];
        let doubled = numbers.map((x) => x * 2);
        print(doubled);
        numbers.push(4);
        print(numbers.includes(4));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("tsn_str_contains");
    expect(result.ir).toContain("tsn_array_push");
  });
});
