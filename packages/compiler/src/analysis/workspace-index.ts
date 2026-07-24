import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { resolveImportSpecifier } from "../modules/resolve.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "target",
  "out",
  ".turbo",
]);

export interface WorkspaceIndexOptions {
  readonly workspaceRoots: readonly string[];
  readonly readFile?: (absolutePath: string) => string;
  /** Optional cancellation check; return true to abort. */
  readonly isCancelled?: () => boolean;
}

/**
 * Walk workspace roots and return absolute paths of all `.sn` files.
 */
export function listWorkspaceSnFiles(
  workspaceRoots: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of workspaceRoots) {
    walkSnFiles(resolvePath(root), out, seen);
  }
  return out;
}

/**
 * Build a reverse import graph: imported absolute path → importer absolute paths.
 * Uses a lightweight import-specifier scan (no full typecheck).
 */
export function buildImportGraph(
  options: WorkspaceIndexOptions,
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  const files = listWorkspaceSnFiles(options.workspaceRoots);
  for (const file of files) {
    if (options.isCancelled?.()) {
      break;
    }
    const source = readSource(file, options.readFile);
    if (source === null) {
      continue;
    }
    for (const spec of extractImportSpecifiers(source)) {
      if (options.isCancelled?.()) {
        break;
      }
      try {
        const resolved = resolveImportSpecifier(dirname(file), spec);
        if (!resolved) {
          continue;
        }
        const key = resolvePath(resolved);
        const set = reverse.get(key) ?? new Set();
        set.add(file);
        reverse.set(key, set);
      } catch {
        // ignore unresolvable specifiers
      }
    }
  }
  return reverse;
}

/**
 * Find files under workspace roots that import `targetPath`.
 */
export function discoverImportersOf(
  targetPath: string,
  options: WorkspaceIndexOptions,
): string[] {
  const target = resolvePath(targetPath);
  const graph = buildImportGraph(options);
  const importers = graph.get(target);
  if (!importers) {
    return [];
  }
  return [...importers];
}

/**
 * Extract module specifier strings from import / export-from declarations.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const spec = match[1];
    if (spec) {
      specs.push(spec);
    }
  }
  // Side-effect imports: import "foo"
  const sideEffect = /\bimport\s+["']([^"']+)["']/g;
  while ((match = sideEffect.exec(source)) !== null) {
    const spec = match[1];
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

function walkSnFiles(root: string, out: string[], seen: Set<string>): void {
  if (!existsSync(root)) {
    return;
  }
  let st;
  try {
    st = statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (root.toLowerCase().endsWith(".sn")) {
      const abs = resolvePath(root);
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
    return;
  }
  if (!st.isDirectory()) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry)) {
      continue;
    }
    const full = join(root, entry);
    let childStat;
    try {
      childStat = statSync(full);
    } catch {
      continue;
    }
    if (childStat.isDirectory()) {
      walkSnFiles(full, out, seen);
    } else if (childStat.isFile() && entry.toLowerCase().endsWith(".sn")) {
      const abs = resolvePath(full);
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
  }
}

function readSource(
  absolutePath: string,
  readFile?: (absolutePath: string) => string,
): string | null {
  try {
    if (readFile) {
      return readFile(absolutePath);
    }
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}
