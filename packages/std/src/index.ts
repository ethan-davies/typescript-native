import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the TSN standard library source root (`packages/std/src`). */
export function getStdRoot(): string {
  return join(packageRoot, "src");
}

/** Absolute paths of prelude `.tsn` modules loaded into every compilation unit. */
export function getPreludePaths(): readonly string[] {
  const root = getStdRoot();
  return [
    join(root, "prelude", "string.tsn"),
    join(root, "prelude", "array.tsn"),
    join(root, "prelude", "io.tsn"),
  ];
}
