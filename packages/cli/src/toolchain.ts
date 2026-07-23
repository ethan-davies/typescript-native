import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Pinned LLVM release used when downloading a toolchain. */
export const PINNED_LLVM_VERSION = "22.1.8";

export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolchainError";
  }
}

export interface ResolvedClang {
  readonly path: string;
  readonly source: "env" | "system" | "cache" | "download";
}

/**
 * Resolve a clang binary for linking LLVM IR.
 * Order: SN_CLANG → system PATH → cache → download pinned LLVM.
 */
export async function resolveClang(): Promise<ResolvedClang> {
  const fromEnv = process.env.SN_CLANG?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new ToolchainError(
        `SN_CLANG is set to '${fromEnv}' but that path does not exist`,
      );
    }
    return { path: fromEnv, source: "env" };
  }

  const system = findSystemClang();
  if (system) {
    return { path: system, source: "system" };
  }

  const cached = findCachedClang();
  if (cached) {
    return { path: cached, source: "cache" };
  }

  await downloadPinnedLlvm();
  const afterDownload = findCachedClang();
  if (!afterDownload) {
    throw new ToolchainError(
      "downloaded LLVM toolchain but clang binary was not found in the cache",
    );
  }
  return { path: afterDownload, source: "download" };
}

export function llvmCacheRoot(): string {
  const override = process.env.SN_CACHE_DIR?.trim();
  const base = override || join(homedir(), ".cache", "sn");
  return join(base, `llvm-${PINNED_LLVM_VERSION}`);
}

function clangBinaryName(): string {
  return process.platform === "win32" ? "clang.exe" : "clang";
}

function findCachedClang(): string | null {
  const root = llvmCacheRoot();
  if (!existsSync(root)) {
    return null;
  }

  const name = clangBinaryName();
  const direct = join(root, "bin", name);
  if (existsSync(direct)) {
    return direct;
  }

  try {
    for (const entry of readdirSync(root)) {
      const bin = join(root, entry, "bin", name);
      if (existsSync(bin) && statSync(bin).isFile()) {
        return bin;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function findSystemClang(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, ["clang"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    const first = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (first && existsSync(first)) {
      return first;
    }
  }

  const version = spawnSync("clang", ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (version.status === 0) {
    return "clang";
  }
  return null;
}

interface PlatformAsset {
  readonly label: string;
  readonly fileName: string;
}

function resolvePlatformAsset(): PlatformAsset {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") {
    return {
      label: "Linux-X64",
      fileName: `LLVM-${PINNED_LLVM_VERSION}-Linux-X64.tar.xz`,
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      label: "Linux-ARM64",
      fileName: `LLVM-${PINNED_LLVM_VERSION}-Linux-ARM64.tar.xz`,
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      label: "macOS-ARM64",
      fileName: `LLVM-${PINNED_LLVM_VERSION}-macOS-ARM64.tar.xz`,
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      label: "macOS-X64",
      fileName: `LLVM-${PINNED_LLVM_VERSION}-macOS-X64.tar.xz`,
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      label: "Windows-X64",
      fileName: `clang+llvm-${PINNED_LLVM_VERSION}-x86_64-pc-windows-msvc.tar.xz`,
    };
  }
  throw new ToolchainError(
    `unsupported platform for LLVM download: ${platform}/${arch} ` +
      `(install clang and ensure it is on PATH, or set SN_CLANG)`,
  );
}

async function downloadPinnedLlvm(): Promise<void> {
  const asset = resolvePlatformAsset();
  const url = `https://github.com/llvm/llvm-project/releases/download/llvmorg-${PINNED_LLVM_VERSION}/${asset.fileName}`;
  const cacheRoot = llvmCacheRoot();
  mkdirSync(cacheRoot, { recursive: true });

  const staging = join(
    tmpdir(),
    `sn-llvm-${PINNED_LLVM_VERSION}-${process.pid}`,
  );
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const archivePath = join(staging, asset.fileName);

  console.error(
    `info: clang not found; downloading LLVM ${PINNED_LLVM_VERSION} (${asset.label})…`,
  );
  console.error(`info: ${url}`);
  console.error(
    `info: this archive is large (~1–2 GB); caching under ${cacheRoot}`,
  );

  try {
    await downloadFile(url, archivePath);
    extractArchive(archivePath, staging);
    installExtractedToolchain(staging, cacheRoot);
    console.error(`info: LLVM ${PINNED_LLVM_VERSION} ready at ${cacheRoot}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new ToolchainError(
      `failed to download LLVM toolchain: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastPct = -1;

  const nodeStream = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );

  nodeStream.on("data", (chunk: Buffer | string) => {
    received +=
      typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        console.error(`info: download ${pct}%`);
      }
    }
  });

  await pipeline(nodeStream, createWriteStream(dest));
}

function extractArchive(archivePath: string, destDir: string): void {
  const result = spawnSync("tar", ["-xJf", archivePath, "-C", destDir], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new ToolchainError(
      `failed to extract LLVM archive: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
}

function installExtractedToolchain(staging: string, cacheRoot: string): void {
  const clangName = clangBinaryName();
  let extractedRoot: string | null = null;

  for (const entry of readdirSync(staging)) {
    const full = join(staging, entry);
    if (!statSync(full).isDirectory()) {
      continue;
    }
    if (existsSync(join(full, "bin", clangName))) {
      extractedRoot = full;
      break;
    }
  }

  if (!extractedRoot) {
    throw new ToolchainError(
      "extracted LLVM archive but could not find bin/clang",
    );
  }

  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(dirname(cacheRoot), { recursive: true });
  renameSync(extractedRoot, cacheRoot);

  const clangPath = join(cacheRoot, "bin", clangName);
  if (process.platform !== "win32" && existsSync(clangPath)) {
    chmodSync(clangPath, 0o755);
  }
}
