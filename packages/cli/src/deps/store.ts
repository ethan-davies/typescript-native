import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getPackagesStoreDir } from "../config.js";

/** Map of `name@version` → absolute project roots that depend on it. */
export type DependantsIndex = Record<string, string[]>;

export function packageVersionKey(name: string, version: string): string {
  return `${name}@${version}`;
}

export function packageVersionDirName(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Absolute path: `<store>/<name>/<name>@<version>/`. */
export function packageVersionPath(name: string, version: string): string {
  return join(
    getPackagesStoreDir(),
    name,
    packageVersionDirName(name, version),
  );
}

function dependantsPath(): string {
  return join(getPackagesStoreDir(), "dependants.json");
}

export function loadDependants(): DependantsIndex {
  const path = dependantsPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    const out: DependantsIndex = {};
    for (const [key, value] of Object.entries(raw)) {
      if (
        Array.isArray(value) &&
        value.every((v) => typeof v === "string")
      ) {
        out[key] = [...new Set(value.map((p) => resolve(p)))].sort();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveDependants(index: DependantsIndex): void {
  mkdirSync(getPackagesStoreDir(), { recursive: true });
  const normalized: DependantsIndex = {};
  for (const key of Object.keys(index).sort()) {
    const deps = index[key];
    if (deps && deps.length > 0) {
      normalized[key] = [...new Set(deps.map((p) => resolve(p)))].sort();
    }
  }
  writeFileSync(
    dependantsPath(),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Register `projectRoot` as a dependant of `name@version`.
 * Returns the absolute install path for that version.
 */
export function addDependant(
  name: string,
  version: string,
  projectRoot: string,
): string {
  const key = packageVersionKey(name, version);
  const root = resolve(projectRoot);
  const index = loadDependants();
  const list = index[key] ?? [];
  if (!list.includes(root)) {
    list.push(root);
  }
  index[key] = list;
  saveDependants(index);
  return packageVersionPath(name, version);
}

/**
 * Unregister `projectRoot` from `name@version`.
 * If no dependants remain, deletes the cached package version (and empty name dir).
 */
export function removeDependant(
  name: string,
  version: string,
  projectRoot: string,
): void {
  const key = packageVersionKey(name, version);
  const root = resolve(projectRoot);
  const index = loadDependants();
  const list = (index[key] ?? []).filter((p) => p !== root);
  if (list.length === 0) {
    delete index[key];
    saveDependants(index);
    gcPackageVersion(name, version);
  } else {
    index[key] = list;
    saveDependants(index);
  }
}

/** Delete a cached version when it has no dependants. */
export function gcPackageVersion(name: string, version: string): void {
  const key = packageVersionKey(name, version);
  const index = loadDependants();
  if ((index[key] ?? []).length > 0) {
    return;
  }
  const dest = packageVersionPath(name, version);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  const nameDir = join(getPackagesStoreDir(), name);
  if (existsSync(nameDir)) {
    try {
      const remaining = readdirSync(nameDir);
      if (remaining.length === 0) {
        rmSync(nameDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

/**
 * If this project previously depended on a different version of `name`,
 * unregister that old version (and GC if unused).
 */
export function releasePreviousVersion(
  name: string,
  keepVersion: string | null,
  projectRoot: string,
): void {
  const root = resolve(projectRoot);
  const index = loadDependants();
  const prefix = `${name}@`;
  for (const key of Object.keys(index)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const version = key.slice(prefix.length);
    if (keepVersion !== null && version === keepVersion) {
      continue;
    }
    const list = index[key] ?? [];
    if (!list.includes(root)) {
      continue;
    }
    removeDependant(name, version, root);
  }
}

export function isPackageVersionInstalled(
  name: string,
  version: string,
): boolean {
  return existsSync(join(packageVersionPath(name, version), "project.toml"));
}
