import { searchPackages, getPackage, listVersions } from "../registry/packages.js";
import { RegistryError } from "../registry/client.js";

export async function runSearch(query: string | undefined): Promise<number> {
  try {
    const result = await searchPackages(query, 20);
    if (result.packages.length === 0) {
      console.log("no packages found");
      return 0;
    }
    for (const pkg of result.packages) {
      const desc = pkg.description ? ` — ${pkg.description}` : "";
      console.log(`${pkg.name} (by ${pkg.owner.username})${desc}`);
    }
    if (result.pagination.total > result.packages.length) {
      console.log(
        `(showing ${result.packages.length} of ${result.pagination.total})`,
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}

export async function runInfo(name: string): Promise<number> {
  try {
    const pkg = await getPackage(name);
    console.log(`name: ${pkg.name}`);
    console.log(`description: ${pkg.description || "(none)"}`);
    console.log(`owner: ${pkg.owner.username}`);
    console.log(`created: ${pkg.createdAt}`);
    if (pkg.latestVersion) {
      console.log(`latest: ${pkg.latestVersion.version}`);
      console.log(`size: ${pkg.latestVersion.sizeBytes} bytes`);
      console.log(`checksum: ${pkg.latestVersion.checksumSha256}`);
    } else {
      console.log("latest: (no versions)");
    }

    const versions = await listVersions(name);
    if (versions.versions.length > 0) {
      console.log("versions:");
      for (const v of versions.versions) {
        console.log(`  ${v.version} (${v.createdAt})`);
      }
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}
