#!/usr/bin/env node
/**
 * Download and build a static OpenSSL into packages/runtime/deps/openssl/<platformId>/.
 *
 * Cache: $SN_CACHE_DIR or ~/.cache/sonite/openssl-src/
 * Skip: if libssl.a / libssl.lib already exists under the dest prefix.
 */
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, "..");

function hostPlatformId() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "win32" && arch === "arm64") return "win32-arm64";
  throw new Error(`Unsupported platform ${platform}-${arch}`);
}

function sslLibName(platformId) {
  return platformId.startsWith("win32") ? "libssl.lib" : "libssl.a";
}

function cryptoLibName(platformId) {
  return platformId.startsWith("win32") ? "libcrypto.lib" : "libcrypto.a";
}

function cacheRoot() {
  if (process.env.SN_CACHE_DIR) {
    return join(process.env.SN_CACHE_DIR, "openssl-src");
  }
  return join(homedir(), ".cache", "sonite", "openssl-src");
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
  });
  return r.status === 0 && Boolean(r.stdout?.trim());
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed with exit ${r.status}`);
  }
}

async function download(url, dest) {
  if (existsSync(dest)) {
    console.log(`Using cached tarball ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const tmp = `${dest}.partial`;
  await pipeline(res.body, createWriteStream(tmp));
  renameSync(tmp, dest);
}

function extractTarball(tarball, destDir) {
  mkdirSync(destDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", destDir]);
}

function findExtractedSrc(parent, version) {
  const expected = join(parent, `openssl-${version}`);
  if (existsSync(join(expected, "Configure"))) {
    return expected;
  }
  throw new Error(`Could not find OpenSSL sources under ${parent}`);
}

function configureTarget(platformId) {
  if (platformId === "linux-x64") return "linux-x86_64";
  if (platformId === "linux-arm64") return "linux-aarch64";
  if (platformId === "macos-x64") return "darwin64-x86_64-cc";
  if (platformId === "macos-arm64") return "darwin64-arm64-cc";
  if (platformId === "win32-x64") return "VC-WIN64A";
  return null;
}

function windowsSkip(message) {
  console.log("");
  console.log("OpenSSL static build skipped on Windows.");
  console.log(message);
  console.log("");
  console.log("To build bundled OpenSSL on Windows:");
  console.log("  1. Install Strawberry Perl (or ActivePerl) and NASM");
  console.log("  2. Open an MSVC x64 Developer Command Prompt");
  console.log("  3. cd packages/runtime && node scripts/fetch-openssl.js");
  console.log("");
  console.log("CI/local builds will fall back to system OpenSSL if available.");
  process.exit(0);
}

async function main() {
  const pin = JSON.parse(
    readFileSync(join(scriptDir, "openssl-version.json"), "utf8"),
  );
  const version = pin.version;
  const url = pin.url;
  const platformId = hostPlatformId();
  const dest = join(packageRoot, "deps", "openssl", platformId);
  const sslLib = join(dest, "lib", sslLibName(platformId));
  const cryptoLib = join(dest, "lib", cryptoLibName(platformId));

  if (existsSync(sslLib) && existsSync(cryptoLib)) {
    console.log(`OpenSSL ${version} already built at ${dest}`);
    return;
  }

  if (platformId.startsWith("win32")) {
    if (!which("perl")) {
      windowsSkip("Perl was not found on PATH (needed for `perl Configure VC-WIN64A`).");
      return;
    }
    if (!which("nasm")) {
      console.log(
        "warning: NASM not found on PATH; OpenSSL assembly may be disabled or fail.",
      );
    }
  }

  const target = configureTarget(platformId);
  if (!target) {
    if (platformId.startsWith("win32")) {
      windowsSkip(`No Configure target for ${platformId}.`);
      return;
    }
    throw new Error(`No OpenSSL Configure target for ${platformId}`);
  }

  const cache = cacheRoot();
  mkdirSync(cache, { recursive: true });
  const tarball = join(cache, `openssl-${version}.tar.gz`);
  await download(url, tarball);

  const workParent = join(cache, "build", platformId);
  rmSync(workParent, { recursive: true, force: true });
  mkdirSync(workParent, { recursive: true });
  extractTarball(tarball, workParent);
  const src = findExtractedSrc(workParent, version);

  mkdirSync(dest, { recursive: true });

  const configureArgs = [
    target,
    "no-shared",
    `--prefix=${dest}`,
    `--openssldir=${join(dest, "ssl")}`,
  ];

  if (platformId.startsWith("win32")) {
    run("perl", ["Configure", ...configureArgs], { cwd: src });
    if (which("nmake")) {
      run("nmake", [], { cwd: src });
      run("nmake", ["install_sw"], { cwd: src });
    } else if (which("make")) {
      run("make", ["-j"], { cwd: src });
      run("make", ["install_sw"], { cwd: src });
    } else {
      windowsSkip("Neither nmake nor make was found to build OpenSSL.");
      return;
    }
  } else {
    run("./Configure", configureArgs, { cwd: src });
    const jobs = String(Math.max(1, availableParallelism()));
    run("make", [`-j${jobs}`], { cwd: src });
    run("make", ["install_sw"], { cwd: src });
  }

  // OpenSSL may install under lib/ or lib64/
  if (!existsSync(sslLib)) {
    const altSsl = join(dest, "lib64", sslLibName(platformId));
    const altCrypto = join(dest, "lib64", cryptoLibName(platformId));
    if (existsSync(altSsl) && existsSync(altCrypto)) {
      mkdirSync(join(dest, "lib"), { recursive: true });
      copyFileSync(altSsl, sslLib);
      copyFileSync(altCrypto, cryptoLib);
    }
  }

  // MSVC install sometimes names libs without the "lib" prefix
  if (!existsSync(sslLib) && platformId.startsWith("win32")) {
    const altSsl = join(dest, "lib", "ssl.lib");
    const altCrypto = join(dest, "lib", "crypto.lib");
    if (existsSync(altSsl) && existsSync(altCrypto)) {
      copyFileSync(altSsl, sslLib);
      copyFileSync(altCrypto, cryptoLib);
    }
  }

  if (!existsSync(sslLib) || !existsSync(cryptoLib)) {
    throw new Error(
      `OpenSSL build finished but ${sslLib} / ${cryptoLib} were not found`,
    );
  }

  console.log(`OpenSSL ${version} installed to ${dest}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
