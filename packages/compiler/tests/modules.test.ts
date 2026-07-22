import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import {
  moduleIdFromPath,
  resolveImportSpecifier,
  resolveModules,
} from "../src/modules/index.js";

describe("module resolution", () => {
  it("normalizes import specifiers to .tsn paths", () => {
    const dir = "/proj";
    expect(resolveImportSpecifier(dir, "math")).toBe("/proj/math.tsn");
    expect(resolveImportSpecifier(dir, "./math")).toBe("/proj/math.tsn");
    expect(resolveImportSpecifier(dir, "math.tsn")).toBe("/proj/math.tsn");
    expect(resolveImportSpecifier(dir, "./math.tsn")).toBe("/proj/math.tsn");
    expect(resolveImportSpecifier(dir, "math/vector")).toBe("/proj/math/vector.tsn");
  });

  it("derives module ids from file basenames", () => {
    expect(moduleIdFromPath("/proj/math.tsn")).toBe("math");
    expect(moduleIdFromPath("/proj/math/vector.tsn")).toBe("vector");
  });

  it("resolves a module graph with aliases", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.tsn",
        `import "math";
import "math/vector" as v;
function main(): void {
  print(math.add(1, 2));
  print(v.add(3, 4));
}
`,
      ],
      [
        "/proj/math.tsn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
      [
        "/proj/math/vector.tsn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
    ]);

    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.tsn",
      (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
      diagnostics,
    );

    expect(diagnostics.hasErrors).toBe(false);
    expect(result.success).toBe(true);
    expect(result.modules).toHaveLength(3);
    const entry = result.modules.find((m) => m.isEntry);
    expect(entry?.path).toBe("/proj/main.tsn");
    expect(entry?.imports).toEqual([
      expect.objectContaining({
        kind: "namespace",
        alias: "math",
        modulePath: "/proj/math.tsn",
      }),
      expect.objectContaining({
        kind: "namespace",
        alias: "v",
        modulePath: "/proj/math/vector.tsn",
      }),
    ]);
  });

  it("resolves named imports and explicit namespace imports", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.tsn",
        `import * as math from "math";
import { add as sum, mul } from "math";
function main(): void {
  print(math.add(1, 2));
  print(sum(3, 4));
  print(mul(5, 6));
}
`,
      ],
      [
        "/proj/math.tsn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
export function mul(a: i32, b: i32): i32 {
  return a * b;
}
`,
      ],
    ]);

    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.tsn",
      (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
      diagnostics,
    );

    expect(diagnostics.hasErrors).toBe(false);
    expect(result.success).toBe(true);
    const entry = result.modules.find((m) => m.isEntry);
    expect(entry?.imports).toEqual([
      expect.objectContaining({ kind: "namespace", alias: "math" }),
      expect.objectContaining({
        kind: "named",
        exportName: "add",
        localName: "sum",
        specifier: "math",
      }),
      expect.objectContaining({
        kind: "named",
        exportName: "mul",
        localName: "mul",
        specifier: "math",
      }),
    ]);
  });

  it("reports duplicate import bindings", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.tsn",
        `import "math";
import { add as math } from "math";
function main(): void {}
`,
      ],
      [
        "/proj/math.tsn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
    ]);
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.tsn",
      (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
      diagnostics,
    );
    expect(result.success).toBe(false);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0404")).toBe(true);
  });

  it("reports missing modules", () => {
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.tsn",
      (path) => {
        if (path === "/proj/main.tsn") {
          return `import "missing";\nfunction main(): void {}\n`;
        }
        throw new Error(`ENOENT: ${path}`);
      },
      diagnostics,
    );
    expect(result.success).toBe(false);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0401")).toBe(true);
  });

  it("detects circular imports", () => {
    const files = new Map<string, string>([
      ["/proj/a.tsn", `import "b";\nexport function a(): i32 { return 1; }\n`],
      ["/proj/b.tsn", `import "a";\nexport function b(): i32 { return 2; }\n`],
    ]);
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/a.tsn",
      (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
      diagnostics,
    );
    expect(result.success).toBe(false);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0403")).toBe(true);
  });
});
