import { packProject } from "../deps/pack.js";
import { loadCredentials } from "../config.js";
import { loadProject, ProjectError } from "../project.js";
import { RegistryError } from "../registry/client.js";
import { publishPackageVersion } from "../registry/packages.js";

export async function runPublish(): Promise<number> {
  try {
    if (!loadCredentials()) {
      console.error("error: not logged in (run `sn login`)");
      return 1;
    }

    const project = loadProject();
    const { name, version, description } = project.package;

    console.log(`packing ${name}@${version}`);
    const packed = await packProject(project);
    try {
      console.log(`publishing ${name}@${version}`);
      const publishOpts: {
        name: string;
        version: string;
        description?: string;
        archivePath: string;
        archiveBytes: Uint8Array;
      } = {
        name,
        version,
        archivePath: packed.archivePath,
        archiveBytes: packed.bytes,
      };
      if (description) {
        publishOpts.description = description;
      }
      const result = await publishPackageVersion(publishOpts);
      console.log(
        `published ${result.name}@${result.version} (${result.sizeBytes} bytes)`,
      );
      return 0;
    } finally {
      packed.cleanup();
    }
  } catch (error) {
    const message =
      error instanceof ProjectError || error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}
