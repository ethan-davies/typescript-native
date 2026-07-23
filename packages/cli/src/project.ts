import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface ProjectPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly authors: readonly string[];
  readonly entry: string;
}

export interface ProjectBuild {
  readonly outdir: string;
}

export interface Project {
  readonly root: string;
  readonly manifestPath: string;
  readonly package: ProjectPackage;
  readonly build: ProjectBuild;
  /** Absolute path to the entry .sn file. */
  readonly entryPath: string;
  /** Absolute path to the build output directory. */
  readonly outdirPath: string;
  /** Output binary basename (package.name). */
  readonly binaryName: string;
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * Walk upward from `startDir` looking for `project.toml`.
 * Returns the absolute path to the manifest, or null if not found.
 */
export function findProjectManifest(
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
 * Load and validate a project by searching upward from a directory (default: cwd).
 */
export function loadProject(startDir: string = process.cwd()): Project {
  const manifestPath = findProjectManifest(resolve(startDir));
  if (!manifestPath) {
    throw new ProjectError(
      "no project.toml found (run `sn init` or cd into a project directory)",
    );
  }
  return loadProjectFromManifest(manifestPath);
}

export function loadProjectFromManifest(manifestPath: string): Project {
  const absoluteManifest = resolve(manifestPath);
  if (!existsSync(absoluteManifest)) {
    throw new ProjectError(`project.toml not found: ${absoluteManifest}`);
  }

  let raw: unknown;
  try {
    raw = parseToml(readFileSync(absoluteManifest, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`failed to parse project.toml: ${message}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectError("project.toml must contain a TOML table");
  }

  const root = dirname(absoluteManifest);
  const table = raw as Record<string, unknown>;
  const pkgTable = requireTable(table, "package");
  const buildTable =
    table.build === undefined ? {} : requireTable(table, "build");

  const name = requireString(pkgTable, "name", "package.name");
  const version = requireString(pkgTable, "version", "package.version");
  const entry = requireString(pkgTable, "entry", "package.entry");
  const description = optionalString(pkgTable, "description") ?? "";
  const license = optionalString(pkgTable, "license") ?? "MIT";
  const authors = optionalStringArray(pkgTable, "authors") ?? [];
  const outdir = optionalString(buildTable, "outdir") ?? "dist";

  if (!name.trim()) {
    throw new ProjectError("package.name must not be empty");
  }
  if (!entry.trim()) {
    throw new ProjectError("package.entry must not be empty");
  }

  return {
    root,
    manifestPath: absoluteManifest,
    package: {
      name,
      version,
      description,
      license,
      authors,
      entry,
    },
    build: { outdir },
    entryPath: resolve(root, entry),
    outdirPath: resolve(root, outdir),
    binaryName: name,
  };
}

function requireTable(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectError(`project.toml: missing or invalid [${key}] table`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  table: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = table[key];
  if (typeof value !== "string") {
    throw new ProjectError(`project.toml: ${label} must be a string`);
  }
  return value;
}

function optionalString(
  table: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProjectError(`project.toml: ${key} must be a string`);
  }
  return value;
}

function optionalStringArray(
  table: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ProjectError(`project.toml: ${key} must be an array of strings`);
  }
  return value as string[];
}
