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
  SourceLocation,
  SourceSpan,
} from "./diagnostics/index.js";

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
  codeActionsAt,
  completeImportPaths,
  collectDocumentSymbols,
  completionsAt,
  computeNamedImportEdit,
  definitionAt,
  documentSymbolsForFile,
  emptySemanticModel,
  encodeSemanticTokens,
  hoverAt,
  identifierSpanAt,
  identifierStartOffset,
  offsetToPosition,
  organizeImportsEdits,
  positionToOffset,
  prepareRenameAt,
  referencesAt,
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
} from "./analysis/index.js";


export type { TypecheckResult } from "./typecheck.js";
export { typeToString } from "./typecheck.js";
