import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_FORMAT_OPTIONS,
  type FormatOptions,
  resolveFormatOptions,
} from "./options.js";

/**
 * Walk upward from `startPath` (file or directory) looking for project.toml
 * and parse `[format]`. Returns resolved defaults when no manifest or no
 * `[format]` table is found.
 */
export function loadFormatOptions(
  startPath: string = process.cwd(),
): FormatOptions {
  const start = resolve(startPath);
  const startDir =
    existsSync(start) && statSync(start).isFile() ? dirname(start) : start;
  const manifest = findProjectToml(startDir);
  if (!manifest) {
    return { ...DEFAULT_FORMAT_OPTIONS };
  }
  return parseFormatSection(readFileSync(manifest, "utf8"));
}

export function findProjectToml(startDir: string): string | null {
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

/** Minimal `[format]` table parser (no full TOML dependency). */
export function parseFormatSection(toml: string): FormatOptions {
  const partial: {
    indentWidth?: number;
    useTabs?: boolean;
    lineWidth?: number;
  } = {};
  const lines = toml.split(/\r?\n/);
  let inFormat = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inFormat = line === "[format]";
      continue;
    }
    if (!inFormat) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "indent_width") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        partial.indentWidth = Math.floor(n);
      }
    } else if (key === "use_tabs") {
      if (value === "true") {
        partial.useTabs = true;
      } else if (value === "false") {
        partial.useTabs = false;
      }
    } else if (key === "line_width") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        partial.lineWidth = Math.floor(n);
      }
    }
  }
  return resolveFormatOptions(partial);
}
