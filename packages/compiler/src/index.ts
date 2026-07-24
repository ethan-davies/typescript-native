export {
  compile,
  compileFile,
  analyzeFile,
  formatDiagnostics,
} from "./compiler.js";
export type {
  AnalyzeFileOptions,
  AnalyzeResult,
  CompileFileOptions,
  CompileOptions,
  CompileResult,
} from "./compiler.js";

export {
  formatSource,
  formatFile,
  formatRange,
  printProgram,
  loadFormatOptions,
  parseFormatSection,
  findProjectToml,
  DEFAULT_FORMAT_OPTIONS,
  resolveFormatOptions,
} from "./format/index.js";
export type {
  FormatResult,
  FormatSourceOptions,
  FormatRange,
  FormatRangeEdit,
  FormatRangeResult,
  FormatOptions,
  SourceComment,
  CommentAttachments,
} from "./format/index.js";

export { Lexer, TokenKind } from "./lexer/index.js";
export type { Token } from "./lexer/index.js";

export { Parser } from "./parser/index.js";

export { LlvmCodegen, encodeLlvmString } from "./codegen/index.js";

export { DiagnosticCollector } from "./diagnostics/index.js";
export type {
  Diagnostic,
  DiagnosticLevel,
  DiagnosticsConfig,
  SourceLocation,
  SourceSpan,
} from "./diagnostics/index.js";
export {
  applyDiagnosticsConfig,
  DEFAULT_DIAGNOSTICS_CONFIG,
  DIAGNOSTIC_CODES,
  editDistance,
  InternalError,
  isInternalError,
  loadDiagnosticsOptions,
  parseDiagnosticsSection,
  promoteWarningsAsErrors,
  resolveDiagnosticsConfig,
  suggestClosest,
} from "./diagnostics/index.js";

export {
  isCAbiCompatible,
  cAbiIncompatibilityReason,
  isTrustedFfiModule,
  isPtrType,
  isFnPtrType,
  isFixedArrayType,
} from "./ffi.js";

export {
  mangleSymbol,
  moduleIdFromPath,
  moduleIdentityForPath,
  applyPackageRootsFromProject,
  resolveImportSpecifier,
  resolveModules,
  resolveSpecifierDetailed,
  setPackageRootsProvider,
  setStdRootProvider,
} from "./modules/index.js";
export type {
  ModuleIdentity,
  ModuleImportBinding,
  PackageRootInfo,
  PackageRootsProvider,
  ReadFileFn,
  ResolveResult,
  ResolvedModule,
  ResolvedSpecifier,
} from "./modules/index.js";

export type { AstNode, Expression, Program, Statement } from "./ast/index.js";

export {
  SemanticCollector,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  buildExportIndex,
  buildImportGraph,
  codeActionsAt,
  completeImportPaths,
  collectDocumentSymbols,
  completionsAt,
  computeNamedImportEdit,
  definitionAt,
  discoverImportersOf,
  documentSymbolsForFile,
  emptySemanticModel,
  encodeSemanticTokens,
  extractImportSpecifiers,
  hoverAt,
  identifierSpanAt,
  identifierStartOffset,
  listWorkspaceSnFiles,
  mergeReferences,
  offsetToPosition,
  organizeImportsEdits,
  positionToOffset,
  prepareRenameAt,
  referencesAt,
  referencesForDefinition,
  removeNamedImportEdit,
  renameAt,
  semanticKey,
  semanticTokensForFile,
  signatureHelpAt,
} from "./analysis/index.js";
export type {
  AutoImportInfo,
  BuildExportIndexOptions,
  CallSignatureInfo,
  CallSignatureParameter,
  CodeActionEdit,
  CodeActionInfo,
  CodeActionKind,
  CodeActionsOptions,
  CompletionInfo,
  CompletionsAtOptions,
  DocumentSymbolInfo,
  DocumentSymbolKind,
  ExportIndexEntry,
  HoverInfo,
  ImportTextEdit,
  CompletionSymbolKind,
  ModuleSymbolInfo,
  RenameResult,
  RenameTextEdit,
  ScopeBindingInfo,
  ScopeRegion,
  SemanticLocation,
  SemanticModel,
  SemanticToken,
  SemanticTokenModifier,
  SemanticTokenTypeName,
  SignatureHelpInfo,
  SymbolSemanticInfo,
  WorkspaceIndexOptions,
} from "./analysis/index.js";


export type { TypecheckResult } from "./typecheck.js";
export { typeToString } from "./typecheck.js";
