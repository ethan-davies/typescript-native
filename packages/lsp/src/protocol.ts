import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  analyzeFile,
  buildExportIndex,
  completionsAt,
  computeNamedImportEdit,
  definitionAt,
  documentSymbolsForFile,
  hoverAt,
  offsetToPosition,
  type AnalyzeResult,
  type Diagnostic as SnDiagnostic,
  type DocumentSymbolInfo,
  type DocumentSymbolKind,
  type ExportIndexEntry,
  type ScopeBindingInfo,
  type SemanticModel,
  type SourceSpan,
} from "@sonite/compiler";
import {
  CompletionItemKind,
  DiagnosticSeverity,
  SymbolKind,
  type CompletionItem,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type Position,
  type Range,
  type TextEdit,
} from "vscode-languageserver/node.js";

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return uri;
}

export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

export function spanToRange(span: SourceSpan): Range {
  return {
    start: {
      line: Math.max(0, span.start.line - 1),
      character: Math.max(0, span.start.column - 1),
    },
    end: {
      line: Math.max(0, span.end.line - 1),
      character: Math.max(0, span.end.column - 1),
    },
  };
}

export function positionToOffset(source: string, position: Position): number {
  let line = 0;
  let offset = 0;
  while (offset < source.length && line < position.line) {
    if (source[offset] === "\n") {
      line += 1;
    }
    offset += 1;
  }
  return offset + position.character;
}

function severityToLsp(severity: SnDiagnostic["severity"]): DiagnosticSeverity {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    case "info":
      return DiagnosticSeverity.Information;
  }
}

export function toLspDiagnostics(
  diagnostics: readonly SnDiagnostic[],
  filePath: string,
): Diagnostic[] {
  return diagnostics
    .filter((d) => d.file === undefined || d.file === filePath)
    .map((d) => {
      const range = d.span
        ? spanToRange(d.span)
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
      return {
        severity: severityToLsp(d.severity),
        range,
        message: d.message,
        source: "sn",
        ...(d.code ? { code: d.code } : {}),
      };
    });
}

function symbolKindToLsp(kind: DocumentSymbolKind): SymbolKind {
  switch (kind) {
    case "function":
    case "method":
      return SymbolKind.Function;
    case "struct":
      return SymbolKind.Struct;
    case "class":
      return SymbolKind.Class;
    case "interface":
      return SymbolKind.Interface;
    case "enum":
      return SymbolKind.Enum;
    case "type":
      return SymbolKind.TypeParameter;
    case "field":
      return SymbolKind.Field;
    case "constructor":
      return SymbolKind.Constructor;
    case "variant":
      return SymbolKind.EnumMember;
  }
}

function toDocumentSymbol(sym: DocumentSymbolInfo): DocumentSymbol {
  return {
    name: sym.name,
    kind: symbolKindToLsp(sym.kind),
    range: spanToRange(sym.span),
    selectionRange: spanToRange(sym.selectionSpan),
    children: sym.children.map(toDocumentSymbol),
  };
}

function completionKind(kind: ScopeBindingInfo["kind"]): CompletionItemKind {
  switch (kind) {
    case "keyword":
      return CompletionItemKind.Keyword;
    case "function":
      return CompletionItemKind.Function;
    case "method":
      return CompletionItemKind.Method;
    case "field":
      return CompletionItemKind.Field;
    case "property":
      return CompletionItemKind.Property;
    case "variable":
      return CompletionItemKind.Variable;
    case "parameter":
      return CompletionItemKind.Variable;
    case "constant":
      return CompletionItemKind.Constant;
    case "class":
      return CompletionItemKind.Class;
    case "struct":
      return CompletionItemKind.Struct;
    case "interface":
      return CompletionItemKind.Interface;
    case "enum":
      return CompletionItemKind.Enum;
    case "enumMember":
      return CompletionItemKind.EnumMember;
    case "type":
      return CompletionItemKind.TypeParameter;
    case "module":
      return CompletionItemKind.Module;
    case "constructor":
      return CompletionItemKind.Constructor;
  }
}

function autoImportTextEdits(
  source: string,
  semantic: SemanticModel,
  filePath: string,
  item: ScopeBindingInfo,
): TextEdit[] | undefined {
  if (!item.autoImport) {
    return undefined;
  }
  const mod = semantic.modules.find((m) => m.path === filePath);
  const edit = computeNamedImportEdit(
    source,
    mod?.ast,
    item.autoImport.moduleSpecifier,
    item.autoImport.exportName,
  );
  if (!edit) {
    return undefined;
  }
  const start = offsetToPosition(source, edit.startOffset);
  const end = offsetToPosition(source, edit.endOffset);
  return [
    {
      range: { start, end },
      newText: edit.newText,
    },
  ];
}

export function toCompletionItems(
  items: readonly ScopeBindingInfo[],
  prefix = "",
  position?: Position,
  options?: {
    source?: string;
    semantic?: SemanticModel;
    filePath?: string;
  },
): CompletionItem[] {
  return items.map((item, index) => {
    const kindRank: Record<ScopeBindingInfo["kind"], string> = {
      keyword: "0",
      parameter: "1",
      variable: "2",
      constant: "2",
      function: "3",
      method: "3",
      constructor: "3",
      field: "4",
      property: "4",
      class: "5",
      struct: "5",
      interface: "5",
      enum: "5",
      enumMember: "5",
      type: "5",
      module: "6",
    };
    // Auto-imports sort after already-available symbols of the same kind.
    const autoRank = item.autoImport ? "1" : "0";
    const completion: CompletionItem = {
      label: item.name,
      kind: completionKind(item.kind),
      detail: item.detail,
      insertText: item.name,
      sortText: `${kindRank[item.kind] ?? "9"}${autoRank}_${item.name.length.toString().padStart(3, "0")}_${index.toString().padStart(4, "0")}_${item.name}`,
    };
    if (prefix && position) {
      completion.textEdit = {
        range: {
          start: {
            line: position.line,
            character: Math.max(0, position.character - prefix.length),
          },
          end: position,
        },
        newText: item.name,
      };
    }
    if (
      item.autoImport &&
      options?.source &&
      options.semantic &&
      options.filePath
    ) {
      const edits = autoImportTextEdits(
        options.source,
        options.semantic,
        options.filePath,
        item,
      );
      if (edits && edits.length > 0) {
        completion.additionalTextEdits = edits;
      }
    }
    return completion;
  });
}

export interface WorkspaceOverlay {
  /** Absolute path → current editor contents */
  getDocument(path: string): string | undefined;
}

export function analyzeWithOverlay(
  entryPath: string,
  overlay: WorkspaceOverlay,
): AnalyzeResult {
  return analyzeFile(entryPath, {
    readFile: (absolutePath) => {
      const open = overlay.getDocument(absolutePath);
      if (open !== undefined) {
        return open;
      }
      return readFileSync(absolutePath, "utf8");
    },
  });
}

export function hoverAtPosition(
  semantic: SemanticModel,
  filePath: string,
  source: string,
  position: Position,
): Hover | null {
  const offset = positionToOffset(source, position);
  const info = hoverAt(semantic, filePath, offset);
  if (!info) {
    return null;
  }
  return {
    contents: {
      kind: "markdown",
      value: `\`\`\`sn\n${info.contents}\n\`\`\``,
    },
    range: spanToRange(info.span),
  };
}

export function definitionAtPosition(
  semantic: SemanticModel,
  filePath: string,
  source: string,
  position: Position,
): Location | null {
  const offset = positionToOffset(source, position);
  const loc = definitionAt(semantic, filePath, offset);
  if (!loc) {
    return null;
  }
  return {
    uri: pathToUri(loc.file),
    range: spanToRange(loc.span),
  };
}

export function completionsAtPosition(
  semantic: SemanticModel,
  filePath: string,
  source: string,
  position: Position,
  exportIndex?: readonly ExportIndexEntry[],
): CompletionItem[] {
  const offset = positionToOffset(source, position);
  const result = completionsAt(
    semantic,
    filePath,
    offset,
    source,
    exportIndex ? { exportIndex } : undefined,
  );
  return toCompletionItems(result.items, result.prefix, position, {
    source,
    semantic,
    filePath,
  });
}

export function documentSymbolsAtFile(
  semantic: SemanticModel,
  filePath: string,
): DocumentSymbol[] {
  return documentSymbolsForFile(semantic, filePath).map(toDocumentSymbol);
}

/** Collect diagnostics for every file that produced them. */
export function diagnosticsByFile(
  diagnostics: readonly SnDiagnostic[],
): Map<string, Diagnostic[]> {
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const file = d.file ?? "<unknown>";
    const list = byFile.get(file) ?? [];
    list.push({
      severity: severityToLsp(d.severity),
      range: d.span
        ? spanToRange(d.span)
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      message: d.message,
      source: "sn",
      ...(d.code ? { code: d.code } : {}),
    });
    byFile.set(file, list);
  }
  return byFile;
}

export function buildExportIndexForFile(
  filePath: string,
  workspaceRoots: readonly string[],
  overlay: WorkspaceOverlay,
): ExportIndexEntry[] {
  return buildExportIndex({
    importerPath: filePath,
    workspaceRoots,
    readFile: (absolutePath) => {
      const open = overlay.getDocument(absolutePath);
      if (open !== undefined) {
        return open;
      }
      return readFileSync(absolutePath, "utf8");
    },
  });
}
