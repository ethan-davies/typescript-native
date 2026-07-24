import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  applyDiagnosticsConfig,
  codeActionsAt,
  compile,
  formatRange,
  formatSource,
  parseDiagnosticsSection,
  promoteWarningsAsErrors,
  resolveDiagnosticsConfig,
} from "../src/index.js";

describe("diagnostics config", () => {
  it("parses [diagnostics] levels", () => {
    const config = parseDiagnosticsSection(`
[diagnostics]
unused_variables = "error"
unreachable_code = "off"
`);
    expect(config.unusedVariables).toBe("error");
    expect(config.unreachableCode).toBe("off");
    expect(config.unusedImports).toBe("warn");
  });

  it("remaps and suppresses configurable codes", () => {
    const remapped = applyDiagnosticsConfig(
      [
        {
          severity: "warning",
          message: "'x' is declared but never used",
          code: "E0414",
        },
        {
          severity: "warning",
          message: "Unreachable code",
          code: "E0416",
        },
      ],
      resolveDiagnosticsConfig({
        unusedVariables: "error",
        unreachableCode: "off",
      }),
    );
    expect(remapped).toHaveLength(1);
    expect(remapped[0]?.severity).toBe("error");
    expect(remapped[0]?.code).toBe("E0414");
  });

  it("promotes warnings to errors", () => {
    const promoted = promoteWarningsAsErrors([
      { severity: "warning", message: "w", code: "E0412" },
      { severity: "error", message: "e", code: "E0301" },
    ]);
    expect(promoted.every((d) => d.severity === "error")).toBe(true);
  });
});

describe("unused and unreachable diagnostics", () => {
  it("warns on unused locals and parameters", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-unused-"));
    try {
      writeFileSync(
        join(dir, "main.sn"),
        `function main(): void {
  const unused = 123;
  const _ok = 1;
  print("hi");
}

function greet(name: string, _ignored: i32): void {
  print("x");
}
`,
      );
      const result = analyzeFile(join(dir, "main.sn"));
      const unusedVars = result.diagnostics.filter((d) => d.code === "E0414");
      const unusedParams = result.diagnostics.filter((d) => d.code === "E0415");
      expect(unusedVars.some((d) => d.message.includes("unused"))).toBe(true);
      expect(unusedVars.some((d) => d.message.includes("_ok"))).toBe(false);
      expect(unusedParams.some((d) => d.message.includes("name"))).toBe(true);
      expect(unusedParams.some((d) => d.message.includes("_ignored"))).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on unreachable code after return", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-unreach-"));
    try {
      writeFileSync(
        join(dir, "main.sn"),
        `function main(): void {
  return;
  print("never");
}
`,
      );
      const result = analyzeFile(join(dir, "main.sn"));
      expect(
        result.diagnostics.some(
          (d) => d.code === "E0416" && d.message.includes("Unreachable"),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers remove unused variable code action when safe", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-action-"));
    try {
      const file = join(dir, "main.sn");
      const source = `function main(): void {
  const unused = 123;
  print("hi");
}
`;
      writeFileSync(file, source);
      const result = analyzeFile(file);
      const actions = codeActionsAt(result.semantic, file, source, {
        diagnostics: result.diagnostics,
      });
      expect(
        actions.some((a) => a.title.includes("Remove unused variable")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors warningsAsErrors on compile", () => {
    const source = `function main(): void {
  const unused = 1;
  print("x");
}
`;
    const ok = compile(source);
    expect(ok.success).toBe(true);
    expect(ok.diagnostics.some((d) => d.code === "E0414")).toBe(true);

    const fail = compile(source, { warningsAsErrors: true });
    expect(fail.success).toBe(false);
    expect(fail.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("does not warn when a function-typed parameter is called", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-fn-call-"));
    try {
      writeFileSync(
        join(dir, "main.sn"),
        `function apply(fn: (i32) => i32, x: i32): i32 {
  return fn(x);
}

function main(): void {
  print(apply((n: i32): i32 => n + 1, 1));
}
`,
      );
      const result = analyzeFile(join(dir, "main.sn"));
      expect(
        result.diagnostics.some(
          (d) => d.code === "E0415" && d.message.includes("'fn'"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not warn when an imported class is used via a static method", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-static-import-"));
    try {
      writeFileSync(
        join(dir, "lib.sn"),
        `export class Foo {
  static bar(): i32 {
    return 1;
  }
}
`,
      );
      writeFileSync(
        join(dir, "main.sn"),
        `import { Foo } from "./lib";

function main(): void {
  print(Foo.bar());
}
`,
      );
      const result = analyzeFile(join(dir, "main.sn"));
      expect(
        result.diagnostics.some(
          (d) => d.code === "E0412" && d.message.includes("Foo"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not warn when an imported interface is used in implements", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-implements-import-"));
    try {
      writeFileSync(
        join(dir, "lib.sn"),
        `export interface Greeter {
  greet(): void;
}
`,
      );
      writeFileSync(
        join(dir, "main.sn"),
        `import { Greeter } from "./lib";

class Hello implements Greeter {
  greet(): void {
    print("hi");
  }
}

function main(): void {
  let h = new Hello();
  h.greet();
}
`,
      );
      const result = analyzeFile(join(dir, "main.sn"));
      expect(
        result.diagnostics.some(
          (d) => d.code === "E0412" && d.message.includes("Greeter"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("format recovery and range", () => {
  it("formats incomplete constructs without inventing closers", () => {
    const cases = [
      "function greet(",
      "const user =",
      "import {",
      "function test<T>(",
    ];
    for (const source of cases) {
      const result = formatSource(source);
      expect(result.success).toBe(true);
      expect(result.code).not.toBeNull();
      const once = result.code!;
      const twice = formatSource(once);
      expect(twice.code).toBe(once);
    }
  });

  it("formats a selected range without rewriting unrelated code", () => {
    const source = `function foo(): void {
    const x=1;
    const y = 2;
}
`;
    const start = source.indexOf("const x");
    const end = source.indexOf(";\n", start) + 1;
    const result = formatRange(source, { startOffset: start, endOffset: end });
    expect(result.success).toBe(true);
    expect(result.edit).not.toBeNull();
    const edited =
      source.slice(0, result.edit!.startOffset) +
      result.edit!.newText +
      source.slice(result.edit!.endOffset);
    expect(edited).toContain("const y = 2");
    expect(edited.indexOf("const y = 2")).toBeGreaterThan(
      edited.indexOf("const x"),
    );
  });
});
