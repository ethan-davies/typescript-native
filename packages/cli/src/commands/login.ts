import {
  loginWithDeviceFlow,
  revokeAndClearCredentials,
} from "../registry/auth.js";
import { loadCredentials } from "../config.js";
import { RegistryError } from "../registry/client.js";

export async function runLogin(): Promise<number> {
  try {
    const existing = loadCredentials();
    if (existing) {
      console.log(
        `already logged in as ${existing.username ?? "(token present)"}; continuing will replace the token`,
      );
    }
    const creds = await loginWithDeviceFlow();
    console.log(`logged in as ${creds.username ?? "unknown"}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}

export async function runLogout(): Promise<number> {
  try {
    if (!loadCredentials()) {
      console.log("not logged in");
      return 0;
    }
    await revokeAndClearCredentials();
    console.log("logged out");
    return 0;
  } catch (error) {
    if (error instanceof RegistryError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}
