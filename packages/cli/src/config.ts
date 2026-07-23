import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_REGISTRY_URL = "https://api-sonite.ethann.dev";

/** App directory name for user-facing paths (config, cache). */
export const APP_DIR_NAME = "sonite";

export interface Credentials {
  readonly token: string;
  readonly username?: string;
}

/** Cross-platform user config directory (`~/.config/sonite`, etc.). */
export function getConfigDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return join(
      appData || join(homedir(), "AppData", "Roaming"),
      APP_DIR_NAME,
    );
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), APP_DIR_NAME);
}

/**
 * Cross-platform cache directory (`~/.cache/sonite`, etc.).
 * Override with `SN_CACHE_DIR` (compact env name).
 */
export function getCacheDir(): string {
  const override = process.env.SN_CACHE_DIR?.trim();
  if (override) {
    return override;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", APP_DIR_NAME);
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim();
    return join(
      local || join(homedir(), "AppData", "Local"),
      APP_DIR_NAME,
      "Cache",
    );
  }
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return join(xdg || join(homedir(), ".cache"), APP_DIR_NAME);
}

/** Global registry package store: `<config>/packages`. */
export function getPackagesStoreDir(): string {
  return join(getConfigDir(), "packages");
}

export function getRegistryUrl(): string {
  const override = process.env.SN_REGISTRY_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }
  return DEFAULT_REGISTRY_URL;
}

function credentialsPath(): string {
  return join(getConfigDir(), "credentials.json");
}

export function loadCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as { token?: unknown }).token !== "string" ||
      !(raw as { token: string }).token
    ) {
      return null;
    }
    const creds = raw as { token: string; username?: unknown };
    const result: Credentials = { token: creds.token };
    if (typeof creds.username === "string" && creds.username) {
      return { ...result, username: creds.username };
    }
    return result;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: Credentials): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  const path = credentialsPath();
  const body: Record<string, string> = { token: credentials.token };
  if (credentials.username) {
    body.username = credentials.username;
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some FS ignore mode bits.
  }
}

export function clearCredentials(): void {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // Best-effort delete.
  }
}
