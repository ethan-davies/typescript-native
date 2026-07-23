import { setPackageRootsProvider } from "@sonite/compiler";
import { findProjectManifest, loadProjectFromManifest } from "../project.js";
import { discoverInstalledPackages } from "./install.js";

/**
 * Register this project's dependencies from the global package store
 * for bare import resolution.
 */
export function applyProjectPackageRoots(startDir?: string): void {
  const manifest = findProjectManifest(startDir);
  if (!manifest) {
    setPackageRootsProvider(null);
    return;
  }
  try {
    const project = loadProjectFromManifest(manifest);
    const packages = discoverInstalledPackages(project);
    setPackageRootsProvider(() => packages);
  } catch {
    setPackageRootsProvider(null);
  }
}
