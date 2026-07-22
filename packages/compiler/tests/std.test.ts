import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileFile } from "../src/compiler.js";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import {
  getStdRootPath,
  moduleIdForStdPath,
  resolveImportSpecifier,
  resolveModules,
  resolveStdSpecifier,
  setStdRootProvider,
} from "../src/modules/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const examplesDir = join(repoRoot, "examples");
const stdSrc = join(repoRoot, "packages", "std", "src");

describe("std module resolution", () => {
  it("resolves std/math to packages/std/src/math/index.tsn", () => {
    const prev = getStdRootPath();
    setStdRootProvider(() => stdSrc);
    try {
      expect(resolveStdSpecifier("std/math")).toBe(join(stdSrc, "math", "index.tsn"));
      expect(resolveImportSpecifier("/proj", "std/math")).toBe(
        join(stdSrc, "math", "index.tsn"),
      );
      expect(moduleIdForStdPath(join(stdSrc, "math", "index.tsn"))).toBe("std_math");
      expect(moduleIdForStdPath(join(stdSrc, "collections", "index.tsn"))).toBe(
        "std_collections",
      );
    } finally {
      setStdRootProvider(prev === null ? null : () => prev);
    }
  });

  it("loads std/math through resolveModules", () => {
    setStdRootProvider(() => stdSrc);
    const diagnostics = new DiagnosticCollector();
    const result = resolveModules(
      "/proj/main.tsn",
      (path) => {
        if (path === "/proj/main.tsn") {
          return `import { sqrt } from "std/math";\nfunction main(): void { print(sqrt(4.0)); }\n`;
        }
        throw new Error(`ENOENT: ${path}`);
      },
      diagnostics,
    );
    expect(diagnostics.hasErrors).toBe(false);
    expect(result.success).toBe(true);
    expect(result.modules.some((m) => m.moduleId === "std_math")).toBe(true);
  });
});

describe("std library examples", () => {
  it("compiles std-math example", () => {
    const result = compileFile(join(examplesDir, "std-math.tsn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain("tsn_math_sqrt");
    expect(result.ir).toContain("tsn_math_sin");
  });

  it("compiles std-random example", () => {
    const result = compileFile(join(examplesDir, "std-random.tsn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain("tsn_random");
    expect(result.ir).toContain("tsn_random_int");
  });

  it("compiles std-collections example", () => {
    const result = compileFile(join(examplesDir, "std-collections.tsn"));
    expect(result.success).toBe(true);
  });

  it("exposes extended string and array methods via the prelude without imports", () => {
    const result = compileFile(join(examplesDir, "prelude.tsn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain("tsn_str_pad_start");
    expect(result.ir).toContain("tsn_str_index_of");
    expect(result.ir).toContain("tsn_str_join");
  });
});
