import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  buildExportIndex,
  buildImportGraph,
  completionsAt,
  definitionAt,
  listWorkspaceSnFiles,
  mergeReferences,
  referencesAt,
  renameAt,
} from "@sonite/compiler";

function writeProject(n: number): string {
  const root = join(
    tmpdir(),
    `sn-perf-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < n; i += 1) {
    const deps =
      i === 0
        ? ""
        : `import { f${i - 1} } from "./f${i - 1}";\n`;
    const body =
      i === 0
        ? `export function f0(): i32 {\n  return 0;\n}\n`
        : `export function f${i}(): i32 {\n  return f${i - 1}() + 1;\n}\n`;
    writeFileSync(join(root, `f${i}.sn`), `${deps}${body}`);
  }
  writeFileSync(
    join(root, "main.sn"),
    `import { f${n - 1} } from "./f${n - 1}";
function main(): void {
  print(f${n - 1}());
}
`,
  );
  return root;
}

function measure<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

describe("LSP / analysis performance harness", () => {
  it("benchmarks a 10-file project", () => {
    const root = writeProject(10);
    try {
      const files = listWorkspaceSnFiles([root]);
      expect(files.length).toBeGreaterThanOrEqual(10);

      const index = measure(() =>
        buildImportGraph({ workspaceRoots: [root] }),
      );
      const exportIdx = measure(() =>
        buildExportIndex({
          importerPath: join(root, "main.sn"),
          workspaceRoots: [root],
        }),
      );
      const analyze = measure(() => analyzeFile(join(root, "main.sn")));
      const path = join(root, "main.sn");
      const source = analyze.result.semantic.modules.find(
        (m) => m.path === path,
      )!.source;
      const use = source.indexOf(`f9()`);
      const def = measure(() =>
        definitionAt(analyze.result.semantic, path, use),
      );
      const refs = measure(() =>
        referencesAt(analyze.result.semantic, path, use, {
          includeDeclaration: true,
        }),
      );
      const rename = measure(() =>
        renameAt(analyze.result.semantic, path, use, "fNine"),
      );
      const completion = measure(() =>
        completionsAt(analyze.result.semantic, path, use, source, {
          exportIndex: exportIdx.result,
          workspaceRoots: [root],
        }),
      );

      // Soft budgets for CI (10-file should be fast).
      expect(index.ms).toBeLessThan(5_000);
      expect(exportIdx.ms).toBeLessThan(5_000);
      expect(analyze.ms).toBeLessThan(5_000);
      expect(def.ms).toBeLessThan(1_000);
      expect(refs.ms).toBeLessThan(1_000);
      expect(rename.ms).toBeLessThan(1_000);
      expect(completion.ms).toBeLessThan(1_000);
      expect(refs.result.length).toBeGreaterThan(0);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          size: 10,
          indexMs: Math.round(index.ms),
          exportMs: Math.round(exportIdx.ms),
          analyzeMs: Math.round(analyze.ms),
          defMs: Math.round(def.ms),
          refsMs: Math.round(refs.ms),
          renameMs: Math.round(rename.ms),
          completionMs: Math.round(completion.ms),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("benchmarks a 100-file project", () => {
    const root = writeProject(100);
    try {
      const index = measure(() =>
        buildImportGraph({ workspaceRoots: [root] }),
      );
      const analyze = measure(() => analyzeFile(join(root, "main.sn")));
      expect(index.ms).toBeLessThan(30_000);
      expect(analyze.ms).toBeLessThan(30_000);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          size: 100,
          indexMs: Math.round(index.ms),
          analyzeMs: Math.round(analyze.ms),
          edges: index.result.size,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("benchmarks a 1000-file project (indexing only)", () => {
    const root = writeProject(1000);
    try {
      const index = measure(() =>
        buildImportGraph({ workspaceRoots: [root] }),
      );
      expect(index.ms).toBeLessThan(120_000);
      expect(index.result.size).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          size: 1000,
          indexMs: Math.round(index.ms),
          edges: index.result.size,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("merges references across importer analyses without text false positives", () => {
    const root = writeProject(3);
    try {
      const lib = join(root, "f0.sn");
      const main = join(root, "main.sn");
      // Also import f0 from a sibling so reverse refs matter.
      writeFileSync(
        join(root, "other.sn"),
        `import { f0 } from "./f0";
function go(): void {
  print(f0());
}
`,
      );
      const libResult = analyzeFile(lib);
      const otherResult = analyzeFile(join(root, "other.sn"));
      const source = libResult.semantic.modules.find((m) => m.path === lib)!
        .source;
      const decl = source.indexOf("f0");
      const def = definitionAt(libResult.semantic, lib, decl)!;
      const refs = mergeReferences(
        [libResult.semantic, otherResult.semantic],
        def,
        { includeDeclaration: true },
      );
      expect(refs.some((r) => r.file.endsWith("other.sn"))).toBe(true);
      void main;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
