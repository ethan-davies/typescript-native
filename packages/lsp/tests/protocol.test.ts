import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  emptySemanticModel,
  encodeSemanticTokens,
  semanticTokensForFile,
} from "@sonite/compiler";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponseError } from "vscode-languageserver/node.js";
import {
  collectReverseDeps,
  positionToOffset,
  renameAtPosition,
  semanticTokensAtFile,
  spanToRange,
  toCompletionItems,
  toLspDiagnostics,
} from "../src/protocol.js";

function writeTempProject(files: Record<string, string>): string {
  const root = join(
    tmpdir(),
    `sn-lsp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  for (const [rel, source] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

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
        identity: "file:///test/main.sn",
        isEntry: true,
        imports: [],
        reexportSources: [],
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

  it("builds WorkspaceEdit for rename and errors on conflict", () => {
    const source = `function greet(): void {
  print(1);
}
function main(): void {
  greet();
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const offset = source.indexOf("greet(");
    const line = source.slice(0, offset).split("\n").length - 1;
    const character = offset - (source.lastIndexOf("\n", offset - 1) + 1);
    const edit = renameAtPosition(
      result.semantic,
      path,
      source,
      { line, character },
      "sayHello",
    );
    expect(edit).not.toBeInstanceOf(ResponseError);
    if (edit instanceof ResponseError) {
      return;
    }
    expect(edit.changes).toBeDefined();
    const uris = Object.keys(edit.changes ?? {});
    expect(uris.length).toBeGreaterThanOrEqual(1);

    const conflictSource = `function main(): void {
  const foo = 1;
  const bar = 2;
  print(foo);
}
`;
    const root2 = writeTempProject({ "main.sn": conflictSource });
    const path2 = join(root2, "main.sn");
    const result2 = analyzeFile(path2);
    const fooOff = conflictSource.indexOf("foo");
    const fooLine = conflictSource.slice(0, fooOff).split("\n").length - 1;
    const fooChar =
      fooOff - (conflictSource.lastIndexOf("\n", fooOff - 1) + 1);
    const conflict = renameAtPosition(
      result2.semantic,
      path2,
      conflictSource,
      { line: fooLine, character: fooChar },
      "bar",
    );
    expect(conflict).toBeInstanceOf(ResponseError);
  });

  it("encodes semantic tokens and reverse deps", () => {
    const source = `function main(): void {
  const n = 1;
  print(n);
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const encoded = semanticTokensAtFile(result.semantic, path);
    expect(encoded.data.length % 5).toBe(0);
    expect(encoded.data.length).toBeGreaterThan(0);

    const tokens = semanticTokensForFile(result.semantic, path);
    expect(encodeSemanticTokens(tokens)).toEqual(encoded.data);

    const reverse = collectReverseDeps(result);
    expect(reverse).toBeInstanceOf(Map);
  });
});
