import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../project.js";
import {
  getPackage,
  getVersion,
  listVersions,
} from "../registry/packages.js";
import { installPackageVersion } from "./install-fetch.js";
import {
  loadLockfile,
  lockPackageMap,
  writeLockfile,
  type LockPackage,
} from "./lock.js";
import {
  lockSatisfiesRoots,
  resolveDependencies,
  ResolveError,
} from "./resolve.js";
import {
  caretOf,
  maxSatisfying,
  parseVersionRequirement,
} from "./semver.js";
import {
  packageVersionPath,
  removeDependant,
  releasePreviousVersion,
} from "./store.js";

export { installPackageVersion } from "./install-fetch.js";
export { ResolveError } from "./resolve.js";

export async function resolveInstallVersion(
  name: string,
  requested: string | undefined,
): Promise<{ requirement: string; version: string; checksum: string }> {
  if (requested) {
    const req = parseVersionRequirement(requested);
    if (req.kind === "exact") {
      const ver = await getVersion(name, req.raw);
      return {
        requirement: req.raw,
        version: ver.version,
        checksum: ver.checksumSha256,
      };
    }
    const listed = await listVersions(name);
    const versions = listed.versions.map((v) => v.version);
    const version = maxSatisfying(versions, req);
    if (!version) {
      throw new ResolveError(
        `no version of '${name}' satisfies '${requested}'`,
      );
    }
    const ver = await getVersion(name, version);
    return {
      requirement: req.raw,
      version: ver.version,
      checksum: ver.checksumSha256,
    };
  }

  const pkg = await getPackage(name);
  if (!pkg.latestVersion) {
    throw new ResolveError(`package '${name}' has no published versions`);
  }
  const version = pkg.latestVersion.version;
  return {
    requirement: caretOf(version),
    version,
    checksum: pkg.latestVersion.checksumSha256,
  };
}

/**
 * Resolve from project.toml (ignoring lock), write project.lock, install everything.
 */
export async function resolveAndInstall(
  project: Project,
  opts?: {
    prefer?: ReadonlyMap<string, string>;
    float?: ReadonlySet<string>;
  },
): Promise<readonly LockPackage[]> {
  const resolved = await resolveDependencies(
    project.root,
    project.dependencies,
    opts,
  );
  const packages: LockPackage[] = resolved.packages.map((p) => ({
    name: p.name,
    version: p.version,
    checksum: p.checksum,
    source: p.source,
    dependencies: p.dependencies,
  }));

  const previous = lockPackageMap(loadLockfile(project.root));
  const nextNames = new Set(packages.map((p) => p.name));
  for (const [name, entry] of previous) {
    if (!nextNames.has(name)) {
      removeDependant(name, entry.version, project.root);
    }
  }

  for (const pkg of packages) {
    await installPackageVersion(
      project.root,
      pkg.name,
      pkg.version,
      pkg.checksum,
    );
  }

  writeLockfile(project.root, packages);
  return packages;
}

/**
 * Install from project.lock when it still satisfies project.toml ranges;
 * otherwise re-resolve.
 */
export async function installProjectDependencies(
  project: Project,
): Promise<readonly LockPackage[]> {
  const lock = loadLockfile(project.root);
  const locked = lockPackageMap(lock);

  if (Object.keys(project.dependencies).length === 0) {
    for (const [name, entry] of locked) {
      removeDependant(name, entry.version, project.root);
    }
    writeLockfile(project.root, []);
    return [];
  }

  if (
    lock &&
    lock.packages.length > 0 &&
    lockSatisfiesRoots(project.dependencies, locked)
  ) {
    const nextNames = new Set(lock.packages.map((p) => p.name));
    for (const [name, entry] of locked) {
      if (!nextNames.has(name)) {
        removeDependant(name, entry.version, project.root);
      }
    }

    for (const pkg of lock.packages) {
      const cached = existsSync(
        join(packageVersionPath(pkg.name, pkg.version), "project.toml"),
      );
      console.log(
        cached
          ? `using cached ${pkg.name}@${pkg.version}`
          : `installing ${pkg.name}@${pkg.version}`,
      );
      await installPackageVersion(
        project.root,
        pkg.name,
        pkg.version,
        pkg.checksum,
      );
    }
    return lock.packages;
  }

  console.log("resolving dependencies");
  return resolveAndInstall(project);
}

/**
 * Re-resolve dependencies from project.toml ranges and refresh the lockfile.
 *
 * When `only` is set, keep locked versions for other packages when they still
 * satisfy constraints; float `only` to the highest matching version.
 */
export async function updateProjectDependencies(
  project: Project,
  only?: string,
): Promise<readonly LockPackage[]> {
  if (only && !(only in project.dependencies)) {
    throw new ResolveError(`dependency '${only}' is not in project.toml`);
  }

  if (!only) {
    console.log("updating dependencies");
    return resolveAndInstall(project);
  }

  const lock = loadLockfile(project.root);
  const prefer = new Map<string, string>();
  if (lock) {
    for (const pkg of lock.packages) {
      prefer.set(pkg.name, pkg.version);
    }
  }
  console.log(`updating ${only}`);
  return resolveAndInstall(project, {
    prefer,
    float: new Set([only]),
  });
}

export function removeInstalledPackage(
  projectRoot: string,
  name: string,
  version?: string,
): void {
  if (version) {
    removeDependant(name, version, projectRoot);
    return;
  }
  const lock = loadLockfile(projectRoot);
  const entry = lockPackageMap(lock).get(name);
  if (entry) {
    removeDependant(name, entry.version, projectRoot);
    return;
  }
  releasePreviousVersion(name, null, projectRoot);
}

/** Map package names → global package roots for this project's lockfile. */
export function discoverInstalledPackages(
  project: Project,
): Map<string, { dir: string; version: string }> {
  const map = new Map<string, { dir: string; version: string }>();
  const lock = lockPackageMap(loadLockfile(project.root));

  for (const [name, entry] of lock) {
    const dir = packageVersionPath(name, entry.version);
    if (existsSync(join(dir, "project.toml"))) {
      map.set(name, { dir, version: entry.version });
    }
  }
  return map;
}
