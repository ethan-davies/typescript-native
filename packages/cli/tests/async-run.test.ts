import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileLinkAndRun } from "../src/native.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const examples = join(repoRoot, "examples");

function clangAvailable(): boolean {
  const r = spawnSync("clang", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

describe.runIf(clangAvailable())("async sn run integration", () => {
  it(
    "runs async-sleep.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "async-sleep.sn"),
        [],
      );
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs async-concurrent.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "async-concurrent.sn"),
        [],
      );
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs async-tcp.sn",
    async () => {
      const code = await compileLinkAndRun(join(examples, "async-tcp.sn"), []);
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs async-udp.sn",
    async () => {
      const code = await compileLinkAndRun(join(examples, "async-udp.sn"), []);
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs async-dns.sn",
    async () => {
      const code = await compileLinkAndRun(join(examples, "async-dns.sn"), []);
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs async-tls.sn",
    async () => {
      const code = await compileLinkAndRun(join(examples, "async-tls.sn"), [], {
        cwd: repoRoot,
      });
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs http-server.sn",
    async () => {
      const code = await compileLinkAndRun(join(examples, "http-server.sn"), []);
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs http-handlers.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "http-handlers.sn"),
        [],
      );
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs json-stringify.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "json-stringify.sn"),
        [],
      );
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs https-server.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "https-server.sn"),
        [],
        { cwd: repoRoot },
      );
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs http-fetch.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "http-fetch.sn"),
        [],
      );
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    "runs async-roundtrip.sn",
    async () => {
      const code = await compileLinkAndRun(
        join(examples, "async-roundtrip.sn"),
        [],
      );
      expect(code).toBe(0);
    },
    30_000,
  );
});
