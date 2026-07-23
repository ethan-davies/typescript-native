#!/usr/bin/env node
import { Command } from "commander";
import { runBuild } from "./commands/build.js";
import { runCompile } from "./commands/compile.js";
import { runFmt } from "./commands/fmt.js";
import { runInit } from "./commands/init.js";
import { runRun } from "./commands/run.js";

const program = new Command();

program
  .name("sn")
  .description("Compile and run Sonite (.sn) programs")
  .version("0.0.0");

program
  .command("init")
  .description("Create a new sn project with project.toml")
  .argument("[directory]", "project directory", ".")
  .option("-f, --force", "overwrite existing files", false)
  .option("-n, --name <name>", "package name (default: directory name)")
  .action((directory: string, options: { force: boolean; name?: string }) => {
    const initOpts: { directory: string; force: boolean; name?: string } = {
      directory,
      force: options.force,
    };
    if (options.name !== undefined) {
      initOpts.name = options.name;
    }
    process.exitCode = runInit(initOpts);
  });

program
  .command("build")
  .description("Build the current project to a native binary")
  .option("-o, --output <file>", "output binary path")
  .option("--emit-ir", "also write LLVM IR next to the binary", false)
  .option("--ir-only", "emit LLVM IR only (skip native linking)", false)
  .action(
    async (options: {
      output?: string;
      emitIr?: boolean;
      irOnly?: boolean;
    }) => {
      const buildOpts: {
        output?: string;
        emitIr?: boolean;
        irOnly?: boolean;
      } = {};
      if (options.output !== undefined) {
        buildOpts.output = options.output;
      }
      if (options.emitIr) {
        buildOpts.emitIr = true;
      }
      if (options.irOnly) {
        buildOpts.irOnly = true;
      }
      process.exitCode = await runBuild(buildOpts);
    },
  );

program
  .command("run")
  .description(
    "Compile and run a .sn file, or build and run the current project",
  )
  .argument("[input]", "path to a .sn source file (default: project entry)")
  .action(async (input: string | undefined) => {
    const dashIndex = process.argv.indexOf("--");
    const programArgs = dashIndex >= 0 ? process.argv.slice(dashIndex + 1) : [];
    process.exitCode = await runRun(input, programArgs);
  });

program
  .command("fmt")
  .description("Format .sn source files")
  .argument("[paths...]", "files or directories to format")
  .option("-c, --check", "check formatting without writing", false)
  .action((paths: string[], options: { check: boolean }) => {
    process.exitCode = runFmt({ paths, check: options.check });
  });

program
  .command("compile")
  .description("Compile a .sn file (or project entry) to LLVM IR")
  .argument("[input]", "path to a .sn source file (default: project entry)")
  .option(
    "-o, --output <file>",
    "write LLVM IR to this file (default: <input>.ll)",
  )
  .action((input: string | undefined, options: { output?: string }) => {
    process.exitCode = runCompile(input, options.output);
  });

// `sn examples/hello.sn` is shorthand for `sn run examples/hello.sn`
program
  .argument("[input]", "path to a .sn source file (shorthand for run)")
  .action(async (input?: string) => {
    if (!input) {
      program.help({ error: true });
      return;
    }
    process.exitCode = await runRun(input);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});
