import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  setPackageRootsProvider,
  type PackageRootInfo,
} from "./resolve.js";

function defaultPackagesStoreDir(): string {
  return join(homedir(), ".config", "sonite", "packages");
}

function packageVersionPath(
  storeDir: string,
  name: string,
  version: string,
): string {
  return join(storeDir, name, `${name}@${version}`);
}

/**
 * Walk upward from `startDir` looking for `project.toml`.
 */
export function findProjectToml(
  startDir: string = process.cwd(),
): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "project.toml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Minimal project.lock reader: extract `name` / `version` pairs from
 * `[[package]]` tables. Sufficient for module resolution (exact versions).
 */
export function loadLockPackages(
  projectRoot: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const lockPath = join(projectRoot, "project.lock");
  const legacy = join(projectRoot, "sn.lock");
  const path = existsSync(lockPath)
    ? lockPath
    : existsSync(legacy)
      ? legacy
      : null;
  if (!path) {
    return out;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }

  let current: { name?: string; version?: string } | null = null;
  const flush = () => {
    if (current?.name && current.version) {
      out.set(current.name, current.version);
    }
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[[package]]") {
      flush();
      current = {};
      continue;
    }
    if (!current) {
      continue;
    }
    const nameMatch = trimmed.match(/^name\s*=\s*"([^"]+)"\s*$/);
    if (nameMatch?.[1]) {
      current.name = nameMatch[1];
      continue;
    }
    const versionMatch = trimmed.match(/^version\s*=\s*"([^"]+)"\s*$/);
    if (versionMatch?.[1]) {
      current.version = versionMatch[1];
    }
  }
  flush();
  return out;
}

/**
 * Discover installed package roots for a project from its lockfile + global store.
 */
export function discoverPackageRootsForProject(
  startDir: string,
  storeDir: string = defaultPackagesStoreDir(),
): Map<string, PackageRootInfo> {
  const map = new Map<string, PackageRootInfo>();
  const manifest = findProjectToml(startDir);
  if (!manifest) {
    return map;
  }
  const projectRoot = dirname(manifest);
  const lock = loadLockPackages(projectRoot);
  for (const [name, version] of lock) {
    const dir = packageVersionPath(storeDir, name, version);
    if (existsSync(join(dir, "project.toml"))) {
      map.set(name, { dir, version });
    }
  }
  return map;
}

/**
 * Register package roots for the project containing `startDir` so bare package
 * imports resolve the same way in the compiler, CLI, and LSP.
 */
export function applyPackageRootsFromProject(startDir?: string): void {
  const dir = startDir ?? process.cwd();
  try {
    const packages = discoverPackageRootsForProject(dir);
    if (packages.size === 0) {
      setPackageRootsProvider(null);
      return;
    }
    setPackageRootsProvider(() => packages);
  } catch {
    setPackageRootsProvider(null);
  }
}
