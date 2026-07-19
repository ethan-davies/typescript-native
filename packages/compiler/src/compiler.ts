import type { Program } from "./ast/nodes.js";
import { LlvmCodegen } from "./codegen/llvm.js";
import { DiagnosticCollector, type Diagnostic } from "./diagnostics/diagnostic.js";
import { Lexer } from "./lexer/lexer.js";
import { Parser } from "./parser/parser.js";
import { validate } from "./validate.js";

export interface CompileOptions {
  /** Source file name used in diagnostics. */
  readonly fileName?: string;
}

export interface CompileResult {
  readonly ast: Program;
  readonly ir: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

/**
 * Compile source text through lexer → parser → validate → LLVM IR.
 */
export function compile(source: string, _options: CompileOptions = {}): CompileResult {
  const diagnostics = new DiagnosticCollector();
  const lexer = new Lexer(source, diagnostics);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();

  if (!diagnostics.hasErrors) {
    validate(ast, diagnostics);
  }

  if (diagnostics.hasErrors) {
    return {
      ast,
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  const ir = new LlvmCodegen().emit(ast);
  return {
    ast,
    ir,
    diagnostics: diagnostics.diagnostics,
    success: true,
  };
}

export { formatDiagnostics } from "./pipeline-format.js";
