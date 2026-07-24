#!/usr/bin/env node
import type { AnalyzeResult, ExportIndexEntry } from "@sonite/compiler";
import {
  formatSource,
  loadFormatOptions,
} from "@sonite/compiler";
import {
  CodeActionKind,
  createConnection,
  ProposedFeatures,
  ResponseError,
  TextDocumentSyncKind,
  TextDocuments,
  type InitializeParams,
  type InitializeResult,
  type TextEdit,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  analyzeWithOverlay,
  buildExportIndexForFile,
  codeActionsAtPosition,
  collectReverseDeps,
  completionsAtPosition,
  definitionAtPosition,
  diagnosticsByFile,
  documentSymbolsAtFile,
  hoverAtPosition,
  pathToUri,
  prepareRenameAtPosition,
  referencesAtPosition,
  renameAtPosition,
  semanticTokensAtFile,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  signatureHelpAtPosition,
  uriToPath,
} from "./protocol.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analysisCache = new Map<string, AnalyzeResult>();
const exportIndexCache = new Map<string, ExportIndexEntry[]>();
/** imported path → set of importer paths that have been analyzed */
const reverseDeps = new Map<string, Set<string>>();
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
      renameProvider: {
        prepareProvider: true,
      },
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","],
      },
      codeActionProvider: {
        codeActionKinds: [
          CodeActionKind.QuickFix,
          CodeActionKind.SourceOrganizeImports,
        ],
      },
      documentFormattingProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
        },
        full: true,
      },
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

function mergeReverseDeps(result: AnalyzeResult): void {
  const edges = collectReverseDeps(result);
  for (const [imported, importers] of edges) {
    const set = reverseDeps.get(imported) ?? new Set();
    for (const importer of importers) {
      set.add(importer);
    }
    reverseDeps.set(imported, set);
  }
}

function invalidateDependents(filePath: string): void {
  analysisCache.delete(filePath);
  const importers = reverseDeps.get(filePath);
  if (!importers) {
    return;
  }
  for (const importer of importers) {
    analysisCache.delete(importer);
  }
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
  mergeReverseDeps(result);

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
  mergeReverseDeps(result);
  return result;
}

documents.onDidOpen((event) => {
  const filePath = uriToPath(event.document.uri);
  invalidateDependents(filePath);
  invalidateExportIndex();
  scheduleAnalyze(filePath);
});

documents.onDidChangeContent((event) => {
  const filePath = uriToPath(event.document.uri);
  invalidateDependents(filePath);
  invalidateExportIndex();
  scheduleAnalyze(filePath);
});

documents.onDidClose((event) => {
  const path = uriToPath(event.document.uri);
  invalidateDependents(path);
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
  const includeDeclaration = params.context?.includeDeclaration !== false;
  return referencesAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
    includeDeclaration,
  );
});

connection.onDocumentSymbol((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const result = ensureAnalyzed(filePath);
  return documentSymbolsAtFile(result.semantic, filePath);
});

connection.onPrepareRename((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }
  const result = ensureAnalyzed(filePath);
  return prepareRenameAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
  );
});

connection.onRenameRequest((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }
  const result = ensureAnalyzed(filePath);
  const edit = renameAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
    params.newName,
  );
  if (edit instanceof ResponseError) {
    throw edit;
  }
  return edit;
});

connection.onSignatureHelp((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }
  const result = ensureAnalyzed(filePath);
  return signatureHelpAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    params.position,
  );
});

connection.onCodeAction((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }
  const result = ensureAnalyzed(filePath);
  const exportIndex = getExportIndex(filePath);
  return codeActionsAtPosition(
    result.semantic,
    filePath,
    doc.getText(),
    result.diagnostics,
    exportIndex,
  );
});

connection.languages.semanticTokens.on((params) => {
  const filePath = uriToPath(params.textDocument.uri);
  const result = ensureAnalyzed(filePath);
  return semanticTokensAtFile(result.semantic, filePath);
});

connection.onDocumentFormatting((params): TextEdit[] => {
  const filePath = uriToPath(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return [];
  }
  const source = doc.getText();
  const formatOpts = loadFormatOptions(filePath);
  const result = formatSource(source, { ...formatOpts, fileName: filePath });
  if (!result.success || result.code === null || result.code === source) {
    return [];
  }
  const edit: TextEdit = {
    range: {
      start: doc.positionAt(0),
      end: doc.positionAt(source.length),
    },
    newText: result.code,
  };
  return [edit];
});

documents.listen(connection);
connection.listen();
