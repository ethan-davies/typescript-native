import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  detectPlatformId,
  unsupportedPlatformError,
  type SonitePlatformId,
} from "./version.js";

export type PlatformId = Exclude<SonitePlatformId, "win32-arm64">;

export interface TargetToolchain {
  readonly platformId: PlatformId;
  readonly triple: string;
  readonly linkerFlavor: "elf" | "macho" | "coff";
  readonly systemLibraries: readonly string[];
  readonly libraryPaths: readonly string[];
  /** Extra raw linker args (CRT objects, dynamic linker, etc.). */
  readonly extraArgs: readonly string[];
}

export function hostPlatformId(): PlatformId {
  const id = detectPlatformId();
  if (id === "win32-arm64") {
    throw unsupportedPlatformError("win32-arm64");
  }
  return id;
}

function defaultTriple(platformId: PlatformId): string {
  switch (platformId) {
    case "linux-x64":
      return "x86_64-unknown-linux-gnu";
    case "linux-arm64":
      return "aarch64-unknown-linux-gnu";
    case "macos-x64":
      return "x86_64-apple-darwin";
    case "macos-arm64":
      return "arm64-apple-darwin";
    case "win32-x64":
      return "x86_64-pc-windows-msvc";
  }
}

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

function findGccLibDir(tripleHint: string): string | null {
  const gccRoot = "/usr/lib/gcc";
  if (!existsSync(gccRoot)) {
    return null;
  }

  const candidates: string[] = [];
  for (const entry of readdirSync(gccRoot)) {
    const vendorDir = join(gccRoot, entry);
    if (!statSync(vendorDir).isDirectory()) continue;
    void tripleHint;
    for (const ver of readdirSync(vendorDir)) {
      const libDir = join(vendorDir, ver);
      if (existsSync(join(libDir, "crtbegin.o"))) {
        candidates.push(libDir);
      }
    }
  }

  candidates.sort();
  return candidates.at(-1) ?? null;
}

function opensslLibDirs(): string[] {
  const dirs = new Set<string>();
  const pkg = spawnSync("pkg-config", ["--libs-only-L", "openssl"], {
    encoding: "utf8",
  });
  if (pkg.status === 0 && pkg.stdout.trim()) {
    for (const part of pkg.stdout.trim().split(/\s+/)) {
      if (part.startsWith("-L")) {
        dirs.add(part.slice(2));
      }
    }
  }
  for (const d of [
    "/usr/lib",
    "/usr/lib64",
    "/usr/local/lib",
    "/opt/homebrew/lib",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib/aarch64-linux-gnu",
  ]) {
    if (existsSync(d)) {
      dirs.add(d);
    }
  }
  return [...dirs];
}

/**
 * Probe monorepo / env OpenSSL without depending on @sonite/runtime
 * (avoids a circular package edge: llvm ← runtime).
 */
function probeOpenSslLibDir(platformId: PlatformId): string | null {
  const candidates: string[] = [];
  const envRoot = process.env.SONITE_OPENSSL_ROOT;
  if (envRoot) {
    candidates.push(join(envRoot, "lib"), envRoot);
  }
  const llvmSrc = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = join(llvmSrc, "..", "..", "runtime");
  candidates.push(
    join(runtimeRoot, "prebuilt", platformId),
    join(runtimeRoot, "deps", "openssl", platformId, "lib"),
  );
  for (const dir of candidates) {
    if (
      existsSync(join(dir, "libssl.a")) ||
      existsSync(join(dir, "libssl.lib")) ||
      existsSync(join(dir, "ssl.lib"))
    ) {
      return dir;
    }
  }
  return null;
}

function linuxToolchain(platformId: PlatformId, triple: string): TargetToolchain {
  const isArm = platformId === "linux-arm64";
  const gccLib = findGccLibDir(triple);
  const crt1 =
    firstExisting(
      isArm
        ? ["/usr/lib/aarch64-linux-gnu/crt1.o", "/usr/lib64/crt1.o", "/usr/lib/crt1.o"]
        : ["/usr/lib64/crt1.o", "/usr/lib/x86_64-linux-gnu/crt1.o", "/usr/lib/crt1.o"],
    ) ?? "/usr/lib/crt1.o";
  const crti =
    firstExisting(
      isArm
        ? ["/usr/lib/aarch64-linux-gnu/crti.o", "/usr/lib64/crti.o", "/usr/lib/crti.o"]
        : ["/usr/lib64/crti.o", "/usr/lib/x86_64-linux-gnu/crti.o", "/usr/lib/crti.o"],
    ) ?? "/usr/lib/crti.o";
  const crtn =
    firstExisting(
      isArm
        ? ["/usr/lib/aarch64-linux-gnu/crtn.o", "/usr/lib64/crtn.o", "/usr/lib/crtn.o"]
        : ["/usr/lib64/crtn.o", "/usr/lib/x86_64-linux-gnu/crtn.o", "/usr/lib/crtn.o"],
    ) ?? "/usr/lib/crtn.o";

  const extraArgs: string[] = [
    "--eh-frame-hdr",
    "-dynamic-linker",
    isArm ? "/lib/ld-linux-aarch64.so.1" : "/lib64/ld-linux-x86-64.so.2",
    crt1,
    crti,
  ];

  if (gccLib) {
    extraArgs.push(join(gccLib, "crtbegin.o"));
  }

  const libraryPaths = [
    "/usr/lib",
    "/usr/lib64",
    "/lib",
    "/lib64",
    ...opensslLibDirs(),
  ];
  if (gccLib) {
    libraryPaths.unshift(gccLib);
  }

  const trailing: string[] = [];
  if (gccLib) {
    trailing.push(join(gccLib, "crtend.o"));
  }
  trailing.push(crtn);

  return {
    platformId,
    triple,
    linkerFlavor: "elf",
    systemLibraries: [
      "ssl",
      "crypto",
      "m",
      "pthread",
      "dl",
      "c",
      "gcc_s",
      "gcc",
      "c",
    ],
    libraryPaths: [...new Set(libraryPaths)],
    extraArgs: [...extraArgs, "--", ...trailing],
  };
}

function macosToolchain(platformId: PlatformId, triple: string): TargetToolchain {
  const sdk = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  const sdkPath =
    sdk.status === 0 && sdk.stdout.trim() ? sdk.stdout.trim() : null;

  const libraryPaths = [
    "/usr/lib",
    "/usr/local/lib",
    "/opt/homebrew/lib",
    ...opensslLibDirs(),
  ];
  const extraArgs: string[] = [
    "-arch",
    platformId.endsWith("arm64") ? "arm64" : "x86_64",
  ];
  if (sdkPath) {
    extraArgs.push("-syslibroot", sdkPath);
    libraryPaths.push(join(sdkPath, "usr", "lib"));
  }

  return {
    platformId,
    triple,
    linkerFlavor: "macho",
    systemLibraries: ["ssl", "crypto", "m", "pthread", "dl", "System", "c"],
    libraryPaths: [...new Set(libraryPaths)],
    extraArgs,
  };
}

function findWindowsSdkLibDirs(): string[] {
  const dirs: string[] = [];
  const programFiles = process.env["ProgramFiles(x86)"] || process.env.ProgramFiles;
  if (!programFiles) {
    return dirs;
  }
  const kits = join(programFiles, "Windows Kits", "10", "Lib");
  if (!existsSync(kits)) {
    return dirs;
  }
  const versions = readdirSync(kits).sort();
  const latest = versions.at(-1);
  if (!latest) return dirs;
  for (const leaf of ["ucrt/x64", "um/x64"]) {
    const p = join(kits, latest, leaf);
    if (existsSync(p)) dirs.push(p);
  }
  // MSVC CRT
  const vswhere = join(
    programFiles,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const r = spawnSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8" },
    );
    const install = r.stdout?.trim();
    if (install) {
      const msvc = join(install, "VC", "Tools", "MSVC");
      if (existsSync(msvc)) {
        const ver = readdirSync(msvc).sort().at(-1);
        if (ver) {
          const lib = join(msvc, ver, "lib", "x64");
          if (existsSync(lib)) dirs.push(lib);
        }
      }
    }
  }
  return dirs;
}

function windowsToolchain(platformId: PlatformId, triple: string): TargetToolchain {
  const libraryPaths = findWindowsSdkLibDirs();
  // Bundled OpenSSL (absolute .lib paths) is attached by the CLI via
  // @sonite/runtime getBundledOpenSslLibraries(); keep names out of
  // systemLibraries to avoid double-linking.
  const opensslLibDir = probeOpenSslLibDir(platformId);
  if (opensslLibDir) {
    libraryPaths.push(opensslLibDir);
  }
  return {
    platformId,
    triple,
    linkerFlavor: "coff",
    // MSVC-style libraries (passed as -l names → LLD maps to .lib)
    systemLibraries: [
      "msvcrt",
      "ucrt",
      "vcruntime",
      "legacy_stdio_definitions",
      "kernel32",
      "user32",
      "shell32",
      "advapi32",
      "ws2_32",
      "bcrypt",
    ],
    libraryPaths,
    extraArgs: [
      "/subsystem:console",
      "/defaultlib:libcmt",
      "/defaultlib:oldnames",
    ],
  };
}

/**
 * Derive linker/system library configuration for a target triple / platform.
 */
export function resolveTargetToolchain(
  triple?: string,
  platformId: PlatformId = hostPlatformId(),
): TargetToolchain {
  const effectiveTriple = triple ?? defaultTriple(platformId);

  if (platformId.startsWith("linux")) {
    return linuxToolchain(platformId, effectiveTriple);
  }
  if (platformId.startsWith("macos")) {
    return macosToolchain(platformId, effectiveTriple);
  }
  if (platformId === "win32-x64") {
    return windowsToolchain(platformId, effectiveTriple);
  }
  throw unsupportedPlatformError(platformId);
}
