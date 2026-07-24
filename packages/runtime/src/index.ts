import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export type RuntimePlatformId =
  | "linux-x64"
  | "linux-arm64"
  | "macos-x64"
  | "macos-arm64"
  | "win32-x64"
  | "win32-arm64";

const LIBRARY_NAME: Record<RuntimePlatformId, string> = {
  "linux-x64": "libsn_runtime.a",
  "linux-arm64": "libsn_runtime.a",
  "macos-x64": "libsn_runtime.a",
  "macos-arm64": "libsn_runtime.a",
  "win32-x64": "sn_runtime.lib",
  "win32-arm64": "sn_runtime.lib",
};

export function hostRuntimePlatformId(): RuntimePlatformId {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "win32" && arch === "arm64") return "win32-arm64";
  throw new Error(
    `No Sonite runtime is available for target '${platform}-${arch}'.`,
  );
}

function tryHostPlatformId(): RuntimePlatformId | null {
  try {
    return hostRuntimePlatformId();
  } catch {
    return null;
  }
}

function opensslLibNames(platformId: RuntimePlatformId): [string, string][] {
  if (platformId.startsWith("win32")) {
    return [
      ["libssl.lib", "libcrypto.lib"],
      ["ssl.lib", "crypto.lib"],
      ["libssl.a", "libcrypto.a"],
    ];
  }
  return [["libssl.a", "libcrypto.a"]];
}

function opensslSearchRoots(platformId: RuntimePlatformId): string[] {
  const roots: string[] = [];
  const envRoot = process.env.SONITE_OPENSSL_ROOT;
  if (envRoot) {
    roots.push(envRoot, join(envRoot, "lib"));
  }
  roots.push(
    join(packageRoot, "prebuilt", platformId),
    join(packageRoot, "deps", "openssl", platformId),
    join(packageRoot, "deps", "openssl", platformId, "lib"),
  );
  return roots;
}

/**
 * Absolute paths to bundled static OpenSSL libraries (ssl then crypto),
 * or an empty array when not bundled.
 */
export function getBundledOpenSslLibraries(
  platformId?: RuntimePlatformId,
): string[] {
  const target = platformId ?? tryHostPlatformId();
  if (!target) {
    return [];
  }
  for (const root of opensslSearchRoots(target)) {
    for (const [sslName, cryptoName] of opensslLibNames(target)) {
      const ssl = join(root, sslName);
      const crypto = join(root, cryptoName);
      if (existsSync(ssl) && existsSync(crypto)) {
        return [ssl, crypto];
      }
    }
  }
  return [];
}

/** Include path for bundled OpenSSL headers, or null if not present. */
export function getBundledOpenSslIncludePath(
  platformId?: RuntimePlatformId,
): string | null {
  const target = platformId ?? tryHostPlatformId();
  if (!target) {
    return null;
  }
  const candidates: string[] = [];
  const envRoot = process.env.SONITE_OPENSSL_ROOT;
  if (envRoot) {
    candidates.push(join(envRoot, "include"), envRoot);
  }
  candidates.push(
    join(packageRoot, "prebuilt", target, "include"),
    join(packageRoot, "deps", "openssl", target, "include"),
  );
  for (const include of candidates) {
    if (existsSync(join(include, "openssl", "ssl.h"))) {
      return include;
    }
  }
  return null;
}

/**
 * Resolve the static runtime archive for a target platform.
 * Prefers packaged prebuilds; falls back to locally-built dist/ for monorepo dev.
 */
export function getRuntimeLibraryPath(
  platformId?: RuntimePlatformId,
): string {
  const host = tryHostPlatformId();
  const target = platformId ?? host;
  if (!target) {
    throw new Error(
      `No Sonite runtime is available for target '${process.platform}-${process.arch}'.`,
    );
  }
  if (target === "win32-arm64") {
    throw new Error(
      `No Sonite runtime is available for target 'win32-arm64'.`,
    );
  }

  const libName = LIBRARY_NAME[target];
  const prebuilt = join(packageRoot, "prebuilt", target, libName);
  if (existsSync(prebuilt)) {
    return prebuilt;
  }

  const localNames =
    target.startsWith("win32")
      ? ["sn_runtime.lib", "libsn_runtime.a"]
      : ["libsn_runtime.a"];
  for (const name of localNames) {
    const local = join(packageRoot, "dist", name);
    if (host === target && existsSync(local)) {
      return local;
    }
  }

  throw new Error(`No Sonite runtime is available for target '${target}'.`);
}

export function getRuntimeIncludePath(): string {
  return join(packageRoot, "include");
}

/** Copy dist runtime library into prebuilt/<host>/ for packaging. */
export function installHostPrebuilt(): string {
  const host = hostRuntimePlatformId();
  if (host === "win32-arm64") {
    throw new Error("win32-arm64 runtime prebuilt is not available yet");
  }
  const libName = LIBRARY_NAME[host];
  const candidates = [
    join(packageRoot, "dist", libName),
    join(packageRoot, "dist", "libsn_runtime.a"),
    join(packageRoot, "dist", "sn_runtime.lib"),
  ];
  const local = candidates.find((p) => existsSync(p));
  if (!local) {
    throw new Error(
      "Runtime library not found. Build @sonite/runtime first (pnpm --filter @sonite/runtime build).",
    );
  }
  const destDir = join(packageRoot, "prebuilt", host);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, libName);
  copyFileSync(local, dest);

  // Stage bundled OpenSSL static libs next to the runtime archive when present.
  const depsLib = join(packageRoot, "deps", "openssl", host, "lib");
  for (const [sslName, cryptoName] of opensslLibNames(host)) {
    const sslSrc = join(depsLib, sslName);
    const cryptoSrc = join(depsLib, cryptoName);
    if (existsSync(sslSrc) && existsSync(cryptoSrc)) {
      copyFileSync(sslSrc, join(destDir, sslName));
      copyFileSync(cryptoSrc, join(destDir, cryptoName));
      break;
    }
  }

  return dest;
}
