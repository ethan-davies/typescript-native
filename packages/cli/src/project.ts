import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseVersionRequirement } from "./deps/semver.js";

export interface ProjectPackage {
  readonly name: string;
  readonly version: string;
  /** Optional metadata — omitted from project.toml when unset. */
  readonly description?: string;
  readonly license?: string;
  readonly authors?: readonly string[];
  readonly entry: string;
}

export interface ProjectBuild {
  readonly outdir: string;
}

export interface ProjectFormat {
  readonly indentWidth: number;
  readonly useTabs: boolean;
  readonly lineWidth: number;
}

export interface Project {
  readonly root: string;
  readonly manifestPath: string;
  readonly package: ProjectPackage;
  readonly build: ProjectBuild;
  readonly format: ProjectFormat;
  /** Version requirements from `[dependencies]` (exact, `^`, or `~`). */
  readonly dependencies: Readonly<Record<string, string>>;
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
  const description = optionalString(pkgTable, "description");
  const license = optionalString(pkgTable, "license");
  const authors = optionalStringArray(pkgTable, "authors");
  const outdir = optionalString(buildTable, "outdir") ?? "dist";
  const dependencies = parseDependencies(table);
  const format = parseFormatTable(table);

  if (!name.trim()) {
    throw new ProjectError("package.name must not be empty");
  }
  if (!entry.trim()) {
    throw new ProjectError("package.entry must not be empty");
  }

  const pkg: {
    name: string;
    version: string;
    entry: string;
    description?: string;
    license?: string;
    authors?: readonly string[];
  } = { name, version, entry };
  if (description !== undefined) {
    pkg.description = description;
  }
  if (license !== undefined) {
    pkg.license = license;
  }
  if (authors !== undefined) {
    pkg.authors = authors;
  }

  return {
    root,
    manifestPath: absoluteManifest,
    package: pkg,
    build: { outdir },
    format,
    dependencies,
    entryPath: resolve(root, entry),
    outdirPath: resolve(root, outdir),
    binaryName: name,
  };
}

function parseFormatTable(table: Record<string, unknown>): ProjectFormat {
  const defaults: ProjectFormat = {
    indentWidth: 4,
    useTabs: false,
    lineWidth: 100,
  };
  if (table.format === undefined) {
    return defaults;
  }
  const formatTable = requireTable(table, "format");
  let indentWidth = defaults.indentWidth;
  let useTabs = defaults.useTabs;
  let lineWidth = defaults.lineWidth;

  if (formatTable.indent_width !== undefined) {
    if (
      typeof formatTable.indent_width !== "number" ||
      !Number.isFinite(formatTable.indent_width) ||
      formatTable.indent_width < 0
    ) {
      throw new ProjectError(
        "project.toml: format.indent_width must be a non-negative number",
      );
    }
    indentWidth = Math.floor(formatTable.indent_width);
  }
  if (formatTable.use_tabs !== undefined) {
    if (typeof formatTable.use_tabs !== "boolean") {
      throw new ProjectError(
        "project.toml: format.use_tabs must be a boolean",
      );
    }
    useTabs = formatTable.use_tabs;
  }
  if (formatTable.line_width !== undefined) {
    if (
      typeof formatTable.line_width !== "number" ||
      !Number.isFinite(formatTable.line_width) ||
      formatTable.line_width <= 0
    ) {
      throw new ProjectError(
        "project.toml: format.line_width must be a positive number",
      );
    }
    lineWidth = Math.floor(formatTable.line_width);
  }

  return { indentWidth, useTabs, lineWidth };
}

function parseDependencies(
  table: Record<string, unknown>,
): Record<string, string> {
  if (table.dependencies === undefined) {
    return {};
  }
  const depsTable = requireTable(table, "dependencies");
  const deps: Record<string, string> = {};
  for (const [key, value] of Object.entries(depsTable)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new ProjectError(
        `project.toml: dependencies.${key} must be a non-empty version string`,
      );
    }
    try {
      parseVersionRequirement(value.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProjectError(`project.toml: dependencies.${key}: ${message}`);
    }
    deps[key] = value.trim();
  }
  return deps;
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
