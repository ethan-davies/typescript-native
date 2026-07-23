import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { getPackagesStoreDir } from "../config.js";
import { RegistryError } from "../registry/client.js";
import {
  downloadPackageVersion,
  getPackage,
  getVersion,
} from "../registry/packages.js";
import type { Project } from "../project.js";
import {
  loadLockfile,
  lockPackageMap,
  writeLockfile,
  type LockPackage,
} from "./lock.js";
import {
  addDependant,
  isPackageVersionInstalled,
  packageVersionPath,
  releasePreviousVersion,
  removeDependant,
} from "./store.js";

export async function resolveInstallVersion(
  name: string,
  requested: string | undefined,
): Promise<{ version: string; checksum: string }> {
  if (requested) {
    const ver = await getVersion(name, requested);
    return { version: ver.version, checksum: ver.checksumSha256 };
  }
  const pkg = await getPackage(name);
  if (!pkg.latestVersion) {
    throw new RegistryError(
      `package '${name}' has no published versions`,
      404,
      "not_found",
    );
  }
  return {
    version: pkg.latestVersion.version,
    checksum: pkg.latestVersion.checksumSha256,
  };
}

/**
 * Ensure `name@version` exists in the global store and register `projectRoot`
 * as a dependant. Skips download when already cached.
 */
export async function installPackageVersion(
  projectRoot: string,
  name: string,
  version: string,
  expectedChecksum?: string,
): Promise<LockPackage> {
  const dest = packageVersionPath(name, version);
  mkdirSync(getPackagesStoreDir(), { recursive: true });

  let checksum = expectedChecksum ?? "";

  if (!isPackageVersionInstalled(name, version)) {
    const tmp = mkdtempSync(join(tmpdir(), "sn-pkg-"));
    const archivePath = join(tmp, `${name}-${version}.tar.gz`);
    try {
      const downloaded = await downloadPackageVersion(
        name,
        version,
        archivePath,
      );
      checksum = downloaded.checksumSha256;
      if (
        expectedChecksum &&
        expectedChecksum.toLowerCase() !== checksum.toLowerCase()
      ) {
        throw new RegistryError(
          `checksum mismatch for ${name}@${version} (lockfile vs download)`,
          502,
          "checksum_mismatch",
        );
      }

      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      await tar.x({
        file: archivePath,
        cwd: dest,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else if (!checksum) {
    // Cached hit without a checksum from caller — keep empty; lock may refresh later.
    checksum = expectedChecksum ?? "";
  }

  // Drop this project from any other version of the same package, then register.
  releasePreviousVersion(name, version, projectRoot);
  addDependant(name, version, projectRoot);

  return { name, version, checksum };
}

export async function installProjectDependencies(
  project: Project,
): Promise<readonly LockPackage[]> {
  const lock = loadLockfile(project.root);
  const locked = lockPackageMap(lock);
  const installed: LockPackage[] = [];

  // Release deps that were removed from the manifest.
  for (const [name, entry] of locked) {
    if (!(name in project.dependencies)) {
      removeDependant(name, entry.version, project.root);
    }
  }

  for (const [name, versionPin] of Object.entries(project.dependencies)) {
    const lockEntry = locked.get(name);
    const checksumHint =
      lockEntry && lockEntry.version === versionPin
        ? lockEntry.checksum
        : undefined;

    const cached = isPackageVersionInstalled(name, versionPin);
    console.log(
      cached
        ? `using cached ${name}@${versionPin}`
        : `installing ${name}@${versionPin}`,
    );
    const entry = await installPackageVersion(
      project.root,
      name,
      versionPin,
      checksumHint,
    );
    // Prefer lock checksum when we skipped download and had one.
    installed.push({
      name: entry.name,
      version: entry.version,
      checksum: entry.checksum || checksumHint || "",
    });
  }

  writeLockfile(project.root, installed);
  return installed;
}

/**
 * Unregister this project's use of `name` (version from lockfile if present).
 * Removes the global cache entry when no projects remain.
 */
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
  // Fallback: release any version this project was registered for.
  releasePreviousVersion(name, null, projectRoot);
}

/**
 * Map dependency names → global package root for the versions this project uses.
 */
export function discoverInstalledPackages(
  project: Project,
): Map<string, string> {
  const map = new Map<string, string>();
  const lock = lockPackageMap(loadLockfile(project.root));

  for (const [name, versionPin] of Object.entries(project.dependencies)) {
    const version = lock.get(name)?.version ?? versionPin;
    const dir = packageVersionPath(name, version);
    if (existsSync(join(dir, "project.toml"))) {
      map.set(name, dir);
    }
  }
  return map;
}
