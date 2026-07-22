import { createRequire } from "node:module";
import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function resolveServerModule(): string {
  const require = createRequire(__filename);
  try {
    return require.resolve("@typescript-native/lsp/dist/server.js");
  } catch {
    return path.join(__dirname, "..", "..", "lsp", "dist", "server.js");
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const serverModule = resolveServerModule();

  const serverOptions: ServerOptions = {
    run: {
      command: process.execPath,
      args: [serverModule, "--stdio"],
      options: { cwd: path.dirname(serverModule) },
    },
    debug: {
      command: process.execPath,
      args: ["--nolazy", "--inspect=6009", serverModule, "--stdio"],
      options: { cwd: path.dirname(serverModule) },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "tsn" },
      { scheme: "untitled", language: "tsn" },
    ],
  };

  client = new LanguageClient(
    "typescriptNative",
    "TypeScript Native",
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(client);
  await client.start();
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
