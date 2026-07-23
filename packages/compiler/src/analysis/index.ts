export {
  SemanticCollector,
  emptySemanticModel,
  semanticKey,
} from "./semantic.js";
export type {
  AutoImportInfo,
  CompletionSymbolKind,
  ModuleSymbolInfo,
  ScopeBindingInfo,
  ScopeRegion,
  SemanticLocation,
  SemanticModel,
} from "./semantic.js";

export { collectDocumentSymbols } from "./document-symbols.js";
export type { DocumentSymbolInfo, DocumentSymbolKind } from "./document-symbols.js";

export {
  completionsAt,
  definitionAt,
  documentSymbolsForFile,
  hoverAt,
  identifierStartOffset,
  positionToOffset,
  referencesAt,
} from "./query.js";
export type {
  CompletionInfo,
  CompletionsAtOptions,
  ExportIndexEntry,
  HoverInfo,
} from "./query.js";

export { buildExportIndex, completeImportPaths } from "./export-index.js";
export type { BuildExportIndexOptions } from "./export-index.js";

export {
  computeNamedImportEdit,
  offsetToPosition,
} from "./import-edit.js";
export type { ImportTextEdit } from "./import-edit.js";
