import { describe, expect, it } from "vitest";
import { emptySemanticModel } from "@sonite/compiler";
import {
  positionToOffset,
  spanToRange,
  toCompletionItems,
  toLspDiagnostics,
} from "../src/protocol.js";

describe("LSP protocol helpers", () => {
  it("converts 1-based spans to 0-based ranges", () => {
    expect(
      spanToRange({
        start: { line: 2, column: 5, offset: 10 },
        end: { line: 2, column: 8, offset: 13 },
      }),
    ).toEqual({
      start: { line: 1, character: 4 },
      end: { line: 1, character: 7 },
    });
  });

  it("maps positions to offsets", () => {
    const source = "ab\ncd\nef";
    expect(positionToOffset(source, { line: 1, character: 1 })).toBe(4);
  });

  it("filters diagnostics to the requested file", () => {
    const diags = toLspDiagnostics(
      [
        {
          severity: "error",
          message: "a",
          file: "/a.sn",
          code: "E0001",
          span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 2, offset: 1 },
          },
        },
        {
          severity: "error",
          message: "b",
          file: "/b.sn",
        },
      ],
      "/a.sn",
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe("E0001");
  });

  it("maps completion kinds", () => {
    const items = toCompletionItems([
      { name: "foo", detail: "i32", kind: "variable" },
      { name: "bar", detail: "fn", kind: "function" },
      { name: "let", detail: "keyword", kind: "keyword" },
    ]);
    expect(items.map((i) => i.label)).toEqual(["foo", "bar", "let"]);
  });

  it("attaches additionalTextEdits for auto-import items", () => {
    const source = `function main(): void {
  abs
}
`;
    const semantic = emptySemanticModel([
      {
        path: "/proj/main.sn",
        source,
        ast: {
          kind: "Program",
          span: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 3, column: 2, offset: source.length },
          },
          body: [],
        },
        moduleId: "main",
        isEntry: true,
        imports: [],
      },
    ]);
    const items = toCompletionItems(
      [
        {
          name: "abs",
          detail: 'Auto import from "std/math"',
          kind: "function",
          autoImport: { moduleSpecifier: "std/math", exportName: "abs" },
        },
      ],
      "abs",
      { line: 1, character: 5 },
      { source, semantic, filePath: "/proj/main.sn" },
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.additionalTextEdits).toBeDefined();
    expect(items[0]!.additionalTextEdits![0]!.newText).toContain(
      'import { abs } from "std/math"',
    );
  });
});
