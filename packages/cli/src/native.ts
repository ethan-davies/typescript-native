import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileFile, formatDiagnostics } from "@sonite/compiler";
import {
  Backend,
  Linker,
  resolveOptLevel,
  type OptLevel,
} from "@sonite/llvm";
import {
  getBundledOpenSslLibraries,
  getRuntimeLibraryPath,
  hostRuntimePlatformId,
} from "@sonite/runtime";
import { applyProjectPackageRoots } from "./deps/roots.js";

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
  readonly release?: boolean;
  readonly optLevel?: OptLevel;
  readonly triple?: string;
}

function formatNativeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Emit an object file via LLVM TargetMachine and link with LLD + runtime.
 */
export async function linkNative(options: LinkOptions): Promise<number> {
  let runtimeLibrary: string;
  try {
    const platform = hostRuntimePlatformId();
    runtimeLibrary = getRuntimeLibraryPath(platform);
  } catch (error) {
    console.error(`error: ${formatNativeError(error)}`);
    return 1;
  }

  const outDir = dirname(resolve(options.outputPath));
  mkdirSync(outDir, { recursive: true });

  if (options.emitIrPath) {
    writeFileSync(options.emitIrPath, options.ir, "utf8");
  }

  const binPath = resolve(options.outputPath);
  const objPath = join(outDir, `${basename(binPath)}.o`);
  const optLevel = resolveOptLevel({
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.optLevel !== undefined ? { optLevel: options.optLevel } : {}),
  });

  let backend: Backend | null = null;
  let linker: Linker | null = null;

  try {
    backend = Backend.fromIr(options.ir);
    const targetConfig: {
      optLevel: OptLevel;
      triple?: string;
    } = { optLevel };
    if (options.triple) {
      targetConfig.triple = options.triple;
    }
    backend.target(targetConfig);
    backend.verify();
    backend.emitObject(objPath);

    linker = Linker.forHost(options.triple ?? backend.getTriple());
    linker.addObject(objPath);
    linker.addLibrary(runtimeLibrary);

    const bundledOpenSsl = getBundledOpenSslLibraries();
    for (const lib of bundledOpenSsl) {
      linker.addLibrary(lib);
    }
    if (bundledOpenSsl.length > 0) {
      for (const name of linker.getToolchain().systemLibraries) {
        if (name === "ssl" || name === "crypto") {
          continue;
        }
        linker.addSystemLibrary(name);
      }
    } else {
      linker.addDefaultSystemLibraries();
    }

    linker.setOutput(binPath);
    linker.link();

    return 0;
  } catch (error) {
    console.error(`error: ${formatNativeError(error)}`);
    return 1;
  } finally {
    backend?.dispose();
    linker?.dispose();
  }
}

/**
 * Compile, link to a temp binary, run it, clean up.
 */
export async function compileLinkAndRun(
  inputPath: string,
  args: readonly string[] = [],
  options: { cwd?: string; release?: boolean } = {},
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
      ...(options.release !== undefined ? { release: options.release } : {}),
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
