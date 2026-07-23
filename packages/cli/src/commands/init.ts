import { existsSync, mkdirSync, readSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_MAIN = `function main(): void {
  print("Hello, world!");
}
`;

const DEFAULT_GITIGNORE = `dist/
.sn/
*.ll
`;

const HARDCODED_ENTRY = "src/main.sn";
const HARDCODED_OUTDIR = "dist";

export interface InitOptions {
  readonly directory: string;
  readonly force: boolean;
}

interface InitAnswers {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly authors?: readonly string[];
}

export function runInit(options: InitOptions): number {
  const dir = resolve(options.directory);
  mkdirSync(dir, { recursive: true });

  const manifestPath = join(dir, "project.toml");
  const srcDir = join(dir, "src");
  const mainPath = join(srcDir, "main.sn");
  const gitignorePath = join(dir, ".gitignore");

  if (!options.force) {
    for (const path of [manifestPath, mainPath]) {
      if (existsSync(path)) {
        console.error(
          `error: ${path} already exists (pass --force to overwrite)`,
        );
        return 1;
      }
    }
  }

  let answers: InitAnswers;
  try {
    answers = promptInit(basename(dir));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 1;
  }

  const manifest = buildManifest(answers);

  mkdirSync(srcDir, { recursive: true });
  writeFileSync(manifestPath, manifest, "utf8");
  writeFileSync(mainPath, DEFAULT_MAIN, "utf8");
  if (!existsSync(gitignorePath) || options.force) {
    writeFileSync(gitignorePath, DEFAULT_GITIGNORE, "utf8");
  }

  console.log(`created project '${answers.name}' in ${dir}`);
  console.log(`  ${manifestPath}`);
  console.log(`  ${mainPath}`);
  return 0;
}

function promptInit(defaultName: string): InitAnswers {
  const name = promptLine(`package name [${defaultName}]: `).trim() || defaultName;
  if (!name) {
    throw new Error("package name is required");
  }

  const version = promptLine("version [0.1.0]: ").trim() || "0.1.0";
  if (!version) {
    throw new Error("version is required");
  }

  const description = promptLine("description (optional): ").trim();
  const license = promptLine("license (optional): ").trim();
  const authorsRaw = promptLine(
    "authors (optional, comma-separated): ",
  ).trim();

  const answers: {
    name: string;
    version: string;
    description?: string;
    license?: string;
    authors?: string[];
  } = { name, version };

  if (description) {
    answers.description = description;
  }
  if (license) {
    answers.license = license;
  }
  if (authorsRaw) {
    const authors = authorsRaw
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (authors.length > 0) {
      answers.authors = authors;
    }
  }

  return answers;
}

/** Read one line from stdin after writing a prompt (works for TTY and pipes). */
function promptLine(message: string): string {
  process.stdout.write(message);
  let line = "";
  const buf = Buffer.alloc(1);
  for (;;) {
    let bytes = 0;
    try {
      bytes = readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (bytes === 0) {
      break;
    }
    const ch = buf.toString("utf8");
    if (ch === "\n") {
      break;
    }
    if (ch === "\r") {
      continue;
    }
    line += ch;
  }
  return line;
}

function buildManifest(answers: InitAnswers): string {
  const lines: string[] = [
    "[package]",
    `name = ${tomlString(answers.name)}`,
    `version = ${tomlString(answers.version)}`,
  ];
  if (answers.description !== undefined) {
    lines.push(`description = ${tomlString(answers.description)}`);
  }
  if (answers.license !== undefined) {
    lines.push(`license = ${tomlString(answers.license)}`);
  }
  if (answers.authors !== undefined && answers.authors.length > 0) {
    lines.push(
      `authors = [${answers.authors.map((a) => tomlString(a)).join(", ")}]`,
    );
  }
  lines.push(`entry = ${tomlString(HARDCODED_ENTRY)}`);
  lines.push("");
  lines.push("[dependencies]");
  lines.push("");
  lines.push("[build]");
  lines.push(`outdir = ${tomlString(HARDCODED_OUTDIR)}`);
  lines.push("");
  return lines.join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
