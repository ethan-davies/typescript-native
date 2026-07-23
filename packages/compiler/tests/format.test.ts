import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSource } from "../src/format/format.js";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const examplesDir = join(repoRoot, "examples");

function assertIdempotent(source: string, fileName = "<test>"): string {
  const first = formatSource(source, { fileName });
  expect(first.success, formatFailure(first)).toBe(true);
  expect(first.code).not.toBeNull();
  const once = first.code!;

  const second = formatSource(once, { fileName });
  expect(second.success).toBe(true);
  expect(second.code).toBe(once);
  return once;
}

function formatFailure(result: {
  success: boolean;
  diagnostics: readonly { message: string }[];
}): string {
  return result.diagnostics.map((d) => d.message).join("\n") || "format failed";
}

describe("formatSource", () => {
  it("formats a minimal program", () => {
    const out = assertIdempotent(`function main():void{print("hi");}`);
    expect(out).toBe(`function main(): void {\n  print("hi");\n}\n`);
  });

  it("preserves parentheses needed for precedence", () => {
    const out = assertIdempotent(`function main(): void {
  let x = (1 + 2) * 3;
  print(x);
}
`);
    expect(out).toContain("(1 + 2) * 3");
  });

  it("formats control flow with elseif", () => {
    const out = assertIdempotent(`function main(): void {
  let age = 16;
  if (age < 13) {
    print("child");
  } elseif (age < 18) {
    print("teen");
  } else {
    print("adult");
  }
}
`);
    expect(out).toContain("} elseif (age < 18) {");
    expect(out).toContain("} else {");
  });

  it("formats imports and classes", () => {
    assertIdempotent(`import { add } from "math";

class Point {
  public x: i32;
  public y: i32;

  constructor(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  sum(): i32 {
    return this.x + this.y;
  }
}

function main(): void {
  let p = new Point(1, 2);
  print(p.sum());
  print(add(1, 2));
}
`);
  });

  it("formats generics and type aliases", () => {
    assertIdempotent(`type Pair<T> = [T, T];

struct Box<T> {
  value: T;
}

function identity<T>(x: T): T {
  return x;
}

function main(): void {
  let b = Box<i32> { value: 1 };
  print(identity<i32>(b.value));
}
`);
  });

  it("reports parse errors without rewriting", () => {
    const result = formatSource(`function main(: void {`);
    expect(result.success).toBe(false);
    expect(result.code).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  const exampleFiles = [
    "hello.sn",
    "variables.sn",
    "arithmetic.sn",
    "control-flow.sn",
    "loops.sn",
    "classes.sn",
  ];

  for (const name of exampleFiles) {
    it(`round-trips examples/${name}`, () => {
      const source = readFileSync(join(examplesDir, name), "utf8");
      assertIdempotent(source, name);
    });
  }
});
