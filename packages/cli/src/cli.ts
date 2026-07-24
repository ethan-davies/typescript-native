#!/usr/bin/env node
import { Command } from "commander";
import { runBuild } from "./commands/build.js";
import { runCompile } from "./commands/compile.js";
import { runAdd, runInstall, runRemove, runUpdate } from "./commands/deps.js";
import { runFmt } from "./commands/fmt.js";
import { runInit } from "./commands/init.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runPublish } from "./commands/publish.js";
import { runInfo, runSearch } from "./commands/search.js";
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
  .action((directory: string, options: { force: boolean }) => {
    process.exitCode = runInit({
      directory,
      force: options.force,
    });
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
  .argument("[paths...]", "files, directories, globs, or - for stdin")
  .option("-c, --check", "check formatting without writing", false)
  .option("-w, --write", "write formatted output (default)", false)
  .action((paths: string[], options: { check: boolean; write: boolean }) => {
    process.exitCode = runFmt({
      paths,
      check: options.check,
      write: options.write,
    });
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

program
  .command("login")
  .description("Log in to the Sonite registry via device code")
  .action(async () => {
    process.exitCode = await runLogin();
  });

program
  .command("logout")
  .description("Log out and revoke the local registry token")
  .action(async () => {
    process.exitCode = await runLogout();
  });

program
  .command("search")
  .description("Search packages on the registry")
  .argument("[query]", "substring to match against package names")
  .action(async (query: string | undefined) => {
    process.exitCode = await runSearch(query);
  });

program
  .command("info")
  .description("Show registry package details and versions")
  .argument("<name>", "package name")
  .action(async (name: string) => {
    process.exitCode = await runInfo(name);
  });

program
  .command("add")
  .description("Add a dependency to the current project")
  .argument("<package>", "package name, optionally name@version")
  .action(async (pkg: string) => {
    process.exitCode = await runAdd(pkg);
  });

program
  .command("remove")
  .description("Remove a dependency from the current project")
  .argument("<package>", "package name")
  .action(async (pkg: string) => {
    process.exitCode = await runRemove(pkg);
  });

program
  .command("install")
  .description("Install dependencies from project.toml / project.lock")
  .action(async () => {
    process.exitCode = await runInstall();
  });

program
  .command("update")
  .description("Re-resolve dependencies from project.toml and refresh project.lock")
  .argument("[package]", "update only this package")
  .action(async (pkg: string | undefined) => {
    process.exitCode = await runUpdate(pkg);
  });

program
  .command("publish")
  .description("Publish the current project to the registry")
  .action(async () => {
    process.exitCode = await runPublish();
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
