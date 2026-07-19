import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { encodeLlvmString } from "../src/codegen/llvm.js";

const helloSource = `
function main() {
  print("Hello, world!");
}
`;

describe("compile pipeline", () => {
  it("compiles hello world to LLVM IR with puts", () => {
    const result = compile(helloSource);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("declare i32 @puts");
    expect(result.ir).toContain("define i32 @main()");
    expect(result.ir).toContain("call i32 @puts");
    expect(result.ir).toContain(encodeLlvmString("Hello, world!"));
    expect(result.ast.body[0]?.name.name).toBe("main");
  });

  it("allows changing the printed string", () => {
    const result = compile(`
      function main() {
        print("changed");
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain(encodeLlvmString("changed"));
    expect(result.ir).not.toContain(encodeLlvmString("Hello, world!"));
  });

  it("emits multiple puts calls for multiple prints", () => {
    const result = compile(`
      function main() {
        print("a");
        print("b");
      }
    `);
    expect(result.success).toBe(true);
    const calls = result.ir?.match(/call i32 @puts/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("fails when main is missing", () => {
    const result = compile("");
    expect(result.success).toBe(false);
    expect(result.ir).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "E0200")).toBe(true);
  });

  it("fails when the function is not named main", () => {
    const result = compile(`
      function greet() {
        print("hi");
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0202")).toBe(true);
  });

  it("fails on non-print statements", () => {
    const result = compile(`
      function main() {
        other("x");
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0102")).toBe(true);
  });
});

describe("encodeLlvmString", () => {
  it("escapes non-printable bytes", () => {
    expect(encodeLlvmString("a\nb")).toBe("a\\0Ab");
    expect(encodeLlvmString('say "hi"')).toBe("say \\22hi\\22");
  });
});
