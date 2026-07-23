import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileSourceFile } from "../native.js";
import { loadProject, ProjectError } from "../project.js";

export function runCompile(
  input: string | undefined,
  output: string | undefined,
): number {
  let inputPath = input;
  if (!inputPath) {
    try {
      inputPath = loadProject().entryPath;
    } catch (error) {
      if (error instanceof ProjectError) {
        console.error(`error: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  const compiled = compileSourceFile(inputPath);
  if (!compiled) {
    return 1;
  }

  const absoluteInput = resolve(inputPath);
  const out = output ?? absoluteInput.replace(/\.sn$/i, "") + ".ll";
  writeFileSync(out, compiled.ir, "utf8");
  console.log(`wrote ${out}`);
  return 0;
}
