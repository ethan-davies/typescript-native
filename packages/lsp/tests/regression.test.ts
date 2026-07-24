import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  buildExportIndex,
  codeActionsAt,
  completionsAt,
  definitionAt,
  documentSymbolsForFile,
  hoverAt,
  mergeReferences,
  referencesAt,
  renameAt,
  semanticTokensForFile,
  signatureHelpAt,
} from "@sonite/compiler";
import {
  analyzeWithOverlay,
  collectReverseDeps,
  completionsAtPosition,
  hoverAtPosition,
  replaceReverseDepsForResult,
  toCompletionItems,
} from "../src/protocol.js";

function writeTempProject(files: Record<string, string>): string {
  const root = join(
    tmpdir(),
    `sn-lsp-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  for (const [rel, source] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

describe("LSP feature regression", () => {
  it("covers core features on a small multi-file project", () => {
    const root = writeTempProject({
      "lib.sn": `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      "main.sn": `import { add } from "./lib";
function main(): void {
  add(1, 2);
}
`,
    });
    try {
      const path = join(root, "main.sn");
      const result = analyzeFile(path);
      const source = result.semantic.modules.find((m) => m.path === path)!
        .source;
      const use = source.indexOf("add(1");
      expect(hoverAt(result.semantic, path, use)).not.toBeNull();
      expect(definitionAt(result.semantic, path, use)).not.toBeNull();
      expect(
        referencesAt(result.semantic, path, use, { includeDeclaration: true })
          .length,
      ).toBeGreaterThan(0);
      expect(completionsAt(result.semantic, path, use, source).items.length).toBeGreaterThan(
        0,
      );
      expect(documentSymbolsForFile(result.semantic, path).length).toBeGreaterThan(
        0,
      );
      expect(
        signatureHelpAt(result.semantic, path, use + 4, source),
      ).not.toBeNull();
      expect(semanticTokensForFile(result.semantic, path).length).toBeGreaterThan(
        0,
      );
      const exportIndex = buildExportIndex({
        importerPath: path,
        workspaceRoots: [root],
      });
      expect(
        codeActionsAt(result.semantic, path, source, {
          diagnostics: result.diagnostics,
          exportIndex,
        }).length,
      ).toBeGreaterThanOrEqual(0);
      const renamed = renameAt(result.semantic, path, use, "sum");
      expect(renamed.error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles aliased imports and shadowing", () => {
    const root = writeTempProject({
      "lib.sn": `export function value(): i32 {
  return 1;
}
`,
      "main.sn": `import { value as libValue } from "./lib";
const value = 2;
function main(): void {
  print(value);
  print(libValue());
}
`,
    });
    try {
      const path = join(root, "main.sn");
      const result = analyzeFile(path);
      const source = result.semantic.modules.find((m) => m.path === path)!
        .source;
      const local = source.indexOf("const value") + "const ".length;
      const refs = referencesAt(result.semantic, path, local, {
        includeDeclaration: true,
      });
      expect(refs.every((r) => r.file.endsWith("main.sn"))).toBe(true);
      expect(refs.some((r) => r.span.start.offset === local)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("invalid / incomplete code resilience", () => {
  const snippets = [
    "function foo(",
    "const x =",
    "import {",
    "if (",
    "const x: UnknownType = 1;",
  ];

  for (const source of snippets) {
    it(`does not throw on: ${JSON.stringify(source)}`, () => {
      const root = writeTempProject({ "main.sn": `${source}\n` });
      try {
        const path = join(root, "main.sn");
        expect(() => analyzeFile(path)).not.toThrow();
        const result = analyzeFile(path);
        expect(() =>
          completionsAt(result.semantic, path, source.length, source),
        ).not.toThrow();
        expect(() => hoverAt(result.semantic, path, 0)).not.toThrow();
        expect(() =>
          hoverAtPosition(result.semantic, path, source, {
            line: 0,
            character: 0,
          }),
        ).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("mutation / reverse-deps updates", () => {
  it("prunes reverse deps when imports shrink and finds workspace refs", () => {
    const root = writeTempProject({
      "lib.sn": `export function greet(): void {
  print(1);
}
`,
      "main.sn": `import { greet } from "./lib";
function main(): void {
  greet();
}
`,
    });
    try {
      const lib = join(root, "lib.sn");
      const main = join(root, "main.sn");
      const reverse = new Map<string, Set<string>>();
      const mainResult = analyzeFile(main);
      replaceReverseDepsForResult(reverse, mainResult, main);
      expect(reverse.get(lib)?.has(main)).toBe(true);

      writeFileSync(
        main,
        `function main(): void {
  print(1);
}
`,
      );
      const overlay = {
        getDocument(path: string): string | undefined {
          if (path === main) {
            return `function main(): void {
  print(1);
}
`;
          }
          return undefined;
        },
      };
      const updated = analyzeWithOverlay(main, overlay);
      replaceReverseDepsForResult(reverse, updated, main);
      expect(reverse.get(lib)?.has(main) ?? false).toBe(false);

      // Restore import and verify workspace refs from definition file.
      writeFileSync(
        main,
        `import { greet } from "./lib";
function main(): void {
  greet();
}
`,
      );
      const libResult = analyzeFile(lib);
      const importer = analyzeFile(main);
      const libSource = libResult.semantic.modules.find((m) => m.path === lib)!
        .source;
      const decl = libSource.indexOf("greet");
      const def = definitionAt(libResult.semantic, lib, decl);
      expect(def).not.toBeNull();
      const locs = mergeReferences(
        [libResult.semantic, importer.semantic],
        def!,
        { includeDeclaration: true },
      );
      expect(locs.some((l) => l.file.endsWith("main.sn"))).toBe(true);
      expect(collectReverseDeps(importer).get(lib)?.has(main)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("auto-import completion items include additionalTextEdits", () => {
    const root = writeTempProject({
      "util.sn": `export function helper(): void {
  print(1);
}
`,
      "main.sn": `function main(): void {
  hel
}
`,
    });
    try {
      const path = join(root, "main.sn");
      const result = analyzeFile(path);
      const source = result.semantic.modules.find((m) => m.path === path)!
        .source;
      const exportIndex = buildExportIndex({
        importerPath: path,
        workspaceRoots: [root],
      });
      const items = completionsAtPosition(
        result.semantic,
        path,
        source,
        { line: 1, character: 5 },
        exportIndex,
        [root],
      );
      const helper = items.find((i) => i.label === "helper");
      expect(helper?.additionalTextEdits?.length).toBeGreaterThan(0);
      expect(
        toCompletionItems(
          [
            {
              name: "helper",
              detail: "x",
              kind: "function",
              autoImport: {
                moduleSpecifier: "./util",
                exportName: "helper",
              },
            },
          ],
          "hel",
          { line: 1, character: 5 },
          { source, semantic: result.semantic, filePath: path },
        )[0]?.additionalTextEdits?.length,
      ).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
