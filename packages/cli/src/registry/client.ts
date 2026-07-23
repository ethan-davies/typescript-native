import { getRegistryUrl, loadCredentials } from "../config.js";

export class RegistryError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
  }
}

export interface RegistryRequestOptions {
  readonly method?: string;
  readonly body?: string | FormData | Blob | ArrayBuffer | null;
  readonly headers?: Record<string, string>;
  /** When true, attach Bearer token from credentials (required if missing). */
  readonly auth?: boolean;
  /** When true, attach Bearer token if present (optional). */
  readonly authOptional?: boolean;
  /** Return raw Response instead of parsing JSON. */
  readonly raw?: boolean;
}

function authHeader(required: boolean): Record<string, string> {
  const creds = loadCredentials();
  if (!creds) {
    if (required) {
      throw new RegistryError(
        "not logged in (run `sn login`)",
        401,
        "unauthorized",
      );
    }
    return {};
  }
  return { Authorization: `Bearer ${creds.token}` };
}

export async function registryFetch(
  path: string,
  options: RegistryRequestOptions = {},
): Promise<Response> {
  const base = getRegistryUrl();
  const url = path.startsWith("http")
    ? path
    : `${base}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.auth) {
    Object.assign(headers, authHeader(true));
  } else if (options.authOptional) {
    Object.assign(headers, authHeader(false));
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    redirect: "follow",
  };
  if (options.body !== undefined && options.body !== null) {
    init.body = options.body;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RegistryError(`network error: ${message}`, 0);
  }
  return response;
}

export async function registryJson<T>(
  path: string,
  options: RegistryRequestOptions = {},
): Promise<T> {
  const response = await registryFetch(path, options);
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new RegistryError(
          `HTTP ${response.status}: ${text.slice(0, 200)}`,
          response.status,
        );
      }
      throw new RegistryError(
        `invalid JSON from registry (HTTP ${response.status})`,
        response.status,
      );
    }
  }

  if (!response.ok) {
    const obj =
      typeof data === "object" && data !== null
        ? (data as { error?: unknown; message?: unknown })
        : {};
    const code = typeof obj.error === "string" ? obj.error : undefined;
    const message =
      typeof obj.message === "string"
        ? obj.message
        : code
          ? code
          : `HTTP ${response.status}`;
    throw new RegistryError(message, response.status, code);
  }

  return data as T;
}
