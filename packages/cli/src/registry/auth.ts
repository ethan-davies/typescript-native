import { spawn } from "node:child_process";
import { platform } from "node:os";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "../config.js";
import { registryJson, RegistryError } from "./client.js";

export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface TokenSuccessResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly user: {
    readonly id: string;
    readonly githubId: string;
    readonly username: string;
    readonly avatarUrl: string;
  };
}

export interface AuthUser {
  readonly id: string;
  readonly githubId: string;
  readonly username: string;
  readonly avatarUrl: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // User can open the URL manually.
  }
}

export async function startDeviceLogin(): Promise<DeviceCodeResponse> {
  return registryJson<DeviceCodeResponse>("/auth/cli/device", {
    method: "POST",
  });
}

export async function pollDeviceToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
): Promise<TokenSuccessResponse> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = Math.max(1, intervalSeconds) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      return await registryJson<TokenSuccessResponse>("/auth/cli/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch (error) {
      if (!(error instanceof RegistryError)) {
        throw error;
      }
      if (error.code === "authorization_pending") {
        continue;
      }
      if (error.code === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      throw error;
    }
  }
  throw new RegistryError("device code expired", 400, "expired_token");
}

export async function loginWithDeviceFlow(): Promise<Credentials> {
  const device = await startDeviceLogin();

  console.log(`Open ${device.verification_uri_complete}`);
  console.log(`and confirm code: ${device.user_code}`);
  openBrowser(device.verification_uri_complete);

  const token = await pollDeviceToken(
    device.device_code,
    device.interval,
    device.expires_in,
  );

  const credentials: Credentials = {
    token: token.access_token,
    username: token.user.username,
  };
  saveCredentials(credentials);
  return credentials;
}

export async function fetchAuthMe(): Promise<AuthUser> {
  const data = await registryJson<{ user: AuthUser }>("/auth/me", {
    auth: true,
  });
  return data.user;
}

export async function revokeAndClearCredentials(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    clearCredentials();
    return;
  }
  try {
    await registryJson<{ ok: boolean }>("/auth/cli/revoke", {
      method: "POST",
      auth: true,
    });
  } catch (error) {
    // Still clear local credentials even if revoke fails (e.g. already revoked).
    if (
      !(error instanceof RegistryError) ||
      (error.code !== "invalid_token" && error.status !== 401)
    ) {
      clearCredentials();
      throw error;
    }
  }
  clearCredentials();
}
