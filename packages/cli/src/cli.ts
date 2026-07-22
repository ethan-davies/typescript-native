#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { compileFile, formatDiagnostics } from "@typescript-native/compiler";
import { getRuntimeLibraryPath } from "@typescript-native/runtime";

const program = new Command();

program
  .name("tsn")
  .description("Compile and run TypeScript-native (.tsn) programs")
  .version("0.0.0");

program
  .command("compile")
  .description("Compile a .tsn file to LLVM IR")
  .argument("<input>", "path to a .tsn source file")
  .option("-o, --output <file>", "write LLVM IR to this file (default: <input>.ll)")
  .action((input: string, options: { output?: string }) => {
    process.exitCode = compileFileToIr(input, options.output);
  });

program
  .command("run")
  .description("Compile a .tsn file with clang and run it")
  .argument("<input>", "path to a .tsn source file")
  .action((input: string) => {
    process.exitCode = runFile(input);
  });

// `tsn examples/hello.tsn` is shorthand for `tsn run examples/hello.tsn`
program
  .argument("[input]", "path to a .tsn source file (shorthand for run)")
  .action((input?: string) => {
    if (!input) {
      program.help({ error: true });
      return;
    }
    process.exitCode = runFile(input);
  });

program.parse();

interface CompiledSource {
  readonly ir: string;
  readonly fileName: string;
}

function readAndCompile(inputPath: string): CompiledSource | null {
  const absoluteInput = resolve(inputPath);
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

function compileFileToIr(inputPath: string, outputPath?: string): number {
  const compiled = readAndCompile(inputPath);
  if (!compiled) {
    return 1;
  }

  const absoluteInput = resolve(inputPath);
  const out = outputPath ?? absoluteInput.replace(/\.tsn$/i, "") + ".ll";
  writeFileSync(out, compiled.ir, "utf8");
  console.log(`wrote ${out}`);
  return 0;
}

function runFile(inputPath: string): number {
  const compiled = readAndCompile(inputPath);
  if (!compiled) {
    return 1;
  }

  if (!commandExists("clang")) {
    console.error(
      "error: 'clang' was not found on PATH; install LLVM/clang to run .tsn files",
    );
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

  const dir = mkdtempSync(join(tmpdir(), "tsn-"));
  const llPath = join(dir, "program.ll");
  const binPath = join(dir, "program");

  try {
    writeFileSync(llPath, compiled.ir, "utf8");

    const clang = spawnSync(
      "clang",
      [llPath, runtimeLibrary, "-o", binPath, "-Wno-override-module"],
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

    const run = spawnSync(binPath, [], { stdio: "inherit" });

    if (run.error) {
      console.error(`error: failed to run program: ${run.error.message}`);
      return 1;
    }

    return run.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}
