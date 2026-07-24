import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostRuntimePlatformId, type RuntimePlatformId } from "@sonite/runtime";

/** Raw `[native]` / `[native.<platform>]` table contents. */
export interface NativeConfigSection {
  readonly libraries: readonly string[];
  readonly libraryPaths: readonly string[];
  readonly linkArgs: readonly string[];
  /** Documented only — not consumed by the compiler. */
  readonly headers: readonly string[];
}

/** Resolved link inputs for the host platform. */
export interface NativeLinkSpec {
  /** Absolute paths to static/dynamic library files. */
  readonly libraryFiles: readonly string[];
  /** Directories to add as library search paths. */
  readonly libraryPaths: readonly string[];
  /** System library names for `-l` / equivalent. */
  readonly systemLibraries: readonly string[];
  /** Raw linker arguments (e.g. `-pthread`). */
  readonly linkArgs: readonly string[];
  readonly headers: readonly string[];
}

const EMPTY_SECTION: NativeConfigSection = {
  libraries: [],
  libraryPaths: [],
  linkArgs: [],
  headers: [],
};

function parseStringArray(
  table: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const value = table[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`project.toml: ${label} must be an array of strings`);
  }
  return value.map((v) => (v as string).trim()).filter((v) => v.length > 0);
}

function parseNativeSection(
  table: Record<string, unknown>,
  label: string,
): NativeConfigSection {
  return {
    libraries: parseStringArray(table, "libraries", `${label}.libraries`),
    libraryPaths: parseStringArray(
      table,
      "library_paths",
      `${label}.library_paths`,
    ),
    linkArgs: parseStringArray(table, "link_args", `${label}.link_args`),
    headers: parseStringArray(table, "headers", `${label}.headers`),
  };
}

function mergeSections(
  ...sections: NativeConfigSection[]
): NativeConfigSection {
  return {
    libraries: sections.flatMap((s) => s.libraries),
    libraryPaths: sections.flatMap((s) => s.libraryPaths),
    linkArgs: sections.flatMap((s) => s.linkArgs),
    headers: sections.flatMap((s) => s.headers),
  };
}

/**
 * Map runtime platform id to project.toml `[native.*]` keys.
 * Accepts both `macos-*` and `darwin` aliases; Windows uses `windows` / `win32`.
 */
export function nativePlatformKeys(platform: RuntimePlatformId): string[] {
  const [os, arch] = platform.split("-") as [string, string];
  const keys: string[] = [];
  if (os === "win32") {
    keys.push("windows", "win32", `windows-${arch}`, `win32-${arch}`);
  } else if (os === "macos") {
    keys.push("macos", "darwin", `macos-${arch}`, `darwin-${arch}`);
  } else {
    keys.push(os, `${os}-${arch}`);
  }
  return keys;
}

/**
 * Parse all `[native]` and `[native.*]` tables from a project.toml root object.
 */
export function parseNativeConfig(
  table: Record<string, unknown>,
): {
  base: NativeConfigSection;
  platforms: ReadonlyMap<string, NativeConfigSection>;
} {
  const platforms = new Map<string, NativeConfigSection>();
  let base = EMPTY_SECTION;

  for (const [key, value] of Object.entries(table)) {
    if (key === "native") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("project.toml: [native] must be a table");
      }
      base = parseNativeSection(value as Record<string, unknown>, "native");
      continue;
    }
    if (key.startsWith("native.")) {
      const platformKey = key.slice("native.".length);
      if (!platformKey) {
        throw new Error(`project.toml: invalid native table name '${key}'`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`project.toml: [${key}] must be a table`);
      }
      platforms.set(
        platformKey,
        parseNativeSection(value as Record<string, unknown>, key),
      );
    }
  }

  // smol-toml may nest [native.linux] under native.linux
  if (
    typeof table.native === "object" &&
    table.native !== null &&
    !Array.isArray(table.native)
  ) {
    const nativeTable = table.native as Record<string, unknown>;
    for (const [key, value] of Object.entries(nativeTable)) {
      if (
        key === "libraries" ||
        key === "library_paths" ||
        key === "link_args" ||
        key === "headers"
      ) {
        continue;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        platforms.set(
          key,
          parseNativeSection(
            value as Record<string, unknown>,
            `native.${key}`,
          ),
        );
      }
    }
  }

  return { base, platforms };
}

function candidateLibraryNames(
  lib: string,
  platform: RuntimePlatformId,
): string[] {
  const names: string[] = [];
  if (platform.startsWith("win32")) {
    names.push(`${lib}.lib`, `lib${lib}.lib`, `${lib}.dll`, `lib${lib}.a`);
  } else if (platform.startsWith("macos")) {
    names.push(`lib${lib}.a`, `lib${lib}.dylib`, `${lib}.a`);
  } else {
    names.push(`lib${lib}.a`, `lib${lib}.so`, `${lib}.a`);
  }
  return names;
}

function findLibraryFile(
  lib: string,
  searchDirs: readonly string[],
  platform: RuntimePlatformId,
): string | null {
  const names = candidateLibraryNames(lib, platform);
  for (const dir of searchDirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolve native link inputs for a project on the given (or host) platform.
 */
export function resolveNativeLinkSpec(
  projectRoot: string,
  config: {
    base: NativeConfigSection;
    platforms: ReadonlyMap<string, NativeConfigSection>;
  },
  platform: RuntimePlatformId = hostRuntimePlatformId(),
): NativeLinkSpec {
  const keys = nativePlatformKeys(platform);
  const platformSections = keys
    .map((k) => config.platforms.get(k))
    .filter((s): s is NativeConfigSection => s !== undefined);
  const merged = mergeSections(config.base, ...platformSections);

  const searchDirs: string[] = [];
  for (const rel of merged.libraryPaths) {
    searchDirs.push(resolve(projectRoot, rel));
  }
  // Conventional package-bundled location
  const bundled = resolve(projectRoot, "native", platform);
  if (existsSync(bundled)) {
    searchDirs.push(bundled);
  }
  // Also try os-only folder e.g. native/linux
  const osOnly = resolve(projectRoot, "native", platform.split("-")[0]!);
  if (existsSync(osOnly) && osOnly !== bundled) {
    searchDirs.push(osOnly);
  }

  const libraryFiles: string[] = [];
  const systemLibraries: string[] = [];
  const usedPaths = new Set<string>();

  for (const lib of merged.libraries) {
    const found = findLibraryFile(lib, searchDirs, platform);
    if (found) {
      libraryFiles.push(found);
      usedPaths.add(resolve(found, ".."));
    } else {
      systemLibraries.push(lib);
    }
  }

  return {
    libraryFiles,
    libraryPaths: [...new Set([...searchDirs, ...usedPaths])],
    systemLibraries,
    linkArgs: merged.linkArgs,
    headers: merged.headers,
  };
}
