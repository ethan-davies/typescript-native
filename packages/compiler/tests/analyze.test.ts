import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  buildExportIndex,
  codeActionsAt,
  completionsAt,
  computeNamedImportEdit,
  definitionAt,
  documentSymbolsForFile,
  encodeSemanticTokens,
  hoverAt,
  referencesAt,
  renameAt,
  semanticTokensForFile,
  signatureHelpAt,
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

describe("references, rename, signature help, code actions, tokens", () => {
  it("finds local and shadowed references with includeDeclaration", () => {
    const source = `const value = 1;
function main(): void {
  const value = 2;
  print(value);
}
function other(): void {
  print(value);
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    expect(result.success).toBe(true);

    const outerDecl = source.indexOf("const value = 1") + "const ".length;
    const withDecl = referencesAt(result.semantic, path, outerDecl, {
      includeDeclaration: true,
    });
    const withoutDecl = referencesAt(result.semantic, path, outerDecl, {
      includeDeclaration: false,
    });
    expect(withDecl.length).toBeGreaterThanOrEqual(2);
    expect(withoutDecl.length).toBe(withDecl.length - 1);

    const innerDecl = source.indexOf("const value = 2") + "const ".length;
    const innerRefs = referencesAt(result.semantic, path, innerDecl, {
      includeDeclaration: true,
    });
    // Inner value must not include the outer module declaration.
    expect(
      innerRefs.every((r) => r.span.start.offset !== outerDecl),
    ).toBe(true);
  });

  it("finds cross-file and imported symbol references", () => {
    const root = writeTempProject({
      "main.sn": `import { greet } from "./a";
function main(): void {
  greet();
}
`,
      "a.sn": `export function greet(): void {
  print(1);
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const use = source.indexOf("greet();");
    const refs = referencesAt(result.semantic, path, use, {
      includeDeclaration: true,
    });
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs.some((r) => r.file.endsWith("a.sn"))).toBe(true);
  });

  it("renames locally and detects conflicts", () => {
    const source = `function greet(name: string): void {
  print(name);
}
function main(): void {
  greet("Ethan");
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const offset = source.indexOf("greet(");
    const renamed = renameAt(result.semantic, path, offset, "sayHello");
    expect(renamed.error).toBeUndefined();
    expect(renamed.edits.length).toBeGreaterThanOrEqual(2);
    expect(renamed.edits.every((e) => e.newText === "sayHello")).toBe(true);

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
    const conflict = renameAt(result2.semantic, path2, fooOff, "bar");
    expect(conflict.error).toBeDefined();
  });

  it("renames across files for imported symbols", () => {
    const root = writeTempProject({
      "a.sn": `export function greet(): void {
  print(1);
}
`,
      "b.sn": `import { greet } from "./a";
function main(): void {
  greet();
}
`,
    });
    const path = join(root, "b.sn");
    const result = analyzeFile(path);
    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const offset = source.indexOf("greet();");
    const renamed = renameAt(result.semantic, path, offset, "sayHello");
    expect(renamed.error).toBeUndefined();
    expect(renamed.edits.some((e) => e.file.endsWith("a.sn"))).toBe(true);
    expect(renamed.edits.some((e) => e.file.endsWith("b.sn"))).toBe(true);
  });

  it("provides signature help with active parameter and nested calls", () => {
    const source = `function fetchRequest(url: string, options: i32): void {
  print(url);
}
function main(): void {
  fetchRequest("a", 1);
  fetchRequest(foo(bar(1)), 2);
}
function foo(x: i32): string {
  return "x";
}
function bar(x: i32): i32 {
  return x;
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const firstCall = source.indexOf('fetchRequest("a"') + "fetchRequest(".length;
    const help = signatureHelpAt(result.semantic, path, firstCall, source);
    expect(help).not.toBeNull();
    expect(help!.signatures[0]?.parameters.length).toBe(2);
    expect(help!.activeParameter).toBe(0);

    const secondArg =
      source.indexOf('fetchRequest("a", 1)') + 'fetchRequest("a", '.length;
    const help2 = signatureHelpAt(result.semantic, path, secondArg, source);
    expect(help2?.activeParameter).toBe(1);

    const nested = source.indexOf("bar(1)") + "bar(".length;
    const helpNested = signatureHelpAt(result.semantic, path, nested, source);
    expect(helpNested).not.toBeNull();
    expect(helpNested!.signatures[0]?.label).toContain("bar");
  });

  it("warns on unused imports and offers code actions", () => {
    const root = writeTempProject({
      "main.sn": `import { used, unused } from "./lib";
function main(): void {
  used();
}
`,
      "lib.sn": `export function used(): void {
  print(1);
}
export function unused(): void {
  print(2);
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const unused = result.diagnostics.filter((d) => d.code === "E0412");
    expect(unused.some((d) => d.message.includes("unused"))).toBe(true);

    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const actions = codeActionsAt(result.semantic, path, source, {
      diagnostics: result.diagnostics,
    });
    expect(
      actions.some((a) => a.title.includes("Remove unused import")),
    ).toBe(true);
    expect(actions.some((a) => a.kind === "source.organizeImports")).toBe(true);
  });

  it("offers add-missing-import code action", () => {
    const root = writeTempProject({
      "main.sn": `function main(): void {
  helper(1);
}
`,
      "util.sn": `export function helper(x: i32): i32 {
  return x;
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const exportIndex = buildExportIndex({
      importerPath: path,
      workspaceRoots: [root],
    });
    const source = result.semantic.modules.find((m) => m.path === path)!.source;
    const actions = codeActionsAt(result.semantic, path, source, {
      diagnostics: result.diagnostics,
      exportIndex,
    });
    expect(
      actions.some((a) => a.title.includes("Import 'helper'")),
    ).toBe(true);
  });

  it("aliases auto-imports that would conflict with locals", () => {
    const source = `function helper(): void {
  print(1);
}
function main(): void {
  print(1);
}
`;
    const root = writeTempProject({
      "main.sn": source,
      "util.sn": `export function helper(x: i32): i32 {
  return x;
}
`,
    });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const edit = computeNamedImportEdit(
      source,
      result.semantic.modules.find((m) => m.path === path)!.ast,
      "./util",
      "helper",
    );
    expect(edit?.newText).toMatch(/helper as helper\d/);
  });

  it("emits semantic tokens for declarations and shadowed symbols", () => {
    const source = `const value = 1;
function main(): void {
  const value = 2;
  print(value);
}
function other(): void {
  print(value);
}
`;
    const root = writeTempProject({ "main.sn": source });
    const path = join(root, "main.sn");
    const result = analyzeFile(path);
    const tokens = semanticTokensForFile(result.semantic, path);
    expect(tokens.length).toBeGreaterThan(0);
    const encoded = encodeSemanticTokens(tokens);
    expect(encoded.length % 5).toBe(0);
    expect(encoded.length).toBeGreaterThan(0);

    const valueInfo = [...result.semantic.symbolInfo.values()].filter(
      (s) => s.name === "value" && s.location.file === path,
    );
    expect(valueInfo.length).toBeGreaterThanOrEqual(2);
    expect(valueInfo.every((s) => s.modifiers.includes("readonly"))).toBe(true);
  });
});
