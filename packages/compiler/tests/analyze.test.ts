import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  buildExportIndex,
  completionsAt,
  computeNamedImportEdit,
  definitionAt,
  documentSymbolsForFile,
  hoverAt,
} from "../src/index.js";

function writeTempProject(files: Record<string, string>): string {
  const root = join(
    tmpdir(),
    `sn-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  for (const [rel, source] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

describe("analyzeFile + semantic queries", () => {
  it("stamps diagnostics with file paths", () => {
    const root = writeTempProject({
      "main.sn": `import { add } from "./lib";
function main(): void {
  let x: i32 = "bad";
  print(add(1, 2));
}
`,
      "lib.sn": `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
    });

    const result = analyzeFile(join(root, "main.sn"));
    expect(result.success).toBe(false);
    const typed = result.diagnostics.filter((d) => d.file?.endsWith("main.sn"));
    expect(typed.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => typeof d.file === "string")).toBe(
      true,
    );
  });

  it("supports hover, definition, completion, and document symbols", () => {
    const source = `struct Point {
  x: i32;
  y: i32;
}

function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): void {
  let p = Point { x: 1, y: 2 };
  let n = add(p.x, p.y);
  print(n);
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    expect(result.success).toBe(true);

    const nDecl = source.indexOf("let n =") + "let ".length;
    const hover = hoverAt(result.semantic, path, nDecl);
    expect(hover?.contents).toBe("i32");

    const addUse = source.indexOf("add(p.x");
    const def = definitionAt(result.semantic, path, addUse);
    expect(def).not.toBeNull();
    expect(def!.file).toBe(path);
    expect(def!.span.start.line).toBe(6);

    const completions = completionsAt(
      result.semantic,
      path,
      source.indexOf("print(n)"),
    );
    expect(completions.items.some((i) => i.name === "add")).toBe(true);
    expect(completions.items.some((i) => i.name === "n")).toBe(true);

    const symbols = documentSymbolsForFile(result.semantic, path);
    expect(symbols.map((s) => s.name).sort()).toEqual(
      ["Point", "add", "main"].sort(),
    );
  });

  it("allows analyzing modules without main", () => {
    const root = writeTempProject({
      "lib.sn": `export function twice(x: i32): i32 {
  return x + x;
}
`,
    });
    const result = analyzeFile(join(root, "lib.sn"));
    expect(
      result.diagnostics.some((d) => d.code === "E0200" || d.code === "E0202"),
    ).toBe(false);
    expect(result.success).toBe(true);
  });

  it("attributes import resolution errors to the importing file", () => {
    const root = writeTempProject({
      "main.sn": `import { missing } from "./nope";
function main(): void {}
`,
    });
    const result = analyzeFile(join(root, "main.sn"));
    expect(result.success).toBe(false);
    const imp = result.diagnostics.find((d) => d.code === "E0401");
    expect(imp?.file?.endsWith("main.sn")).toBe(true);
  });

  it("completes builtins and keywords from a partial identifier", () => {
    const source = `function main(): void {
  prin
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const offset = source.indexOf("prin") + "prin".length;
    const completions = completionsAt(result.semantic, path, offset, source);
    expect(completions.items.some((i) => i.name === "print")).toBe(true);
  });

  it("completes members after a dot using the object type", () => {
    const source = `function main(): void {
  let s = "hi";
  s.
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const offset = source.indexOf("s.") + 2;
    const completions = completionsAt(result.semantic, path, offset, source);
    expect(completions.isMember).toBe(true);
    expect(completions.items.some((i) => i.name === "length")).toBe(true);
    expect(completions.items.some((i) => i.name === "contains")).toBe(true);
    expect(completions.items.find((i) => i.name === "contains")?.kind).toBe(
      "method",
    );
    expect(completions.items.find((i) => i.name === "length")?.kind).toBe(
      "property",
    );
  });

  it("uses distinct completion kinds for symbols and members", () => {
    const source = `struct Point {
  x: i32;
  y: i32;
}

function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): void {
  const n = 1;
  let p = Point { x: 1, y: 2 };
  p.
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);

    const top = completionsAt(
      result.semantic,
      path,
      source.indexOf("let p"),
      source,
    );
    expect(top.items.find((i) => i.name === "function")?.kind).toBe("keyword");
    expect(top.items.find((i) => i.name === "add")?.kind).toBe("function");
    expect(top.items.find((i) => i.name === "Point")?.kind).toBe("struct");
    expect(top.items.find((i) => i.name === "n")?.kind).toBe("constant");

    const members = completionsAt(
      result.semantic,
      path,
      source.indexOf("p.") + 2,
      source,
    );
    expect(members.items.find((i) => i.name === "x")?.kind).toBe("field");
  });

  it("hides prelude extension locals from top-level completions", () => {
    const source = `function main(): void {

}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const completions = completionsAt(
      result.semantic,
      path,
      source.indexOf("\n}") - 1,
      source,
    );
    expect(
      completions.items.some((i) => i.name.startsWith("__prelude_ext_")),
    ).toBe(false);
    expect(completions.items.find((i) => i.name === "function")?.kind).toBe(
      "keyword",
    );
    expect(completions.items.find((i) => i.name === "print")?.kind).toBe(
      "function",
    );
  });

  it("gives named imports the correct completion kind", () => {
    const root = writeTempProject({
      "main.sn": `import { add } from "./lib";
function main(): void {
  add
}
`,
      "lib.sn": `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const offset = source.indexOf("add\n") + 3;
    const completions = completionsAt(result.semantic, path, offset, source);
    expect(completions.items.find((i) => i.name === "add")?.kind).toBe(
      "function",
    );
  });

  it("resolves go-to-definition across namespace imports", () => {
    const root = writeTempProject({
      "main.sn": `import "./lib" as lib;

function main(): void {
  let result = lib.add(5, 10);
  print(result);
}
`,
      "lib.sn": `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
    });
    const mainPath = join(root, "main.sn");
    const libPath = join(root, "lib.sn");
    const result = analyzeFile(mainPath);
    expect(result.success).toBe(true);
    const source = result.semantic.modules.find(
      (m) => m.path === mainPath,
    )!.source;
    const addUse = source.indexOf("lib.add") + "lib.".length;
    const def = definitionAt(result.semantic, mainPath, addUse);
    expect(def).not.toBeNull();
    expect(def!.file).toBe(libPath);
    expect(def!.span.start.line).toBe(1);
  });

  it("completes namespace members after a dot", () => {
    const root = writeTempProject({
      "main.sn": `import "./lib" as lib;

function main(): void {
  lib.
}
`,
      "lib.sn": `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const offset = source.indexOf("lib.") + 4;
    const completions = completionsAt(result.semantic, path, offset, source);
    expect(completions.isMember).toBe(true);
    expect(completions.items.find((i) => i.name === "add")?.kind).toBe(
      "function",
    );
  });

  it("suggests auto-import completions from the export index", () => {
    const root = writeTempProject({
      "main.sn": `function main(): void {
  hel
}
`,
      "util.sn": `export function helper(x: i32): i32 {
  return x + 1;
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const exportIndex = buildExportIndex({
      importerPath: path,
      workspaceRoots: [root],
    });
    expect(exportIndex.some((e) => e.name === "helper")).toBe(true);

    const offset = source.indexOf("hel") + 3;
    const completions = completionsAt(result.semantic, path, offset, source, {
      exportIndex,
    });
    const helper = completions.items.find(
      (i) => i.name === "helper" && i.autoImport,
    );
    expect(helper).toBeDefined();
    expect(helper!.kind).toBe("function");
    expect(helper!.autoImport?.moduleSpecifier).toMatch(/util/);

    const edit = computeNamedImportEdit(
      source,
      result.semantic.modules.find((m) => m.path === path)!.ast,
      helper!.autoImport!.moduleSpecifier,
      "helper",
    );
    expect(edit).not.toBeNull();
    expect(edit!.newText).toContain("import { helper } from");
  });
});
