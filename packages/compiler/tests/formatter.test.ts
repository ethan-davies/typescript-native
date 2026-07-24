import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSource } from "../src/format/format.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "formatter");

function listFixtureDirs(): string[] {
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

describe("formatter golden fixtures", () => {
  for (const name of listFixtureDirs()) {
    it(name, () => {
      const dir = join(fixturesRoot, name);
      const input = readFileSync(join(dir, "input.sn"), "utf8");
      const expected = readFileSync(join(dir, "output.sn"), "utf8");
      const first = formatSource(input, { fileName: `${name}/input.sn` });
      expect(first.success, first.diagnostics.map((d) => d.message).join("\n")).toBe(
        true,
      );
      expect(first.code).toBe(expected);

      const second = formatSource(expected, { fileName: `${name}/output.sn` });
      expect(second.success).toBe(true);
      expect(second.code).toBe(expected);
    });
  }
});

/** Run with UPDATE_FIXTURES=1 to regenerate output.sn files. */
if (process.env.UPDATE_FIXTURES === "1") {
  for (const name of listFixtureDirs()) {
    const dir = join(fixturesRoot, name);
    const input = readFileSync(join(dir, "input.sn"), "utf8");
    const result = formatSource(input, { fileName: `${name}/input.sn` });
    if (!result.success || result.code === null) {
      throw new Error(
        `Failed to format ${name}: ${result.diagnostics.map((d) => d.message).join("; ")}`,
      );
    }
    writeFileSync(join(dir, "output.sn"), result.code, "utf8");
    console.log(`updated ${name}/output.sn`);
  }
}
