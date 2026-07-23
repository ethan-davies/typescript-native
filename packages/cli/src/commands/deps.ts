import {
  installPackageVersion,
  installProjectDependencies,
  removeInstalledPackage,
  resolveInstallVersion,
} from "../deps/install.js";
import {
  loadLockfile,
  lockPackageMap,
  writeLockfile,
  type LockPackage,
} from "../deps/lock.js";
import {
  isValidPackageName,
  parsePackageSpec,
  removeDependency,
  setDependency,
} from "../deps/manifest.js";
import { loadProject, ProjectError } from "../project.js";
import { RegistryError } from "../registry/client.js";
import { getPackage } from "../registry/packages.js";

function printError(error: unknown): void {
  const message =
    error instanceof ProjectError || error instanceof RegistryError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`error: ${message}`);
}

export async function runAdd(spec: string): Promise<number> {
  try {
    const project = loadProject();
    const { name, version: requested } = parsePackageSpec(spec);
    if (!isValidPackageName(name)) {
      console.error(`error: invalid package name '${name}'`);
      return 1;
    }

    const resolved = await resolveInstallVersion(name, requested);
    console.log(`adding ${name}@${resolved.version}`);
    setDependency(project, name, resolved.version);
    const entry = await installPackageVersion(
      project.root,
      name,
      resolved.version,
      resolved.checksum,
    );

    const lock = loadLockfile(project.root);
    const map = lockPackageMap(lock);
    map.set(name, entry);
    // Keep only current dependencies + this one.
    const refreshed = loadProject(project.root);
    const packages: LockPackage[] = [];
    for (const depName of Object.keys(refreshed.dependencies)) {
      const locked = map.get(depName);
      if (locked) {
        packages.push(locked);
      }
    }
    writeLockfile(project.root, packages);

    console.log(`added ${name}@${resolved.version}`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runRemove(name: string): Promise<number> {
  try {
    const project = loadProject();
    const lock = loadLockfile(project.root);
    const previous = lockPackageMap(lock).get(name);

    removeDependency(project, name);
    removeInstalledPackage(
      project.root,
      name,
      previous?.version,
    );

    const map = lockPackageMap(lock);
    map.delete(name);
    writeLockfile(project.root, [...map.values()]);

    console.log(`removed ${name}`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runInstall(): Promise<number> {
  try {
    const project = loadProject();
    const deps = Object.keys(project.dependencies);
    if (deps.length === 0) {
      // Unregister any previously locked packages for this project.
      const lock = loadLockfile(project.root);
      if (lock) {
        for (const entry of lock.packages) {
          removeInstalledPackage(project.root, entry.name, entry.version);
        }
      }
      console.log("no dependencies to install");
      writeLockfile(project.root, []);
      return 0;
    }
    await installProjectDependencies(project);
    console.log(`installed ${deps.length} package(s)`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runUpdate(name: string | undefined): Promise<number> {
  try {
    const project = loadProject();
    const targets = name
      ? [name]
      : Object.keys(project.dependencies).sort();

    if (targets.length === 0) {
      console.log("no dependencies to update");
      return 0;
    }

    if (name && !(name in project.dependencies)) {
      console.error(`error: dependency '${name}' is not in project.toml`);
      return 1;
    }

    const lock = loadLockfile(project.root);
    const map = lockPackageMap(lock);

    for (const depName of targets) {
      const pkg = await getPackage(depName);
      if (!pkg.latestVersion) {
        console.error(`error: package '${depName}' has no published versions`);
        return 1;
      }
      const version = pkg.latestVersion.version;
      console.log(`updating ${depName}@${version}`);
      setDependency(loadProject(project.root), depName, version);
      const entry = await installPackageVersion(
        project.root,
        depName,
        version,
        pkg.latestVersion.checksumSha256,
      );
      map.set(depName, entry);
    }

    const refreshed = loadProject(project.root);
    const packages: LockPackage[] = [];
    for (const depName of Object.keys(refreshed.dependencies)) {
      const locked = map.get(depName);
      if (locked) {
        packages.push(locked);
      }
    }
    writeLockfile(project.root, packages);
    console.log("update complete");
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}
