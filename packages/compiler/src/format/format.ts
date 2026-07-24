import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Program } from "../ast/nodes.js";
import {
  DiagnosticCollector,
  type Diagnostic,
} from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { attachComments } from "./comments.js";
import type { FormatOptions } from "./options.js";
import { resolveFormatOptions } from "./options.js";
import { printProgram } from "./printer.js";

export interface FormatResult {
  readonly code: string | null;
  readonly ast: Program;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

export interface FormatSourceOptions extends Partial<FormatOptions> {
  readonly fileName?: string;
}

/**
 * Parse source and pretty-print it. Does not rewrite when parse errors occur.
 * Comments are preserved via a post-parse attachment pass.
 */
export function formatSource(
  source: string,
  options: FormatSourceOptions = {},
): FormatResult {
  const diagnostics = new DiagnosticCollector();
  const fileName = options.fileName ?? "<source>";
  diagnostics.setFile(fileName);

  const formatOpts = resolveFormatOptions(options);
  const lexer = new Lexer(source, diagnostics);
  const { tokens, comments } = lexer.tokenizeWithComments();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();

  if (diagnostics.hasErrors) {
    return {
      code: null,
      ast,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  const attachments = attachComments(ast, comments);
  return {
    code: printProgram(ast, formatOpts, attachments),
    ast,
    diagnostics: diagnostics.diagnostics,
    success: true,
  };
}

export function formatFile(
  filePath: string,
  options: Partial<FormatOptions> = {},
): FormatResult {
  const absolute = resolve(filePath);
  const source = readFileSync(absolute, "utf8");
  return formatSource(source, { ...options, fileName: absolute });
}
