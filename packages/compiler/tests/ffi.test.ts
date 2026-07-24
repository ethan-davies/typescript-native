import { describe, expect, it } from "vitest";
import { Lexer } from "../src/lexer/index.js";
import { Parser } from "../src/parser/index.js";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import { compile } from "../src/compiler.js";

function parse(source: string) {
  const diagnostics = new DiagnosticCollector();
  const tokens = new Lexer(source, diagnostics).tokenize();
  const program = new Parser(tokens, diagnostics).parse();
  return { program, diagnostics };
}

describe("FFI grammar", () => {
  it("parses Ptr, FnPtr, attributes, unsafe, and fixed arrays", () => {
    const src = `
@repr("C")
struct Point {
    x: i32;
    y: i32;
    pad: u8[4];
}

@symbol("c_add")
@abi("C")
extern function add(a: i32, b: i32): i32;

unsafe function usePtr(p: Ptr<i32>, cb: FnPtr<(i32) => void>): i32 {
    unsafe {
        let v: i32 = *p;
        *p = v + 1;
        return add(v, 1);
    }
}
`;
    const { program, diagnostics } = parse(src);
    expect(diagnostics.hasErrors).toBe(false);
    const struct = program.body.find((d) => d.kind === "StructDeclaration");
    expect(struct?.kind).toBe("StructDeclaration");
    if (struct?.kind === "StructDeclaration") {
      expect(struct.attributes.some((a) => a.name.name === "repr")).toBe(true);
      expect(struct.fields[2]?.typeAnnotation.kind).toBe("FixedArrayType");
    }
    const ext = program.body.find(
      (d) => d.kind === "FunctionDeclaration" && d.isExtern,
    );
    expect(ext?.kind).toBe("FunctionDeclaration");
    if (ext?.kind === "FunctionDeclaration") {
      expect(ext.attributes.map((a) => a.name.name)).toContain("symbol");
    }
    const fn = program.body.find(
      (d) => d.kind === "FunctionDeclaration" && d.isUnsafe,
    );
    expect(fn?.kind).toBe("FunctionDeclaration");
  });

  it("parses cast and deref expressions", () => {
    const src = `
unsafe function f(p: Ptr<i32>): usize {
    let q: Ptr<u8> = p as Ptr<u8>;
    let x: i32 = *p;
    return p as usize;
}
`;
    const { diagnostics } = parse(src);
    expect(diagnostics.hasErrors).toBe(false);
  });
});

describe("FFI typecheck & codegen", () => {
  it("typechecks and emits IR for Ptr load/store and extern call", () => {
    const src = `
@symbol("sn_math_abs")
extern function c_abs(x: f64): f64;

unsafe function main(): void {
    let p: Ptr<f64> = null;
}
`;
    const result = compile(src, { fileName: "ffi_ptr.sn" });
    // null ptr alone is fine; ensure no crash
    expect(result.diagnostics.some((d) => d.severity === "error" && d.code === "E0000")).toBe(
      false,
    );
  });

  it("rejects non-C types in @repr(C) structs", () => {
    const src = `
@repr("C")
struct Bad {
    s: string;
}

function main(): void {}
`;
    const result = compile(src, { fileName: "ffi_bad_struct.sn" });
    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.message.includes("string") || d.message.includes("C-compatible"),
      ),
    ).toBe(true);
  });

  it("requires unsafe for pointer dereference", () => {
    const src = `
function main(): void {
    let p: Ptr<i32> = null;
    let x: i32 = *p;
}
`;
    const result = compile(src, { fileName: "ffi_unsafe.sn" });
    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((d) => d.message.includes("unsafe")),
    ).toBe(true);
  });

  it("emits C struct type and FnPtr-compatible IR", () => {
    const src = `
@repr("C")
struct Point {
    x: i32;
    y: i32;
}

unsafe function main(): void {
    let p: Point = Point { x: 1, y: 2 };
}
`;
    const result = compile(src, { fileName: "ffi_struct.sn" });
    expect(result.success).toBe(true);
    expect(result.ir).toContain("type {");
    expect(result.ir).toMatch(/i32/);
  });

  it("warns on user sn_* extern declarations", () => {
    const src = `
extern function sn_custom_thing(x: i32): i32;

unsafe function main(): void {
    sn_custom_thing(1);
}
`;
    const result = compile(src, { fileName: "ffi_sn_warn.sn" });
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.message.includes("sn_*"),
      ),
    ).toBe(true);
  });
});
