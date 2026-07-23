import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { ProjectError, type Project } from "../project.js";

const PACKAGE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,213})$/;

export function isValidPackageName(name: string): boolean {
  return PACKAGE_NAME_RE.test(name);
}

export function parsePackageSpec(spec: string): {
  name: string;
  version: string | undefined;
} {
  const at = spec.lastIndexOf("@");
  // Allow scoped-looking names without npm scopes; only split version after @.
  if (at > 0) {
    return {
      name: spec.slice(0, at),
      version: spec.slice(at + 1) || undefined,
    };
  }
  return { name: spec, version: undefined };
}

/**
 * Rewrite `[dependencies]` in project.toml while preserving other content when possible.
 * Falls back to a full structured rewrite from the loaded project + new deps.
 */
export function writeDependencies(
  project: Project,
  dependencies: Record<string, string>,
): void {
  const sortedKeys = Object.keys(dependencies).sort();
  const depsBlock =
    sortedKeys.length === 0
      ? "[dependencies]\n"
      : `[dependencies]\n${sortedKeys
          .map((k) => `${k} = ${JSON.stringify(dependencies[k])}`)
          .join("\n")}\n`;

  const original = readFileSync(project.manifestPath, "utf8");
  const depsMatch = original.match(
    /(^|\n)\[dependencies\][^\n]*\n(?:(?!\[[^\]]+\]).*\n?)*/m,
  );

  let next: string;
  if (depsMatch && depsMatch.index !== undefined) {
    const start = depsMatch.index + (depsMatch[1] === "\n" ? 1 : 0);
    const end = start + depsMatch[0].length - (depsMatch[1] === "\n" ? 1 : 0);
    const before = original.slice(0, start);
    const after = original.slice(end);
    next = `${before.replace(/\n*$/, "\n")}${depsBlock}${after.replace(/^\n*/, "\n")}`.replace(
      /\n{3,}/g,
      "\n\n",
    );
  } else {
    next = `${original.replace(/\s*$/, "\n\n")}${depsBlock}`;
  }

  // Validate the result still parses.
  try {
    parseToml(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`failed to write dependencies: ${message}`);
  }

  writeFileSync(project.manifestPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}

export function setDependency(
  project: Project,
  name: string,
  version: string,
): Record<string, string> {
  if (!isValidPackageName(name)) {
    throw new ProjectError(`invalid package name '${name}'`);
  }
  const next = { ...project.dependencies, [name]: version };
  writeDependencies(project, next);
  return next;
}

export function removeDependency(
  project: Project,
  name: string,
): Record<string, string> {
  if (!(name in project.dependencies)) {
    throw new ProjectError(`dependency '${name}' is not in project.toml`);
  }
  const next = { ...project.dependencies };
  delete next[name];
  writeDependencies(project, next);
  return next;
}
