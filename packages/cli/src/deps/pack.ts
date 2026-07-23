import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as tar from "tar";
import type { Project } from "../project.js";

const EXCLUDE_NAMES = new Set([
  ".sn",
  "dist",
  ".git",
  "node_modules",
  "sn.lock",
]);

function shouldExclude(projectRoot: string, absolutePath: string): boolean {
  const rel = relative(projectRoot, absolutePath);
  if (!rel || rel.startsWith("..")) {
    return true;
  }
  const parts = rel.split(/[/\\]/);
  if (parts.some((p) => EXCLUDE_NAMES.has(p))) {
    return true;
  }
  if (parts.some((p) => p.endsWith(".ll"))) {
    return true;
  }
  return false;
}

function collectFiles(projectRoot: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    if (shouldExclude(projectRoot, absolute)) {
      continue;
    }
    const st = statSync(absolute);
    if (st.isDirectory()) {
      collectFiles(projectRoot, absolute, out);
    } else if (st.isFile()) {
      out.push(absolute);
    }
  }
}

export interface PackResult {
  readonly archivePath: string;
  readonly cleanup: () => void;
  readonly bytes: Uint8Array;
}

/**
 * Create a `.tar.gz` of the project suitable for registry publish.
 * Caller should invoke `cleanup()` when done.
 */
export async function packProject(project: Project): Promise<PackResult> {
  const tmp = mkdtempSync(join(tmpdir(), "sn-pack-"));
  const archivePath = join(
    tmp,
    `${project.package.name}-${project.package.version}.tar.gz`,
  );

  const files: string[] = [];
  collectFiles(project.root, project.root, files);
  if (!existsSync(join(project.root, "project.toml"))) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error("project.toml missing");
  }

  const relativeFiles = files.map((f) => relative(project.root, f));
  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: project.root,
    },
    relativeFiles,
  );

  const bytes = new Uint8Array(readFileSync(archivePath));
  return {
    archivePath,
    bytes,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function readArchiveFile(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(path)));
}
