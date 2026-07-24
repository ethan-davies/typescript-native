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

/**
 * Prefer the bundled server shipped inside the VSIX (`dist/server.js`).
 * Fall back to `@sonite/lsp` / monorepo paths for Extension Development Host.
 */
function resolveServerModule(context: vscode.ExtensionContext): string {
  const bundled = context.asAbsolutePath(path.join("dist", "server.js"));
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const require = createRequire(__filename);
  try {
    return require.resolve("@sonite/lsp/dist/server.js");
  } catch {
    const fallback = path.join(
      __dirname,
      "..",
      "..",
      "lsp",
      "dist",
      "server.js",
    );
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    throw new Error(
      "Sonite language server not found. Reinstall the extension, or rebuild with: pnpm --filter sonite-vscode package",
    );
  }
}

function resolveStdRoot(context: vscode.ExtensionContext): string | undefined {
  const bundled = context.asAbsolutePath("stdlib");
  if (fs.existsSync(path.join(bundled, "prelude", "string.sn"))) {
    return bundled;
  }
  return undefined;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("Sonite");
  context.subscriptions.push(output);

  let serverModule: string;
  try {
    serverModule = resolveServerModule(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(message);
    void vscode.window.showErrorMessage(
      `Sonite language features unavailable: ${message}`,
    );
    return;
  }

  const stdRoot = resolveStdRoot(context);
  output.appendLine(`Starting language server: ${serverModule}`);
  if (stdRoot) {
    output.appendLine(`Standard library: ${stdRoot}`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (stdRoot) {
    env.SONITE_STD_ROOT = stdRoot;
  }

  const serverOptions: ServerOptions = {
    run: {
      command: process.execPath,
      args: [serverModule, "--stdio"],
      options: {
        cwd: path.dirname(serverModule),
        env,
      },
    },
    debug: {
      command: process.execPath,
      args: ["--nolazy", "--inspect=6009", serverModule, "--stdio"],
      options: {
        cwd: path.dirname(serverModule),
        env,
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "sn" },
      { scheme: "untitled", language: "sn" },
    ],
    outputChannel: output,
    traceOutputChannel: output,
    revealOutputChannelOn: RevealOutputChannelOn.Error,
  };

  client = new LanguageClient(
    "sonite",
    "Sonite",
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
      `Sonite language server failed to start: ${message}`,
    );
  }
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
