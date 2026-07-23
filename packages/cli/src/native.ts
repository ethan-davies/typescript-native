import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { compileFile, formatDiagnostics } from "@sonite/compiler";
import { getRuntimeLibraryPath } from "@sonite/runtime";
import { applyProjectPackageRoots } from "./deps/roots.js";
import { resolveClang } from "./toolchain.js";

export interface CompileToIrResult {
  readonly ir: string;
  readonly fileName: string;
}

export function compileSourceFile(inputPath: string): CompileToIrResult | null {
  const absoluteInput = resolve(inputPath);
  applyProjectPackageRoots(dirname(absoluteInput));
  const fileName = basename(absoluteInput);
  const result = compileFile(absoluteInput);

  if (!result.success || result.ir === null) {
    const formatted = formatDiagnostics(result.diagnostics, fileName);
    if (formatted) {
      console.error(formatted);
    } else {
      console.error("error: compilation failed");
    }
    return null;
  }

  return { ir: result.ir, fileName };
}

export interface LinkOptions {
  readonly ir: string;
  readonly outputPath: string;
  /** Also write the LLVM IR next to the binary (or to this path if absolute .ll). */
  readonly emitIrPath?: string;
}

/**
 * Write IR to a temp file, invoke resolved clang with the runtime library, emit a native binary.
 */
export async function linkNative(options: LinkOptions): Promise<number> {
  let clangPath: string;
  try {
    const clang = await resolveClang();
    clangPath = clang.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 1;
  }

  let runtimeLibrary: string;
  try {
    runtimeLibrary = getRuntimeLibraryPath();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 1;
  }

  const outDir = dirname(resolve(options.outputPath));
  mkdirSync(outDir, { recursive: true });

  if (options.emitIrPath) {
    writeFileSync(options.emitIrPath, options.ir, "utf8");
  }

  const dir = mkdtempSync(join(tmpdir(), "sn-"));
  const llPath = join(dir, "program.ll");
  const binPath = resolve(options.outputPath);

  try {
    writeFileSync(llPath, options.ir, "utf8");

    const clang = spawnSync(
      clangPath,
      [
        llPath,
        runtimeLibrary,
        "-lm",
        "-lpthread",
        "-lssl",
        "-lcrypto",
        "-o",
        binPath,
        "-Wno-override-module",
      ],
      { encoding: "utf8" },
    );

    if (clang.error) {
      console.error(`error: failed to invoke clang: ${clang.error.message}`);
      return 1;
    }

    if (clang.status !== 0) {
      if (clang.stderr) {
        console.error(clang.stderr.trimEnd());
      }
      console.error("error: clang failed to build the program");
      return clang.status ?? 1;
    }

    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Compile, link to a temp binary, run it, clean up.
 */
export async function compileLinkAndRun(
  inputPath: string,
  args: readonly string[] = [],
  options: { cwd?: string } = {},
): Promise<number> {
  const compiled = compileSourceFile(inputPath);
  if (!compiled) {
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), "sn-"));
  const binPath = join(dir, "program");

  try {
    const status = await linkNative({
      ir: compiled.ir,
      outputPath: binPath,
    });
    if (status !== 0) {
      return status;
    }

    const run = spawnSync(binPath, [...args], {
      stdio: "inherit",
      cwd: options.cwd,
    });
    if (run.error) {
      console.error(`error: failed to run program: ${run.error.message}`);
      return 1;
    }
    return run.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
