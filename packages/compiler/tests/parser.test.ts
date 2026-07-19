import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import { Lexer } from "../src/lexer/index.js";
import { Parser } from "../src/parser/index.js";

function parse(source: string) {
  const diagnostics = new DiagnosticCollector();
  const tokens = new Lexer(source, diagnostics).tokenize();
  const ast = new Parser(tokens, diagnostics).parse();
  return { ast, diagnostics };
}

describe("Parser", () => {
  it("parses main with a print statement", () => {
    const { ast, diagnostics } = parse(`
      function main() {
        print("hi");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body).toHaveLength(1);
    expect(ast.body[0]?.name.name).toBe("main");
    expect(ast.body[0]?.body).toHaveLength(1);

    const call = ast.body[0]?.body[0]?.expression;
    expect(call?.kind).toBe("CallExpression");
    expect(call?.callee.name).toBe("print");
    expect(call?.args[0]).toMatchObject({
      kind: "StringLiteral",
      value: "hi",
    });
  });

  it("parses multiple print statements", () => {
    const { ast, diagnostics } = parse(`
      function main() {
        print("one");
        print("two");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body[0]?.body).toHaveLength(2);
  });

  it("parses an empty main body", () => {
    const { ast, diagnostics } = parse("function main() {}");
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body[0]?.body).toEqual([]);
  });

  it("rejects non-print statements", () => {
    const { diagnostics } = parse(`
      function main() {
        foo("x");
      }
    `);
    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0102")).toBe(true);
  });

  it("rejects missing parentheses", () => {
    const { diagnostics } = parse("function main { print(\"x\"); }");
    expect(diagnostics.hasErrors).toBe(true);
  });
});
