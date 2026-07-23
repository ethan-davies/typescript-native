import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileFile } from "../src/compiler.js";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import {
  moduleIdFromPath,
  moduleIdentityForPath,
  resolveImportSpecifier,
  resolveModules,
  resolveSpecifierDetailed,
  setPackageRootsProvider,
} from "../src/modules/index.js";

describe("module resolution", () => {
  afterEach(() => {
    setPackageRootsProvider(null);
  });

  it("resolves relative imports with ./ and index.sn", () => {
    const dir = "/proj";
    expect(resolveImportSpecifier(dir, "./math")).toBe("/proj/math.sn");
    expect(resolveImportSpecifier(dir, "./math.sn")).toBe("/proj/math.sn");
    expect(resolveImportSpecifier(dir, "./math/vector")).toBe(
      "/proj/math/vector.sn",
    );
    expect(resolveImportSpecifier(dir, "../utils/helper")).toBe(
      "/utils/helper.sn",
    );
  });

  it("does not treat bare names as relative", () => {
    const result = resolveSpecifierDetailed("/proj", "math");
    expect(result.kind).toBe("package");
    expect(result.failure).toBe("not_installed");
  });

  it("resolves bare package names and subpaths from registered roots", () => {
    const root = mkdtempSync(join(tmpdir(), "sn-pkg-resolve-"));
    const pkgDir = join(root, "hello");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(
      join(pkgDir, "project.toml"),
      `[package]\nname = "hello"\nversion = "1.0.0"\nentry = "src/main.sn"\n`,
      "utf8",
    );
    writeFileSync(
      join(pkgDir, "src", "main.sn"),
      `export function greet(): void {}\n`,
      "utf8",
    );
    writeFileSync(
      join(pkgDir, "src", "util.sn"),
      `export function helper(): void {}\n`,
      "utf8",
    );

    setPackageRootsProvider(
      () =>
        new Map([
          ["hello", { dir: pkgDir, version: "1.0.0" }],
        ]),
    );
    expect(resolveImportSpecifier("/proj", "hello")).toBe(
      join(pkgDir, "src", "main.sn"),
    );
    expect(resolveImportSpecifier("/proj", "hello/src/util")).toBe(
      join(pkgDir, "src", "util.sn"),
    );
    expect(moduleIdentityForPath(join(pkgDir, "src", "main.sn"))).toBe(
      "sonite://package/hello@1.0.0",
    );
    expect(moduleIdentityForPath(join(pkgDir, "src", "util.sn"))).toBe(
      "sonite://package/hello@1.0.0/src/util",
    );

    const escape = resolveSpecifierDetailed("/proj", "hello/../secret");
    expect(escape.failure).toBe("package_escape");
  });

  it("reports package not installed", () => {
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.sn",
      (path) => {
        if (path === "/proj/main.sn") {
          return `import { x } from "missing-pkg";\nfunction main(): void {}\n`;
        }
        throw new Error(`ENOENT: ${path}`);
      },
      diagnostics,
    );
    expect(result.success).toBe(false);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0409")).toBe(true);
  });

  it("derives module ids from file basenames", () => {
    expect(moduleIdFromPath("/proj/math.sn")).toBe("math");
    expect(moduleIdFromPath("/proj/math/vector.sn")).toBe("vector");
  });

  it("resolves a module graph with aliases", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.sn",
        `import "./math";
import "./math/vector" as v;
function main(): void {
  print(math.add(1, 2));
  print(v.add(3, 4));
}
`,
      ],
      [
        "/proj/math.sn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
      [
        "/proj/math/vector.sn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
    ]);

    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.sn",
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
    expect(entry?.path).toBe("/proj/main.sn");
    expect(entry?.identity).toBe("file:///proj/main.sn");
    expect(entry?.imports).toEqual([
      expect.objectContaining({
        kind: "namespace",
        alias: "math",
        modulePath: "/proj/math.sn",
      }),
      expect.objectContaining({
        kind: "namespace",
        alias: "v",
        modulePath: "/proj/math/vector.sn",
      }),
    ]);
  });

  it("resolves named imports and explicit namespace imports", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.sn",
        `import * as math from "./math";
import { add as sum, mul } from "./math";
function main(): void {
  print(math.add(1, 2));
  print(sum(3, 4));
  print(mul(5, 6));
}
`,
      ],
      [
        "/proj/math.sn",
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
      "/proj/main.sn",
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
        specifier: "./math",
      }),
      expect.objectContaining({
        kind: "named",
        exportName: "mul",
        localName: "mul",
        specifier: "./math",
      }),
    ]);
  });

  it("reports duplicate import bindings", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.sn",
        `import "./math";
import { add as math } from "./math";
function main(): void {}
`,
      ],
      [
        "/proj/math.sn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
    ]);
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.sn",
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
      "/proj/main.sn",
      (path) => {
        if (path === "/proj/main.sn") {
          return `import "./missing";\nfunction main(): void {}\n`;
        }
        throw new Error(`ENOENT: ${path}`);
      },
      diagnostics,
    );
    expect(result.success).toBe(false);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0401")).toBe(true);
  });

  it("detects circular imports with cycle path", () => {
    const files = new Map<string, string>([
      [
        "/proj/a.sn",
        `import "./b";\nexport function a(): i32 { return 1; }\n`,
      ],
      [
        "/proj/b.sn",
        `import "./a";\nexport function b(): i32 { return 2; }\n`,
      ],
    ]);
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/a.sn",
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
    expect(
      diagnostics.diagnostics.some((d) => d.message.includes("→")),
    ).toBe(true);
  });

  it("resolves re-exports and export *", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.sn",
        `import { User, Post } from "./models";
function main(): void {
  let u = User { name: "a" };
  let p = Post { title: "t" };
  print(u.name);
  print(p.title);
}
`,
      ],
      [
        "/proj/models/index.sn",
        `export { User } from "./user";
export * from "./post";
`,
      ],
      [
        "/proj/models/user.sn",
        `export struct User {
  name: string;
}
`,
      ],
      [
        "/proj/models/post.sn",
        `export struct Post {
  title: string;
}
`,
      ],
    ]);

    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.sn",
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
    expect(result.modules.length).toBeGreaterThanOrEqual(4);
  });

  it("reports export * name collisions", () => {
    const files = new Map<string, string>([
      [
        "/proj/main.sn",
        `import { User } from "./barrel";
function main(): void {}
`,
      ],
      [
        "/proj/barrel.sn",
        `export * from "./a";
export * from "./b";
`,
      ],
      ["/proj/a.sn", `export struct User { x: i32; }\n`],
      ["/proj/b.sn", `export struct User { y: i32; }\n`],
    ]);
    const result = compileFile("/proj/main.sn", {
      readFile: (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
    });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0414")).toBe(true);
  });
});
