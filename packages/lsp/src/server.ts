#!/usr/bin/env node
import type { AnalyzeResult, ExportIndexEntry, SemanticModel } from "@sonite/compiler";
import {
  definitionAt,
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
  type CancellationToken,
  type InitializeParams,
  type InitializeResult,
  type TextEdit,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  analyzeWithOverlay,
  buildExportIndexForFile,
  buildWorkspaceImportGraph,
  codeActionsAtPosition,
  completionsAtPosition,
  definitionAtPosition,
  diagnosticsByFile,
  documentSymbolsAtFile,
  hoverAtPosition,
  listWorkspaceFiles,
  pathToUri,
  positionToOffset,
  prepareRenameAtPosition,
  renameAtPosition,
  replaceReverseDepsForResult,
  semanticTokensAtFile,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  signatureHelpAtPosition,
  uriToPath,
  workspaceReferencesAtPosition,
} from "./protocol.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/** Per-entry analysis cache with LRU eviction. */
const ANALYSIS_CACHE_LIMIT = 64;
const analysisCache = new Map<string, AnalyzeResult>();
const analysisTouchOrder: string[] = [];

/** Shared export index for the workspace (rebuilt in background). */
let sharedExportIndex: ExportIndexEntry[] | null = null;
let exportIndexGeneration = 0;

/** imported path → set of importer paths */
const reverseDeps = new Map<string, Set<string>>();

/** Document path → version that triggered the latest scheduled analyze */
const pendingAnalyzeVersion = new Map<string, number>();
/** Document path → last successfully published analyze version */
const publishedAnalyzeVersion = new Map<string, number>();

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 250;
let workspaceRoots: string[] = [];
let indexAbort: AbortController | null = null;
let activeDocumentPath: string | null = null;
let reindexTimer: ReturnType<typeof setTimeout> | null = null;
const REINDEX_DEBOUNCE_MS = 500;

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
      textDocumentSync: TextDocumentSyncKind.Incremental,
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

connection.onInitialized(() => {
  scheduleBackgroundIndex();
});

function getOverlay() {
  return {
    getDocument(path: string): string | undefined {
      const uri = pathToUri(path);
      return documents.get(uri)?.getText();
    },
  };
}

function touchCache(filePath: string): void {
  const idx = analysisTouchOrder.indexOf(filePath);
  if (idx >= 0) {
    analysisTouchOrder.splice(idx, 1);
  }
  analysisTouchOrder.push(filePath);
  while (analysisTouchOrder.length > ANALYSIS_CACHE_LIMIT) {
    const evict = analysisTouchOrder.shift();
    if (!evict) {
      break;
    }
    // Prefer keeping open documents.
    if (documents.get(pathToUri(evict))) {
      analysisTouchOrder.push(evict);
      if (analysisTouchOrder.length <= ANALYSIS_CACHE_LIMIT) {
        break;
      }
      // Still over limit with all open — drop oldest anyway after one pass.
      if (analysisTouchOrder[0] === evict) {
        analysisTouchOrder.shift();
        analysisCache.delete(evict);
        break;
      }
      continue;
    }
    analysisCache.delete(evict);
  }
}

function setAnalysisCache(filePath: string, result: AnalyzeResult): void {
  analysisCache.set(filePath, result);
  touchCache(filePath);
}

function invalidateExportIndexForFile(filePath: string): void {
  if (sharedExportIndex) {
    sharedExportIndex = sharedExportIndex.filter(
      (e) => e.modulePath !== filePath,
    );
  }
  scheduleDebouncedReindex();
}

function scheduleDebouncedReindex(): void {
  if (reindexTimer) {
    clearTimeout(reindexTimer);
  }
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    scheduleBackgroundIndex();
  }, REINDEX_DEBOUNCE_MS);
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
  if (sharedExportIndex) {
    return sharedExportIndex;
  }
  // Fallback: build synchronously for the requesting file.
  return buildExportIndexForFile(filePath, workspaceRoots, getOverlay());
}

function documentVersion(filePath: string): number {
  const doc = documents.get(pathToUri(filePath));
  return doc?.version ?? 0;
}

function scheduleAnalyze(filePath: string, priority = false): void {
  const version = documentVersion(filePath);
  pendingAnalyzeVersion.set(filePath, version);
  const existing = debounceTimers.get(filePath);
  if (existing) {
    clearTimeout(existing);
  }
  const delay = priority ? 0 : DEBOUNCE_MS;
  const timer = setTimeout(() => {
    debounceTimers.delete(filePath);
    void runAnalyze(filePath, version);
  }, delay);
  debounceTimers.set(filePath, timer);
}

async function runAnalyze(filePath: string, version: number): Promise<void> {
  const current = documentVersion(filePath);
  if (version < current) {
    return;
  }
  const pending = pendingAnalyzeVersion.get(filePath);
  if (pending !== undefined && version < pending) {
    return;
  }

  let result: AnalyzeResult;
  try {
    result = analyzeWithOverlay(filePath, getOverlay());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`analyze failed for ${filePath}: ${message}`);
    if (version < documentVersion(filePath)) {
      return;
    }
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

  if (version < documentVersion(filePath)) {
    return;
  }

  setAnalysisCache(filePath, result);
  replaceReverseDepsForResult(reverseDeps, result, filePath);
  publishedAnalyzeVersion.set(filePath, version);

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
    touchCache(filePath);
    return cached;
  }
  const result = analyzeWithOverlay(filePath, getOverlay());
  setAnalysisCache(filePath, result);
  replaceReverseDepsForResult(reverseDeps, result, filePath);
  return result;
}

function tryEnsureAnalyzed(filePath: string): AnalyzeResult | null {
  try {
    return ensureAnalyzed(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`ensureAnalyzed failed for ${filePath}: ${message}`);
    return null;
  }
}

function getImportersOf(defFile: string): string[] {
  const fromLive = reverseDeps.get(defFile);
  return fromLive ? [...fromLive] : [];
}

function modelsForWorkspaceRefs(
  primaryFile: string,
  defFile: string,
  token?: CancellationToken,
): { primary: SemanticModel; extras: SemanticModel[] } | null {
  const primaryResult = tryEnsureAnalyzed(primaryFile);
  if (!primaryResult) {
    return null;
  }
  const extras: SemanticModel[] = [];
  const seen = new Set<string>([primaryFile]);
  const candidates = new Set<string>([defFile, ...getImportersOf(defFile)]);
  for (const entry of candidates) {
    if (token?.isCancellationRequested) {
      break;
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    const result = tryEnsureAnalyzed(entry);
    if (result) {
      extras.push(result.semantic);
    }
  }
  return { primary: primaryResult.semantic, extras };
}

function throwIfCancelled(token?: CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new ResponseError(-32800, "Request cancelled");
  }
}

function scheduleBackgroundIndex(): void {
  if (workspaceRoots.length === 0) {
    return;
  }
  indexAbort?.abort();
  const controller = new AbortController();
  indexAbort = controller;
  const generation = ++exportIndexGeneration;

  setImmediate(() => {
    void (async () => {
      try {
        const isCancelled = () =>
          controller.signal.aborted || generation !== exportIndexGeneration;
        // Priority: keep active document responsive — yield before heavy work.
        await yieldEventLoop();
        if (isCancelled()) {
          return;
        }

        const graph = buildWorkspaceImportGraph(
          workspaceRoots,
          getOverlay(),
          isCancelled,
        );
        if (isCancelled()) {
          return;
        }
        for (const [imported, importers] of graph) {
          const set = reverseDeps.get(imported) ?? new Set();
          for (const importer of importers) {
            set.add(importer);
          }
          reverseDeps.set(imported, set);
        }

        await yieldEventLoop();
        if (isCancelled()) {
          return;
        }

        const openSn = documents
          .all()
          .map((d) => uriToPath(d.uri))
          .find((p) => p.endsWith(".sn"));
        const workspaceSn = listWorkspaceFiles(workspaceRoots)[0];
        const importerPath =
          activeDocumentPath?.endsWith(".sn")
            ? activeDocumentPath
            : (openSn ??
              workspaceSn ??
              `${workspaceRoots[0]!.replace(/\/$/, "")}/main.sn`);

        const index = buildExportIndexForFile(
          importerPath,
          workspaceRoots,
          getOverlay(),
        );
        if (isCancelled()) {
          return;
        }
        sharedExportIndex = index;
        connection.console.info(
          `Indexed ${index.length} export symbols; ${graph.size} import edges`,
        );

        // Warm analysis for open documents first, then a few dependents.
        const openPaths = documents.all().map((d) => uriToPath(d.uri));
        for (const path of openPaths) {
          if (isCancelled()) {
            return;
          }
          tryEnsureAnalyzed(path);
          await yieldEventLoop();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        connection.console.error(`background index failed: ${message}`);
      }
    })();
  });
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

documents.onDidOpen((event) => {
  const filePath = uriToPath(event.document.uri);
  activeDocumentPath = filePath;
  invalidateDependents(filePath);
  invalidateExportIndexForFile(filePath);
  scheduleAnalyze(filePath, true);
});

documents.onDidChangeContent((event) => {
  const filePath = uriToPath(event.document.uri);
  activeDocumentPath = filePath;
  invalidateDependents(filePath);
  invalidateExportIndexForFile(filePath);
  scheduleAnalyze(filePath, filePath === activeDocumentPath);
});

documents.onDidClose((event) => {
  const path = uriToPath(event.document.uri);
  if (activeDocumentPath === path) {
    activeDocumentPath = null;
  }
  invalidateDependents(path);
  const timer = debounceTimers.get(path);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(path);
  }
  pendingAnalyzeVersion.delete(path);
  publishedAnalyzeVersion.delete(path);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

function withRequestGuard<T>(
  label: string,
  token: CancellationToken | undefined,
  fn: () => T,
  fallback: T,
): T {
  try {
    throwIfCancelled(token);
    const result = fn();
    throwIfCancelled(token);
    return result;
  } catch (err) {
    if (err instanceof ResponseError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`${label} failed: ${message}`);
    return fallback;
  }
}

connection.onHover((params, token) =>
  withRequestGuard("hover", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return null;
    }
    return hoverAtPosition(
      result.semantic,
      filePath,
      doc.getText(),
      params.position,
    );
  }, null),
);

connection.onDefinition((params, token) =>
  withRequestGuard("definition", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return null;
    }
    return definitionAtPosition(
      result.semantic,
      filePath,
      doc.getText(),
      params.position,
    );
  }, null),
);

connection.onCompletion((params, token) =>
  withRequestGuard("completion", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return [];
    }
    const exportIndex = getExportIndex(filePath);
    return completionsAtPosition(
      result.semantic,
      filePath,
      doc.getText(),
      params.position,
      exportIndex,
      workspaceRoots,
    );
  }, []),
);

connection.onReferences((params, token) =>
  withRequestGuard("references", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }
    const primary = tryEnsureAnalyzed(filePath);
    if (!primary) {
      return [];
    }
    const offsetSource = doc.getText();
    const offset = positionToOffset(offsetSource, params.position);
    const def = definitionAt(primary.semantic, filePath, offset);
    if (!def) {
      return [];
    }
    const models = modelsForWorkspaceRefs(filePath, def.file, token);
    if (!models) {
      return [];
    }
    const includeDeclaration = params.context?.includeDeclaration !== false;
    return workspaceReferencesAtPosition(
      models.primary,
      models.extras,
      filePath,
      offsetSource,
      params.position,
      includeDeclaration,
    );
  }, []),
);

connection.onDocumentSymbol((params, token) =>
  withRequestGuard("documentSymbol", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return [];
    }
    return documentSymbolsAtFile(result.semantic, filePath);
  }, []),
);

connection.onPrepareRename((params, token) =>
  withRequestGuard("prepareRename", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return null;
    }
    return prepareRenameAtPosition(
      result.semantic,
      filePath,
      doc.getText(),
      params.position,
    );
  }, null),
);

connection.onRenameRequest((params, token) =>
  withRequestGuard("rename", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }
    const primary = tryEnsureAnalyzed(filePath);
    if (!primary) {
      return null;
    }
    const offset = positionToOffset(doc.getText(), params.position);
    const def = definitionAt(primary.semantic, filePath, offset);
    const extras =
      def != null
        ? modelsForWorkspaceRefs(filePath, def.file, token)?.extras ?? []
        : [];
    const edit = renameAtPosition(
      primary.semantic,
      filePath,
      doc.getText(),
      params.position,
      params.newName,
      extras,
    );
    if (edit instanceof ResponseError) {
      throw edit;
    }
    return edit;
  }, null),
);

connection.onSignatureHelp((params, token) =>
  withRequestGuard("signatureHelp", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return null;
    }
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return null;
    }
    return signatureHelpAtPosition(
      result.semantic,
      filePath,
      doc.getText(),
      params.position,
    );
  }, null),
);

connection.onCodeAction((params, token) =>
  withRequestGuard("codeAction", token, () => {
    const filePath = uriToPath(params.textDocument.uri);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      return [];
    }
    const result = tryEnsureAnalyzed(filePath);
    if (!result) {
      return [];
    }
    const exportIndex = getExportIndex(filePath);
    return codeActionsAtPosition(
      result.semantic,
      filePath,
      doc.getText(),
      result.diagnostics,
      exportIndex,
    );
  }, []),
);

connection.languages.semanticTokens.on((params, token) =>
  withRequestGuard(
    "semanticTokens",
    token,
    () => {
      const filePath = uriToPath(params.textDocument.uri);
      const result = tryEnsureAnalyzed(filePath);
      if (!result) {
        return { data: [] };
      }
      return semanticTokensAtFile(result.semantic, filePath);
    },
    { data: [] },
  ),
);

connection.onDocumentFormatting((params, token): TextEdit[] =>
  withRequestGuard("formatting", token, () => {
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
  }, []),
);

documents.listen(connection);
connection.listen();
