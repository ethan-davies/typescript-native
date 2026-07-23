import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { registryFetch, registryJson, RegistryError } from "./client.js";

export interface PackageOwner {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string;
}

export interface PackageSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly owner: PackageOwner;
}

export interface PackageVersionInfo {
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface PackageDetails extends PackageSummary {
  readonly latestVersion: PackageVersionInfo | null;
}

export interface VersionDetails {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly publishedBy: PackageOwner;
}

export async function searchPackages(
  query: string | undefined,
  limit = 20,
): Promise<{
  packages: PackageSummary[];
  pagination: { limit: number; offset: number; total: number };
}> {
  const params = new URLSearchParams();
  if (query) {
    params.set("q", query);
  }
  params.set("limit", String(limit));
  const qs = params.toString();
  return registryJson(`/packages?${qs}`);
}

export async function getPackage(name: string): Promise<PackageDetails> {
  return registryJson(`/packages/${encodeURIComponent(name)}`);
}

export async function listVersions(name: string): Promise<{
  name: string;
  versions: Array<
    VersionDetails & { publishedBy: PackageOwner }
  >;
}> {
  return registryJson(`/packages/${encodeURIComponent(name)}/versions`);
}

export async function getVersion(
  name: string,
  version: string,
): Promise<VersionDetails> {
  return registryJson(
    `/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  );
}

export interface DownloadResult {
  readonly checksumSha256: string;
  readonly sizeBytes: number;
}

/**
 * Download a package version archive to `destPath`, verifying X-Checksum-SHA256 when present.
 */
export async function downloadPackageVersion(
  name: string,
  version: string,
  destPath: string,
): Promise<DownloadResult> {
  const response = await registryFetch(
    `/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/download`,
  );
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      code = body.error;
      throw new RegistryError(
        body.message ?? body.error ?? `HTTP ${response.status}`,
        response.status,
        code,
      );
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      throw new RegistryError(`HTTP ${response.status}`, response.status);
    }
  }

  const expected =
    response.headers.get("X-Checksum-SHA256") ??
    response.headers.get("x-checksum-sha256") ??
    undefined;

  mkdirSync(dirname(destPath), { recursive: true });
  if (!response.body) {
    throw new RegistryError("empty download body", 502, "download_failed");
  }

  const hash = createHash("sha256");
  const nodeStream = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
  nodeStream.on("data", (chunk: Buffer | string) => {
    hash.update(chunk);
  });

  await pipeline(nodeStream, createWriteStream(destPath));
  const checksumSha256 = hash.digest("hex");

  if (expected && expected.toLowerCase() !== checksumSha256.toLowerCase()) {
    throw new RegistryError(
      `checksum mismatch for ${name}@${version}`,
      502,
      "checksum_mismatch",
    );
  }

  return {
    checksumSha256,
    sizeBytes: Number(response.headers.get("content-length") ?? 0),
  };
}

export interface PublishResult {
  readonly name: string;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly owner: PackageOwner;
}

export async function publishPackageVersion(options: {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
  readonly archivePath: string;
  readonly archiveBytes: Uint8Array;
}): Promise<PublishResult> {
  const form = new FormData();
  form.append("version", options.version);
  if (options.description !== undefined) {
    form.append("description", options.description);
  }
  if (options.metadata !== undefined) {
    form.append("metadata", JSON.stringify(options.metadata));
  }
  const fileName = `${options.name}-${options.version}.tar.gz`;
  form.append(
    "file",
    new Blob([Buffer.from(options.archiveBytes)], { type: "application/gzip" }),
    fileName,
  );

  return registryJson(
    `/packages/${encodeURIComponent(options.name)}/versions`,
    {
      method: "POST",
      auth: true,
      body: form,
    },
  );
}
