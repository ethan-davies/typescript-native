import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Program } from "./ast/nodes.js";
import { LlvmCodegen } from "./codegen/llvm.js";
import { DiagnosticCollector, type Diagnostic } from "./diagnostics/diagnostic.js";
import { monomorphizeModules } from "./generics/monomorphize.js";
import { Lexer } from "./lexer/lexer.js";
import { resolveModules, type ResolvedModule } from "./modules/resolve.js";
import { Parser } from "./parser/parser.js";
import { typecheck, typecheckModules } from "./typecheck.js";
import { validate, validateModules } from "./validate.js";

export interface CompileOptions {
  /** Source file name used in diagnostics. */
  readonly fileName?: string;
}

export interface CompileResult {
  readonly ast: Program;
  readonly modules: readonly ResolvedModule[];
  readonly ir: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

/**
 * Compile source text through lexer → parser → validate → typecheck → monomorphize → LLVM IR.
 * Imports are not supported here; use {@link compileFile} for multi-file programs.
 */
export function compile(source: string, _options: CompileOptions = {}): CompileResult {
  const diagnostics = new DiagnosticCollector();
  const lexer = new Lexer(source, diagnostics);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();

  const synthetic: ResolvedModule = {
    path: "<source>",
    source,
    ast,
    moduleId: "",
    isEntry: true,
    imports: [],
  };

  if (!diagnostics.hasErrors) {
    validate(ast, diagnostics);
  }

  let monoModules: ResolvedModule[] = [synthetic];

  if (!diagnostics.hasErrors) {
    const inst = typecheck(ast, diagnostics);
    if (!diagnostics.hasErrors) {
      monoModules = monomorphizeModules([synthetic], inst);
    }
  }

  if (diagnostics.hasErrors) {
    return {
      ast,
      modules: [synthetic],
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  const ir = new LlvmCodegen().emitModules(monoModules);
  return {
    ast: monoModules[0]?.ast ?? ast,
    modules: monoModules,
    ir,
    diagnostics: diagnostics.diagnostics,
    success: true,
  };
}

export interface CompileFileOptions {
  readonly readFile?: (absolutePath: string) => string;
}

/**
 * Compile an entry `.tsn` file and all transitively imported modules.
 */
export function compileFile(
  entryPath: string,
  options: CompileFileOptions = {},
): CompileResult {
  const diagnostics = new DiagnosticCollector();
  const readFile =
    options.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const absoluteEntry = resolvePath(entryPath);

  const resolved = resolveModules(absoluteEntry, readFile, diagnostics);
  const entry = resolved.modules.find((m) => m.isEntry);
  const emptyAst: Program = {
    kind: "Program",
    body: [],
    span: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    },
  };

  if (!resolved.success || diagnostics.hasErrors || !entry) {
    return {
      ast: entry?.ast ?? emptyAst,
      modules: resolved.modules,
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  validateModules(resolved.modules, diagnostics);

  let monoModules = resolved.modules;
  if (!diagnostics.hasErrors) {
    const inst = typecheckModules(resolved.modules, diagnostics);
    if (!diagnostics.hasErrors) {
      monoModules = monomorphizeModules(resolved.modules, inst);
    }
  }

  if (diagnostics.hasErrors) {
    return {
      ast: entry.ast,
      modules: resolved.modules,
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  const ir = new LlvmCodegen().emitModules(monoModules);
  return {
    ast: monoModules.find((m) => m.isEntry)?.ast ?? entry.ast,
    modules: monoModules,
    ir,
    diagnostics: diagnostics.diagnostics,
    success: true,
  };
}

export { formatDiagnostics } from "./pipeline-format.js";
