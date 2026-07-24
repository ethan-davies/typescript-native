import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseNativeConfig,
  resolveNativeLinkSpec,
  nativePlatformKeys,
} from "../src/native-deps.js";

describe("native-deps", () => {
  it("maps platform keys", () => {
    expect(nativePlatformKeys("linux-x64")).toContain("linux");
    expect(nativePlatformKeys("linux-x64")).toContain("linux-x64");
    expect(nativePlatformKeys("macos-arm64")).toContain("macos-arm64");
    expect(nativePlatformKeys("win32-x64")).toContain("windows-x64");
  });

  it("parses [native] and platform tables", () => {
    const { base, platforms } = parseNativeConfig({
      native: {
        libraries: ["foo"],
        library_paths: ["native/lib"],
        link_args: ["-pthread"],
        headers: ["include/foo.h"],
        linux: {
          libraries: ["foo_linux"],
        },
      },
      "native.macos-arm64": {
        library_paths: ["native/macos-arm64"],
      },
    });
    expect(base.libraries).toEqual(["foo"]);
    expect(base.linkArgs).toEqual(["-pthread"]);
    expect(platforms.get("linux")?.libraries).toEqual(["foo_linux"]);
    expect(platforms.get("macos-arm64")?.libraryPaths).toEqual([
      "native/macos-arm64",
    ]);
  });

  it("resolves bundled static library over system -l", () => {
    const root = join(tmpdir(), `sn-native-${Date.now()}`);
    const libDir = join(root, "native", "linux-x64");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, "libfoo.a"), "fake");
    try {
      const config = parseNativeConfig({
        native: { libraries: ["foo"] },
      });
      const spec = resolveNativeLinkSpec(root, config, "linux-x64");
      expect(spec.libraryFiles.some((f) => f.endsWith("libfoo.a"))).toBe(true);
      expect(spec.systemLibraries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to system library when no artifact exists", () => {
    const root = join(tmpdir(), `sn-native-sys-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const config = parseNativeConfig({
        native: { libraries: ["m"] },
      });
      const spec = resolveNativeLinkSpec(root, config, "linux-x64");
      expect(spec.libraryFiles).toEqual([]);
      expect(spec.systemLibraries).toEqual(["m"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
