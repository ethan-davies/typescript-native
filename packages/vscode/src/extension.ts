import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  RevealOutputChannelOn,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function resolveServerModule(): string {
  const require = createRequire(__filename);
  try {
    return require.resolve("@typescript-native/lsp/dist/server.js");
  } catch {
    const fallback = path.join(__dirname, "..", "..", "lsp", "dist", "server.js");
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    throw new Error(
      "Could not find @typescript-native/lsp server. Build it with: pnpm --filter @typescript-native/lsp build",
    );
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("TypeScript Native");
  context.subscriptions.push(output);

  let serverModule: string;
  try {
    serverModule = resolveServerModule();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`TypeScript Native LSP: ${message}`);
    return;
  }

  output.appendLine(`Starting language server: ${serverModule}`);

  const serverOptions: ServerOptions = {
    run: {
      command: process.execPath,
      args: [serverModule, "--stdio"],
      options: {
        cwd: path.dirname(path.dirname(serverModule)),
        env: { ...process.env },
      },
    },
    debug: {
      command: process.execPath,
      args: ["--nolazy", "--inspect=6009", serverModule, "--stdio"],
      options: {
        cwd: path.dirname(path.dirname(serverModule)),
        env: { ...process.env },
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "tsn" },
      { scheme: "untitled", language: "tsn" },
    ],
    outputChannel: output,
    traceOutputChannel: output,
    revealOutputChannelOn: RevealOutputChannelOn.Error,
  };

  client = new LanguageClient(
    "typescriptNative",
    "TypeScript Native",
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(client);

  try {
    await client.start();
    output.appendLine("Language server started.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Failed to start language server: ${message}`);
    void vscode.window.showErrorMessage(
      `TypeScript Native LSP failed to start: ${message}`,
    );
  }
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
