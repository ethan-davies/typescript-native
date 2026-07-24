import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSourceFile, linkNative } from "../native.js";
import { resolveNativeLinkSpec } from "../native-deps.js";
import { loadProject, ProjectError } from "../project.js";
import type { OptLevel } from "@sonite/llvm";

export interface BuildOptions {
  readonly output?: string;
  readonly emitIr?: boolean;
  /** When true, only emit IR and skip native linking. */
  readonly irOnly?: boolean;
  readonly release?: boolean;
  readonly optLevel?: OptLevel;
  readonly warningsAsErrors?: boolean;
}

export async function runBuild(options: BuildOptions = {}): Promise<number> {
  let project;
  try {
    project = loadProject();
  } catch (error) {
    if (error instanceof ProjectError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const compiled = compileSourceFile(project.entryPath, {
    ...(options.warningsAsErrors ? { warningsAsErrors: true } : {}),
    ...(options.release !== undefined ? { release: options.release } : {}),
  });
  if (!compiled) {
    return 1;
  }

  const binaryPath = options.output
    ? resolve(options.output)
    : join(project.outdirPath, project.binaryName);

  const irPath = options.emitIr || options.irOnly
    ? join(project.outdirPath, `${project.binaryName}.ll`)
    : undefined;

  if (options.irOnly) {
    mkdirSync(project.outdirPath, { recursive: true });
    const out = irPath ?? join(project.outdirPath, `${project.binaryName}.ll`);
    writeFileSync(out, compiled.ir, "utf8");
    console.log(`wrote ${out}`);
    return 0;
  }

  const nativeLink = resolveNativeLinkSpec(project.root, project.native);

  const linkOpts: Parameters<typeof linkNative>[0] = {
    ir: compiled.ir,
    outputPath: binaryPath,
    nativeLink,
    ...(irPath !== undefined ? { emitIrPath: irPath } : {}),
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.optLevel !== undefined ? { optLevel: options.optLevel } : {}),
  };

  const status = await linkNative(linkOpts);

  if (status !== 0) {
    return status;
  }

  if (irPath) {
    console.log(`wrote ${irPath}`);
  }
  console.log(`wrote ${binaryPath}`);
  return 0;
}
