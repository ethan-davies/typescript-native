#!/usr/bin/env node
import type { AnalyzeResult, ExportIndexEntry } from "@sonite/compiler";
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  analyzeWithOverlay,
  buildExportIndexForFile,
  completionsAtPosition,
  definitionAtPosition,
  diagnosticsByFile,
  documentSymbolsAtFile,
  hoverAtPosition,
  pathToUri,
  referencesAtPosition,
  uriToPath,
} from "./protocol.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analysisCache = new Map<string, AnalyzeResult>();
const exportIndexCache = new Map<string, ExportIndexEntry[]>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 250;
let workspaceRoots: string[] = [];

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const folders = params.workspaceFolders ?? [];
  workspaceRoots = folders.map((f) => uriToPath(f.uri));
  if (workspaceRoots.length === 0 && params.rootUri) {
    workspaceRoots = [uriToPath(params.rootUri)];
  }
  if (workspaceRoots.length === 0 && params.rootPath) {
    workspaceRoots = [params.rootPath];
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
      definitionProvider: true,
      completionProvider: {
        triggerCharacters: [
          ".",
          ":",
          '"',
          "/",
          "a",
          "b",
          "c",
          "d",
          "e",
          "f",
          "g",
          "h",
          "i",
          "j",
          "k",
          "l",
          "m",
          "n",
          "o",
          "p",
          "q",
          "r",
          "s",
          "t",
          "u",
          "v",
          "w",
          "x",
          "y",
          "z",
          "A",
          "B",
          "C",
          "D",
          "E",
          "F",
          "G",
          "H",
          "I",
          "J",
          "K",
          "L",
          "M",
          "N",
          "O",
          "P",
          "Q",
          "R",
          "S",
          "T",
          "U",
          "V",
          "W",
          "X",
          "Y",
          "Z",
          "_",
        ],
        resolveProvider: false,
      },
      documentSymbolProvider: true,
      referencesProvider: true,
    },
  };
});

function getOverlay() {
  return {
    getDocument(path: string): string | undefined {
      const uri = pathToUri(path);
      return documents.get(uri)?.getText();
    },
  };
}

function invalidateExportIndex(): void {
  exportIndexCache.clear();
}

function getExportIndex(filePath: string): ExportIndexEntry[] {
  const cached = exportIndexCache.get(filePath);
  if (cached) {
    return cached;
  }
  const index = buildExportIndexForFile(filePath, workspaceRoots, getOverlay());
  exportIndexCache.set(filePath, index);
  return index;
}

function scheduleAnalyze(filePath: string): void {
  const existing = debounceTimers.get(filePath);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(filePath);
    void runAnalyze(filePath);
  }, DEBOUNCE_MS);
  debounceTimers.set(filePath, timer);
}

async function runAnalyze(filePath: string): Promise<void> {
  let result: AnalyzeResult;
  try {
    result = analyzeWithOverlay(filePath, getOverlay());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`analyze failed for ${filePath}: ${message}`);
    connection.sendDiagnostics({
      uri: pathToUri(filePath),
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          message: `Language server analyze failed: ${message}`,
          severity: 1,
          source: "sn",
        },
      ],
    });
    return;
  }

  analysisCache.set(filePath, result);

  const byFile = diagnosticsByFile(result.diagnostics);
  const touched = new Set<string>([filePath, ...byFile.keys()]);
  for (const file of touched) {
    connection.sendDiagnostics({
      uri: pathToUri(file),
      diagnostics: byFile.get(file) ?? [],
    });
  }
}

function ensureAnalyzed(filePath: string): AnalyzeResult {
  const cached = analysisCache.get(filePath);
  if (cached) {
    return cached;
  }
  const result = analyzeWithOverlay(filePath, getOverlay());
  analysisCache.set(filePath, result);
  return result;
}

documents.onDidOpen((event) => {
  const filePath = uriToPath(event.document.uri);
  analysisCache.delete(filePath);
  invalidateExportIndex();
  scheduleAnalyze(filePath);
});

documents.onDidChangeContent((event) => {
  const filePath = uriToPath(event.document.uri);
  analysisCache.delete(filePath);
  invalidateExportIndex();
  scheduleAnalyze(filePath);
});

documents.onDidClose((event) => {
  const path = uriToPath(event.document.uri);
  analysisCache.delete(path);
  const timer = debounceTimers.get(path);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(path);
  }
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onHover((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }
  const result = ensureAnalyzed(filePath);
  return hoverAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
  );
});

connection.onDefinition((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }
  const result = ensureAnalyzed(filePath);
  return definitionAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
  );
});

connection.onCompletion((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }
  const result = ensureAnalyzed(filePath);
  const exportIndex = getExportIndex(filePath);
  // Trigger on quote for import path completion.
  void params;
  return completionsAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
    exportIndex,
    workspaceRoots,
  );
});

connection.onReferences((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }
  const result = ensureAnalyzed(filePath);
  return referencesAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
  );
});

connection.onDocumentSymbol((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const result = ensureAnalyzed(filePath);
  return documentSymbolsAtFile(result.semantic, filePath);
});

documents.listen(connection);
connection.listen();
