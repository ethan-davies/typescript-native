export {
  SemanticCollector,
  emptySemanticModel,
  semanticKey,
} from "./semantic.js";
export type {
  AutoImportInfo,
  CallSignatureInfo,
  CallSignatureParameter,
  CompletionSymbolKind,
  ModuleSymbolInfo,
  ScopeBindingInfo,
  ScopeRegion,
  SemanticLocation,
  SemanticModel,
  SemanticTokenModifier,
  SymbolSemanticInfo,
} from "./semantic.js";

export { collectDocumentSymbols } from "./document-symbols.js";
export type { DocumentSymbolInfo, DocumentSymbolKind } from "./document-symbols.js";

export {
  completionsAt,
  definitionAt,
  documentSymbolsForFile,
  hoverAt,
  identifierSpanAt,
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

export { prepareRenameAt, renameAt } from "./rename.js";
export type { RenameResult, RenameTextEdit } from "./rename.js";

export { signatureHelpAt } from "./signature-help.js";
export type { SignatureHelpInfo } from "./signature-help.js";

export {
  codeActionsAt,
  organizeImportsEdits,
  removeNamedImportEdit,
} from "./code-actions.js";
export type {
  CodeActionEdit,
  CodeActionInfo,
  CodeActionKind,
  CodeActionsOptions,
} from "./code-actions.js";

export {
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  encodeSemanticTokens,
  semanticTokensForFile,
} from "./semantic-tokens.js";
export type {
  SemanticToken,
  SemanticTokenTypeName,
} from "./semantic-tokens.js";
