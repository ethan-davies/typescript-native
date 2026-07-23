import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function getRuntimeLibraryPath(): string {
  const libraryPath = join(packageRoot, "dist", "libsn_runtime.a");
  if (!existsSync(libraryPath)) {
    throw new Error(
      "Runtime library not found. Build @sonite/runtime first (pnpm --filter @sonite/runtime build).",
    );
  }
  return libraryPath;
}

export function getRuntimeIncludePath(): string {
  return join(packageRoot, "include");
}
