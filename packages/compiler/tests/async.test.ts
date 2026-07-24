import { compile, compileFile } from "../src/compiler.js";
import { DiagnosticCollector } from "../src/diagnostics/diagnostic.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("async/await", () => {
  it("parses and typechecks async main with await sleep", () => {
    const src = `
async function tick(): void {
  return;
}

async function main(): void {
  await tick();
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_future_new");
    expect(result.ir).toContain("sn_task_spawn");
    expect(result.ir).toContain("sn_event_loop_run");
    // Await now lowers to a stackless suspend point rather than a blocking drive.
    expect(result.ir).toContain("sn_task_await_suspend");
  });

  it("rejects await outside async", () => {
    const src = `
async function tick(): void {}

function main(): void {
  await tick();
}
`;
    const result = compile(src);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.some((e) => e.message.includes("await"))).toBe(true);
  });

  it("rejects assigning Future to non-Future", () => {
    const src = `
async function getN(): i32 {
  return 1;
}

async function main(): void {
  const x: i32 = getN();
}
`;
    const result = compile(src);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("types await as the inner type", () => {
    const src = `
async function getN(): i32 {
  return 42;
}

async function main(): void {
  const x: i32 = await getN();
  print(x);
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("infers spawn type args from Future argument", () => {
    const src = `
function spawn<T>(fut: Future<T>): Future<T> {
  return fut;
}

async function tick(): void {
  return;
}

async function main(): void {
  const a = spawn(tick());
  await a;
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("compiles examples/async-sleep.sn", () => {
    const result = compileFile(path.join(root, "examples/async-sleep.sn"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_timer_sleep_ms");
    expect(result.ir).toContain("sn_task_await_suspend");
  });

  it("compiles examples/async-concurrent.sn", () => {
    const result = compileFile(path.join(root, "examples/async-concurrent.sn"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_timer_sleep_ms");
    expect(result.ir).toContain("sn_task_spawn");
    expect(result.ir).toContain("sn_task_await_suspend");
  });

  it("emits await for expression statements", () => {
    const src = `
async function tick(): void {
  return;
}

async function main(): void {
  await tick();
  print("ok");
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const body = result.ir!.slice(
      result.ir!.indexOf("define void @main__async__body"),
      result.ir!.indexOf("define ptr @main__async()"),
    );
    // The task body suspends cooperatively at the await instead of blocking.
    expect(body).toContain("sn_task_await_suspend");
    expect(body).not.toContain("sn_future_await_run");
  });

  it("compiles examples/async-tcp.sn", () => {
    const result = compileFile(path.join(root, "examples/async-tcp.sn"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_tcp_listen");
    expect(result.ir).toContain("sn_tcp_accept");
    expect(result.ir).toContain("sn_tcp_connect");
    expect(result.ir).toContain("sn_task_await_suspend");
  });

  it("compiles try/catch across await with EH re-establish", () => {
    const src = `
extern function sn_sleep_ms(ms: i64): Future<void>;

unsafe async function boom(): i32 {
  await sn_sleep_ms(1);
  throw new Error("fail");
}

async function main(): void {
  try {
    const n = await boom();
    print(n);
  } catch (e) {
    print(e.message);
  }
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_task_await_suspend");
    expect(result.ir).toContain("sn_eh_pop_top");
    expect(result.ir).toContain("sn_future_fail");
    expect(result.ir).toContain("setjmp");
  });

  it("compiles nested async exception propagation IR", () => {
    const src = `
extern function sn_sleep_ms(ms: i64): Future<void>;

unsafe async function inner(): i32 {
  await sn_sleep_ms(1);
  throw new Error("inner");
}

async function outer(): i32 {
  try {
    return await inner();
  } catch (e) {
    throw e;
  }
}

async function main(): void {
  try {
    print(await outer());
  } catch (e) {
    print(e.message);
  }
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_future_fail");
    expect(result.ir).toContain("sn_throw");
  });

  it("compiles finally across await", () => {
    const src = `
extern function sn_sleep_ms(ms: i64): Future<void>;

unsafe async function main(): void {
  try {
    await sn_sleep_ms(1);
  } finally {
    print(1);
  }
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_task_await_suspend");
    expect(result.ir).toContain("sn_eh_pop");
  });

  it("compiles user ByteStream implementor", () => {
    const result = compileFile(path.join(root, "examples/bytestream-impl.sn"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("ByteStream");
    expect(result.ir).toContain("__itable");
  });

  it("spills interface fat pointers across await", () => {
    const src = `
interface S {
  async read(): i32;
  async close(): void;
}

class Mem implements S {
  async read(): i32 {
    return 7;
  }
  async close(): void {
  }
}

async function main(): void {
  let typed: S = new Mem();
  let n = await typed.read();
  print(n);
  await typed.close();
}
`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("sn_task_await_suspend");
  });

  it("compiles stdlib ByteStream implements via TlsStream module", () => {
    const result = compileFile(path.join(root, "examples/async-tls.sn"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toContain("ByteStream");
  });
});
