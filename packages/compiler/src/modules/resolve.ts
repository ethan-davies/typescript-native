import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import type {
  ExportAllFromDeclaration,
  ExportNamedFromDeclaration,
  ImportDeclaration,
  Program,
} from "../ast/nodes.js";
import type {
  DiagnosticCollector,
  SourceSpan,
} from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { collectReExportSpecifiers } from "./exports.js";
import { moduleIdFromPath } from "./mangle.js";

export type ReadFileFn = (absolutePath: string) => string;

export type ModuleImportBinding =
  | {
      readonly kind: "namespace";
      readonly alias: string;
      readonly modulePath: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "named";
      readonly exportName: string;
      readonly localName: string;
      readonly modulePath: string;
      /** Original import specifier string for diagnostics. */
      readonly specifier: string;
      readonly span: SourceSpan;
    };

/** Canonical module identity (file://, sonite://std/…, sonite://package/…). */
export type ModuleIdentity = string;

export interface ResolvedModule {
  readonly path: string;
  /** Stable identity for symbol/type equality and caching. */
  readonly identity: ModuleIdentity;
  readonly source: string;
  readonly ast: Program;
  /** File basename without `.sn`; used for LLVM mangling. */
  readonly moduleId: string;
  readonly isEntry: boolean;
  /** Namespace and named bindings declared by this module's imports. */
  readonly imports: readonly ModuleImportBinding[];
  /**
   * Absolute paths of modules referenced by `export … from` (for export tables).
   * Empty when the module has no re-exports.
   */
  readonly reexportSources: readonly {
    readonly specifier: string;
    readonly path: string;
    readonly span: SourceSpan;
    readonly kind: "named" | "all";
    readonly decl: ExportNamedFromDeclaration | ExportAllFromDeclaration;
  }[];
}

export interface ResolveResult {
  readonly modules: readonly ResolvedModule[];
  readonly success: boolean;
}

export type StdRootProvider = () => string | null;

/** Installed package root with the lockfile-selected version. */
export interface PackageRootInfo {
  readonly dir: string;
  readonly version: string;
}

/**
 * Maps package name → absolute package root (legacy string) or root + version.
 * Prefer `{ dir, version }` so module identities can include `@version`.
 */
export type PackageRootsProvider = () => ReadonlyMap<
  string,
  string | PackageRootInfo
> | null;

export type ImportSpecifierKind = "relative" | "std" | "package";

export interface ResolvedSpecifier {
  readonly kind: ImportSpecifierKind;
  /** Absolute `.sn` path when found; null on failure. */
  readonly path: string | null;
  /** Path that was looked for (for diagnostics). */
  readonly lookedFor: string | null;
  readonly packageName?: string;
  readonly failure?: "not_installed" | "module_not_found" | "package_escape";
}

let stdRootProvider: StdRootProvider | null = null;
let packageRootsProvider: PackageRootsProvider | null = null;

/** Provide the absolute path to `packages/std/src` (or null if unavailable). */
export function setStdRootProvider(provider: StdRootProvider | null): void {
  stdRootProvider = provider;
}

export function getStdRootPath(): string | null {
  return stdRootProvider?.() ?? null;
}

/** Provide installed registry packages (name → directory or PackageRootInfo). */
export function setPackageRootsProvider(
  provider: PackageRootsProvider | null,
): void {
  packageRootsProvider = provider;
}

export function getPackageRoots(): ReadonlyMap<
  string,
  string | PackageRootInfo
> | null {
  return packageRootsProvider?.() ?? null;
}

function normalizePackageRoot(
  value: string | PackageRootInfo,
): PackageRootInfo {
  if (typeof value === "string") {
    return { dir: value, version: "0.0.0" };
  }
  return value;
}

export function getPackageRootInfo(
  name: string,
): PackageRootInfo | null {
  const roots = getPackageRoots();
  if (!roots) {
    return null;
  }
  const entry = roots.get(name);
  return entry ? normalizePackageRoot(entry) : null;
}

export function isRelativeSpecifier(specifier: string): boolean {
  const spec = specifier.trim();
  return spec.startsWith("./") || spec.startsWith("../");
}

export function isStdSpecifier(specifier: string): boolean {
  const spec = specifier.trim();
  return spec === "std" || spec.startsWith("std/");
}

/** Package or package/subpath: not relative, not std. */
export function isPackageSpecifier(specifier: string): boolean {
  const spec = specifier.trim();
  if (!spec || isRelativeSpecifier(spec) || isStdSpecifier(spec)) {
    return false;
  }
  return true;
}

/**
 * Split `http` → { name: "http", subpath: "" }
 * and `http/request` → { name: "http", subpath: "request" }.
 */
export function splitPackageSpecifier(specifier: string): {
  name: string;
  subpath: string;
} {
  const spec = specifier.trim().replace(/\\/g, "/");
  const slash = spec.indexOf("/");
  if (slash < 0) {
    return { name: spec, subpath: "" };
  }
  return { name: spec.slice(0, slash), subpath: spec.slice(slash + 1) };
}

/**
 * Resolve entry `.sn` for an installed package directory.
 * Reads `entry` from project.toml when present; else tries common fallbacks.
 */
export function resolvePackageEntry(packageDir: string): string | null {
  const manifestPath = join(packageDir, "project.toml");
  if (existsSync(manifestPath)) {
    try {
      const text = readFileSync(manifestPath, "utf8");
      const match = text.match(/^\s*entry\s*=\s*"([^"]+)"\s*$/m);
      if (match?.[1]) {
        const entry = resolvePath(packageDir, match[1]);
        if (existsSync(entry)) {
          return entry;
        }
      }
    } catch {
      // fall through to defaults
    }
  }
  for (const candidate of [
    join(packageDir, "src", "main.sn"),
    join(packageDir, "index.sn"),
    join(packageDir, "main.sn"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve a module file under a root: `rest.sn` then `rest/index.sn`.
 * Returns null if neither exists (when checkExists). When checkExists is false,
 * returns the preferred candidate path for diagnostics.
 */
function resolveUnderRoot(
  root: string,
  rest: string,
  checkExists: boolean,
): string | null {
  let cleaned = rest.replace(/\\/g, "/");
  if (cleaned.toLowerCase().endsWith(".sn")) {
    cleaned = cleaned.slice(0, -".sn".length);
  }
  while (cleaned.startsWith("./")) {
    cleaned = cleaned.slice(2);
  }

  if (cleaned === "" || cleaned === ".") {
    const indexPath = join(root, "index.sn");
    if (!checkExists || existsSync(indexPath)) {
      return indexPath;
    }
    return null;
  }

  const direct = join(root, `${cleaned}.sn`);
  if (!checkExists) {
    if (existsSync(direct)) {
      return direct;
    }
    const indexPath = join(root, cleaned, "index.sn");
    if (existsSync(indexPath)) {
      return indexPath;
    }
    return direct;
  }

  if (existsSync(direct)) {
    return direct;
  }
  const indexPath = join(root, cleaned, "index.sn");
  if (existsSync(indexPath)) {
    return indexPath;
  }
  return null;
}

/**
 * Ensure `candidate` stays inside `packageDir` (no `../` escape).
 */
export function isPathInsideRoot(
  packageDir: string,
  candidate: string,
): boolean {
  const rootNorm = resolvePath(packageDir).replace(/\\/g, "/").replace(/\/$/, "");
  const candNorm = resolvePath(candidate).replace(/\\/g, "/");
  return candNorm === rootNorm || candNorm.startsWith(`${rootNorm}/`);
}

/**
 * Resolve a package or package/subpath specifier against installed roots.
 */
export function resolvePackageSpecifierDetailed(
  specifier: string,
): ResolvedSpecifier {
  const { name, subpath } = splitPackageSpecifier(specifier);
  if (!name || name.includes("..") || subpath.split("/").includes("..")) {
    return {
      kind: "package",
      path: null,
      lookedFor: null,
      ...(name ? { packageName: name } : {}),
      failure: "package_escape",
    };
  }

  const info = getPackageRootInfo(name);
  if (!info) {
    return {
      kind: "package",
      path: null,
      lookedFor: null,
      packageName: name,
      failure: "not_installed",
    };
  }

  if (subpath === "") {
    const entry = resolvePackageEntry(info.dir);
    if (!entry) {
      return {
        kind: "package",
        path: null,
        lookedFor: join(info.dir, "src", "main.sn"),
        packageName: name,
        failure: "module_not_found",
      };
    }
    return { kind: "package", path: entry, lookedFor: entry, packageName: name };
  }

  // Reject escape attempts in the subpath before joining.
  if (
    subpath.startsWith("/") ||
    subpath.includes("..") ||
    subpath.replace(/\\/g, "/").split("/").includes("..")
  ) {
    return {
      kind: "package",
      path: null,
      lookedFor: null,
      packageName: name,
      failure: "package_escape",
    };
  }

  const resolved = resolveUnderRoot(info.dir, subpath, true);
  const lookedFor =
    resolved ??
    resolveUnderRoot(info.dir, subpath, false) ??
    join(info.dir, `${subpath}.sn`);

  if (!resolved) {
    return {
      kind: "package",
      path: null,
      lookedFor,
      packageName: name,
      failure: "module_not_found",
    };
  }

  if (!isPathInsideRoot(info.dir, resolved)) {
    return {
      kind: "package",
      path: null,
      lookedFor: resolved,
      packageName: name,
      failure: "package_escape",
    };
  }

  return {
    kind: "package",
    path: resolved,
    lookedFor: resolved,
    packageName: name,
  };
}

/** @deprecated Prefer resolvePackageSpecifierDetailed; returns path or null. */
export function resolvePackageSpecifier(specifier: string): string | null {
  if (!isPackageSpecifier(specifier)) {
    return null;
  }
  return resolvePackageSpecifierDetailed(specifier).path;
}

/**
 * Stable mangling id for files under an installed package root.
 * e.g. package `hello` entry → `pkg_hello`; `hello/src/util.sn` → `pkg_hello_util`.
 */
export function moduleIdForPackagePath(absolutePath: string): string | null {
  const roots = getPackageRoots();
  if (!roots) {
    return null;
  }
  const normalized = absolutePath.replace(/\\/g, "/");
  for (const [name, value] of roots) {
    const { dir } = normalizePackageRoot(value);
    const rootNorm = dir.replace(/\\/g, "/").replace(/\/$/, "");
    if (!normalized.startsWith(`${rootNorm}/`) && normalized !== rootNorm) {
      continue;
    }
    let rel = normalized.slice(rootNorm.length + 1);
    if (rel.toLowerCase().endsWith(".sn")) {
      rel = rel.slice(0, -".sn".length);
    }
    if (rel.endsWith("/index")) {
      rel = rel.slice(0, -"/index".length);
    }
    // Strip common entry prefixes for stable ids.
    if (rel === "src/main" || rel === "main" || rel === "index" || rel === "") {
      return `pkg_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    }
    const safeRel = rel.replace(/\//g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
    return `pkg_${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${safeRel}`;
  }
  return null;
}

/**
 * Resolve a `std/...` specifier against the standard-library root.
 * Tries `std/math` → `$STD/math.sn` then `$STD/math/index.sn`.
 */
export function resolveStdSpecifier(specifier: string): string | null {
  const root = getStdRootPath();
  if (!root) {
    return null;
  }
  let rest = specifier.trim();
  if (rest === "std") {
    rest = "";
  } else if (rest.startsWith("std/")) {
    rest = rest.slice(4);
  } else {
    return null;
  }
  return resolveUnderRoot(root, rest, true);
}

/**
 * Stable mangling id for std modules, e.g. `math/index.sn` → `std_math`.
 */
export function moduleIdForStdPath(absolutePath: string): string | null {
  const root = getStdRootPath();
  if (!root) {
    return null;
  }
  const normalized = absolutePath.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith(`${rootNorm}/`) && normalized !== rootNorm) {
    return null;
  }
  let rel = normalized.slice(rootNorm.length + 1);
  if (rel.toLowerCase().endsWith(".sn")) {
    rel = rel.slice(0, -".sn".length);
  }
  if (rel.endsWith("/index")) {
    rel = rel.slice(0, -"/index".length);
  }
  if (rel === "" || rel === "index") {
    return "std";
  }
  return `std_${rel.replace(/\//g, "_")}`;
}

function resolveRelativeCandidate(
  importerDir: string,
  specifier: string,
): { preferred: string; index: string } {
  let spec = specifier.trim();
  if (spec.toLowerCase().endsWith(".sn")) {
    spec = spec.slice(0, -".sn".length);
  }
  const base = resolvePath(importerDir, spec);
  const preferred = base.toLowerCase().endsWith(".sn") ? base : `${base}.sn`;
  const indexPath = base.toLowerCase().endsWith(".sn")
    ? join(dirname(base), "index.sn")
    : join(base, "index.sn");
  return { preferred, index: indexPath };
}

function pickExistingRelative(
  preferred: string,
  index: string,
  exists: (p: string) => boolean,
): string | null {
  if (exists(preferred)) {
    return preferred;
  }
  if (exists(index)) {
    return index;
  }
  return null;
}

/**
 * Classify and resolve an import specifier.
 * Categories never fall back into each other.
 */
export function resolveSpecifierDetailed(
  importerDir: string,
  specifier: string,
): ResolvedSpecifier {
  const spec = specifier.trim();

  if (isRelativeSpecifier(spec)) {
    const { preferred, index } = resolveRelativeCandidate(importerDir, spec);
    const existing = pickExistingRelative(preferred, index, existsSync);
    return {
      kind: "relative",
      // Always provide a path candidate for callers; existence is checked later.
      path: existing ?? preferred,
      lookedFor: preferred,
    };
  }

  if (isStdSpecifier(spec)) {
    const root = getStdRootPath();
    let rest = spec;
    if (rest === "std") {
      rest = "";
    } else if (rest.startsWith("std/")) {
      rest = rest.slice(4);
    }
    if (!root) {
      const lookedFor = resolvePath(
        resolvePath(importerDir, "std"),
        `${rest || "index"}.sn`,
      );
      return {
        kind: "std",
        path: lookedFor,
        lookedFor,
        failure: "module_not_found",
      };
    }
    const existing = resolveUnderRoot(root, rest, true);
    const candidate =
      existing ??
      resolveUnderRoot(root, rest, false) ??
      join(root, `${rest || "index"}.sn`);
    return {
      kind: "std",
      path: existing ?? candidate,
      lookedFor: candidate,
      ...(existing ? {} : { failure: "module_not_found" as const }),
    };
  }

  // Package (including subpaths)
  return resolvePackageSpecifierDetailed(spec);
}

/**
 * Normalize an import specifier to an absolute `.sn` path.
 * Relative: `./math`, `../utils/helper`, `./math.sn`
 * Std: `std/math`
 * Package: bare name or `name/subpath` when package roots are registered.
 *
 * Does not silently fall back between categories.
 */
export function resolveImportSpecifier(
  importerDir: string,
  specifier: string,
): string {
  const result = resolveSpecifierDetailed(importerDir, specifier);
  if (result.path) {
    return result.path;
  }
  if (result.lookedFor) {
    return result.lookedFor;
  }
  // Unresolvable package with no candidate path — return a stable sentinel.
  if (result.kind === "package" && result.packageName) {
    return resolvePath(
      "/sonite-unresolved-package",
      result.packageName,
      "index.sn",
    );
  }
  return resolvePath(importerDir, `${specifier.trim()}.sn`);
}

export function moduleIdentityForPath(absolutePath: string): ModuleIdentity {
  const normalized = resolvePath(absolutePath).replace(/\\/g, "/");

  const stdRoot = getStdRootPath();
  if (stdRoot) {
    const rootNorm = resolvePath(stdRoot).replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)) {
      let rel = normalized.slice(rootNorm.length + 1);
      if (rel.toLowerCase().endsWith(".sn")) {
        rel = rel.slice(0, -".sn".length);
      }
      if (rel.endsWith("/index")) {
        rel = rel.slice(0, -"/index".length);
      }
      if (rel === "" || rel === "index") {
        return "sonite://std";
      }
      return `sonite://std/${rel}`;
    }
  }

  const roots = getPackageRoots();
  if (roots) {
    for (const [name, value] of roots) {
      const { dir, version } = normalizePackageRoot(value);
      const rootNorm = resolvePath(dir).replace(/\\/g, "/").replace(/\/$/, "");
      if (normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)) {
        let rel = normalized.slice(rootNorm.length + 1);
        if (rel.toLowerCase().endsWith(".sn")) {
          rel = rel.slice(0, -".sn".length);
        }
        if (rel.endsWith("/index")) {
          rel = rel.slice(0, -"/index".length);
        }
        const entry = resolvePackageEntry(dir);
        const entryNorm = entry
          ? resolvePath(entry).replace(/\\/g, "/")
          : null;
        if (
          entryNorm === normalized ||
          rel === "" ||
          rel === "index" ||
          rel === "main" ||
          rel === "src/main"
        ) {
          return `sonite://package/${name}@${version}`;
        }
        return `sonite://package/${name}@${version}/${rel}`;
      }
    }
  }

  return `file://${normalized}`;
}

function defaultNamespaceFromPath(absolutePath: string): string {
  const pkgId = moduleIdForPackagePath(absolutePath);
  if (pkgId) {
    const parts = pkgId.replace(/^pkg_/, "").split("_");
    return parts[0] || "pkg";
  }
  const stdId = moduleIdForStdPath(absolutePath);
  if (stdId) {
    const parts = stdId.replace(/^std_/, "").split("_");
    return parts[parts.length - 1] || "std";
  }
  return moduleIdFromPath(absolutePath);
}

function formatCycle(cycle: readonly string[]): string {
  return cycle.map((p) => relative(process.cwd(), p) || p).join(" → ");
}

/**
 * Load the entry file and transitively resolve all imports into a compilation unit.
 * Modules are returned with the entry first, then dependencies in discovery order.
 */
export function resolveModules(
  entryPath: string,
  readFile: ReadFileFn,
  diagnostics: DiagnosticCollector,
): ResolveResult {
  const absoluteEntry = resolvePath(entryPath);
  const parsed = new Map<string, ResolvedModule>();
  const visiting = new Set<string>();
  const visitStack: string[] = [];
  const order: string[] = [];

  function readModuleSource(
    absolutePath: string,
    preferRealFs: boolean,
  ): string {
    if (
      preferRealFs ||
      moduleIdForStdPath(absolutePath) !== null ||
      moduleIdForPackagePath(absolutePath) !== null
    ) {
      return readFileSync(absolutePath, "utf8");
    }
    return readFile(absolutePath);
  }

  function relativeModuleExists(preferred: string, index: string): string | null {
    try {
      readFile(preferred);
      return preferred;
    } catch {
      // fall through
    }
    if (existsSync(preferred)) {
      return preferred;
    }
    try {
      readFile(index);
      return index;
    } catch {
      // fall through
    }
    if (existsSync(index)) {
      return index;
    }
    return null;
  }

  function resolveDependencyPath(
    importerDir: string,
    specifier: string,
    span: SourceSpan,
  ): string | null {
    const detailed = resolveSpecifierDetailed(importerDir, specifier);

    if (
      detailed.failure === "not_installed" ||
      detailed.failure === "package_escape" ||
      (detailed.kind === "package" && detailed.failure === "module_not_found") ||
      (detailed.kind === "std" &&
        detailed.failure === "module_not_found" &&
        !detailed.path)
    ) {
      if (detailed.failure === "not_installed") {
        diagnostics.error(
          `Package "${detailed.packageName}" is not installed.`,
          span,
          "E0409",
        );
      } else if (detailed.failure === "package_escape") {
        diagnostics.error(
          `Invalid package subpath "${specifier}": path escapes the package root.`,
          span,
          "E0410",
        );
      } else if (detailed.kind === "package") {
        diagnostics.error(
          `Module "${specifier}" does not exist.`,
          span,
          "E0411",
        );
      } else {
        diagnostics.error(
          `Cannot find module "${specifier}".`,
          span,
          "E0401",
        );
      }
      return null;
    }

    let resolved: string | null = detailed.path;
    if (detailed.kind === "relative") {
      const { preferred, index } = resolveRelativeCandidate(
        importerDir,
        specifier,
      );
      resolved = relativeModuleExists(preferred, index);
      if (!resolved) {
        diagnostics.error(
          `Cannot find module "${specifier}".`,
          span,
          "E0401",
        );
        return null;
      }
    } else if (detailed.kind === "std") {
      if (
        !resolved ||
        detailed.failure === "module_not_found" ||
        !existsSync(resolved)
      ) {
        diagnostics.error(
          `Cannot find module "${specifier}".`,
          span,
          "E0401",
        );
        return null;
      }
    } else if (!resolved) {
      diagnostics.error(
        `Module "${specifier}" does not exist.`,
        span,
        "E0411",
      );
      return null;
    }

    return resolved;
  }

  function visit(absolutePath: string, isEntry: boolean): boolean {
    if (parsed.has(absolutePath)) {
      return true;
    }
    if (visiting.has(absolutePath)) {
      const cycleStart = visitStack.indexOf(absolutePath);
      const cycle =
        cycleStart >= 0
          ? [...visitStack.slice(cycleStart), absolutePath]
          : [absolutePath];
      diagnostics.setFile(absolutePath);
      diagnostics.error(
        `Circular import detected: ${formatCycle(cycle)}`,
        {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        "E0403",
      );
      return false;
    }

    visiting.add(absolutePath);
    visitStack.push(absolutePath);
    diagnostics.setFile(absolutePath);

    const isStdModule = moduleIdForStdPath(absolutePath) !== null;
    const isPackageModule = moduleIdForPackagePath(absolutePath) !== null;
    let source: string;
    try {
      source = readModuleSource(absolutePath, isStdModule || isPackageModule);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.error(
        `Failed to read module '${absolutePath}': ${message}`,
        {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        "E0401",
      );
      visiting.delete(absolutePath);
      visitStack.pop();
      return false;
    }

    const lexer = new Lexer(source, diagnostics);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, diagnostics);
    const ast = parser.parse();

    const importDecls = ast.body.filter(
      (d): d is ImportDeclaration => d.kind === "ImportDeclaration",
    );
    const bindings: ModuleImportBinding[] = [];
    const reexportSources: ResolvedModule["reexportSources"][number][] = [];
    const seenLocalNames = new Set<string>();
    const importerDir = dirname(absolutePath);
    let ok = true;

    for (const decl of importDecls) {
      const resolved = resolveDependencyPath(
        importerDir,
        decl.source.value,
        decl.source.span,
      );
      if (!resolved) {
        ok = false;
        continue;
      }

      if (!visit(resolved, false)) {
        ok = false;
        continue;
      }

      if (decl.clause.kind === "NamespaceImport") {
        const alias =
          decl.clause.localName?.name ?? defaultNamespaceFromPath(resolved);
        const span = decl.clause.localName?.span ?? decl.source.span;

        if (seenLocalNames.has(alias)) {
          diagnostics.error(
            `"${alias}" has already been imported into this module.`,
            span,
            "E0404",
          );
          ok = false;
          continue;
        }
        seenLocalNames.add(alias);

        bindings.push({
          kind: "namespace",
          alias,
          modulePath: resolved,
          span: decl.span,
        });
      } else {
        for (const spec of decl.clause.specifiers) {
          if (seenLocalNames.has(spec.localName.name)) {
            diagnostics.error(
              `"${spec.localName.name}" has already been imported into this module.`,
              spec.localName.span,
              "E0404",
            );
            ok = false;
            continue;
          }
          seenLocalNames.add(spec.localName.name);

          bindings.push({
            kind: "named",
            exportName: spec.importedName.name,
            localName: spec.localName.name,
            modulePath: resolved,
            specifier: decl.source.value,
            span: spec.span,
          });
        }
      }
    }

    for (const re of collectReExportSpecifiers(ast)) {
      const resolved = resolveDependencyPath(
        importerDir,
        re.specifier,
        re.span,
      );
      if (!resolved) {
        ok = false;
        continue;
      }
      if (!visit(resolved, false)) {
        ok = false;
        continue;
      }
      reexportSources.push({
        specifier: re.specifier,
        path: resolved,
        span: re.span,
        kind: re.kind,
        decl: re.decl,
      });
    }

    visiting.delete(absolutePath);
    visitStack.pop();

    const module: ResolvedModule = {
      path: absolutePath,
      identity: moduleIdentityForPath(absolutePath),
      source,
      ast,
      moduleId:
        moduleIdForStdPath(absolutePath) ??
        moduleIdForPackagePath(absolutePath) ??
        moduleIdFromPath(absolutePath),
      isEntry,
      imports: bindings,
      reexportSources,
    };
    parsed.set(absolutePath, module);
    order.push(absolutePath);
    return ok;
  }

  const success = visit(absoluteEntry, true) && !diagnostics.hasErrors;
  diagnostics.clearFile();

  const modules = order
    .map((p) => parsed.get(p)!)
    .sort((a, b) => {
      if (a.isEntry) return -1;
      if (b.isEntry) return 1;
      return 0;
    });

  return { modules, success };
}
