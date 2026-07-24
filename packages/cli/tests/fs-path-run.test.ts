import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNativeBindingAvailable } from "@sonite/llvm";
import { compileLinkAndRun } from "../src/native.js";

describe.runIf(isNativeBindingAvailable())("fs/path cross-platform", () => {
  it(
    "join/normalize/exists/read/write work on host platform",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "sn-fs-"));
      const src = join(dir, "fs_path.sn");
      const data = join(dir, "data.txt").replace(/\\/g, "\\\\");
      writeFileSync(
        src,
        `
import { join, normalize, isAbsolute, basename } from "std/fs";
import { writeFile, readFile, exists, deleteFile } from "std/fs";
import { platform } from "std/os";

function main(): void {
  console.log(platform());
  let p = join("a", "b");
  console.log(normalize(p));
  console.log(basename(p));
  let abs = isAbsolute("/");
  console.log(abs);
  writeFile("${data}", "ok");
  console.log(exists("${data}"));
  console.log(readFile("${data}"));
  deleteFile("${data}");
}
`,
        "utf8",
      );
      try {
        const code = await compileLinkAndRun(src, []);
        expect(code).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
