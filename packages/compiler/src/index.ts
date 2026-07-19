export { compile, formatDiagnostics } from "./compiler.js";
export type { CompileOptions, CompileResult } from "./compiler.js";

export { Lexer, TokenKind } from "./lexer/index.js";
export type { Token } from "./lexer/index.js";

export { Parser } from "./parser/index.js";

export { LlvmCodegen, encodeLlvmString } from "./codegen/index.js";

export { DiagnosticCollector } from "./diagnostics/index.js";
export type { Diagnostic, SourceLocation, SourceSpan } from "./diagnostics/index.js";

export type {
  AstNode,
  Expression,
  Program,
  Statement,
} from "./ast/index.js";
