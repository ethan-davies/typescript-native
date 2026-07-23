import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { formatDiagnostics, formatSource } from "@sonite/compiler";
import { findProjectManifest, loadProject } from "../project.js";

export interface FmtOptions {
  readonly paths: readonly string[];
  readonly check: boolean;
}

export function runFmt(options: FmtOptions): number {
  const files = collectFiles(options.paths);
  if (files.length === 0) {
    console.error("error: no .sn files to format");
    return 1;
  }

  let failures = 0;
  let changed = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const result = formatSource(source, { fileName: file });
    if (!result.success || result.code === null) {
      const formatted = formatDiagnostics(result.diagnostics, file);
      if (formatted) {
        console.error(formatted);
      } else {
        console.error(`error: failed to parse ${file}`);
      }
      failures++;
      continue;
    }

    if (result.code === source) {
      continue;
    }

    if (options.check) {
      console.error(`would reformat ${file}`);
      changed++;
      continue;
    }

    writeFileSync(file, result.code, "utf8");
    console.log(`formatted ${file}`);
    changed++;
  }

  if (failures > 0) {
    return 1;
  }
  if (options.check && changed > 0) {
    return 1;
  }
  if (options.check && changed === 0) {
    console.log(`${files.length} file(s) already formatted`);
  }
  return 0;
}

function collectFiles(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    const manifest = findProjectManifest();
    if (manifest) {
      const project = loadProject();
      return collectSnFiles(project.root).sort();
    }
    return collectSnFiles(process.cwd()).sort();
  }

  const out: string[] = [];
  for (const p of paths) {
    const absolute = resolve(p);
    if (!existsSync(absolute)) {
      console.error(`error: path not found: ${p}`);
      continue;
    }
    const st = statSync(absolute);
    if (st.isDirectory()) {
      out.push(...collectSnFiles(absolute));
    } else if (absolute.toLowerCase().endsWith(".sn")) {
      out.push(absolute);
    } else {
      console.error(`error: not a .sn file: ${p}`);
    }
  }
  return [...new Set(out)].sort();
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sn", "target"]);

function collectSnFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.toLowerCase().endsWith(".sn")) {
      out.push(full);
    }
  }
}
