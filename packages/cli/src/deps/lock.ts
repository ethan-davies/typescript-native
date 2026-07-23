import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ProjectError } from "../project.js";

export interface LockPackage {
  readonly name: string;
  readonly version: string;
  readonly checksum: string;
}

export interface Lockfile {
  readonly packages: readonly LockPackage[];
}

export function lockfilePath(projectRoot: string): string {
  return join(projectRoot, "sn.lock");
}

export function loadLockfile(projectRoot: string): Lockfile | null {
  const path = lockfilePath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = parseToml(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const list = raw.package;
    if (list === undefined) {
      return { packages: [] };
    }
    const entries = Array.isArray(list) ? list : [list];
    const packages: LockPackage[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        throw new ProjectError("sn.lock: invalid [[package]] entry");
      }
      const row = entry as Record<string, unknown>;
      if (
        typeof row.name !== "string" ||
        typeof row.version !== "string" ||
        typeof row.checksum !== "string"
      ) {
        throw new ProjectError(
          "sn.lock: each package needs name, version, checksum strings",
        );
      }
      packages.push({
        name: row.name,
        version: row.version,
        checksum: row.checksum,
      });
    }
    return { packages };
  } catch (error) {
    if (error instanceof ProjectError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`failed to parse sn.lock: ${message}`);
  }
}

export function writeLockfile(
  projectRoot: string,
  packages: readonly LockPackage[],
): void {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  const body = stringifyToml({
    package: sorted.map((p) => ({
      name: p.name,
      version: p.version,
      checksum: p.checksum,
    })),
  });
  writeFileSync(
    lockfilePath(projectRoot),
    body.endsWith("\n") ? body : `${body}\n`,
    "utf8",
  );
}

export function lockPackageMap(
  lock: Lockfile | null,
): Map<string, LockPackage> {
  const map = new Map<string, LockPackage>();
  if (!lock) {
    return map;
  }
  for (const pkg of lock.packages) {
    map.set(pkg.name, pkg);
  }
  return map;
}
