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

export { formatSource, formatFile, printProgram } from "./format/index.js";
export type { FormatResult } from "./format/index.js";

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
  resolveImportSpecifier,
  resolveModules,
  setPackageRootsProvider,
  setStdRootProvider,
} from "./modules/index.js";
export type {
  ModuleImportBinding,
  PackageRootsProvider,
  ReadFileFn,
  ResolveResult,
  ResolvedModule,
} from "./modules/index.js";

export type { AstNode, Expression, Program, Statement } from "./ast/index.js";

export {
  SemanticCollector,
  buildExportIndex,
  collectDocumentSymbols,
  completionsAt,
  computeNamedImportEdit,
  definitionAt,
  documentSymbolsForFile,
  emptySemanticModel,
  hoverAt,
  identifierStartOffset,
  offsetToPosition,
  positionToOffset,
  semanticKey,
} from "./analysis/index.js";
export type {
  AutoImportInfo,
  BuildExportIndexOptions,
  CompletionInfo,
  CompletionsAtOptions,
  DocumentSymbolInfo,
  DocumentSymbolKind,
  ExportIndexEntry,
  HoverInfo,
  ImportTextEdit,
  CompletionSymbolKind,
  ModuleSymbolInfo,
  ScopeBindingInfo,
  ScopeRegion,
  SemanticLocation,
  SemanticModel,
} from "./analysis/index.js";


export type { TypecheckResult } from "./typecheck.js";
export { typeToString } from "./typecheck.js";
