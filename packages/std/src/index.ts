import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the SN standard library source root (`packages/std/src`). */
export function getStdRoot(): string {
  return join(packageRoot, "src");
}

/** Absolute paths of prelude `.sn` modules loaded into every compilation unit. */
export function getPreludePaths(): readonly string[] {
  const root = getStdRoot();
  return [
    join(root, "prelude", "string.sn"),
    join(root, "prelude", "array.sn"),
    join(root, "prelude", "io.sn"),
  ];
}
