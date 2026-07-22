import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Program } from "./ast/nodes.js";
import { LlvmCodegen } from "./codegen/llvm.js";
import { DiagnosticCollector, type Diagnostic } from "./diagnostics/diagnostic.js";
import { monomorphizeModules, type TypecheckInstantiations } from "./generics/monomorphize.js";
import { Lexer } from "./lexer/lexer.js";
import { attachPrelude, setPreludePathsProvider } from "./modules/prelude.js";
import {
  resolveModules,
  setStdRootProvider,
  type ResolvedModule,
} from "./modules/resolve.js";
import { Parser } from "./parser/parser.js";
import { typecheckModules } from "./typecheck.js";
import { validateModules } from "./validate.js";

function discoverStdRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const std = require("@typescript-native/std") as {
      getStdRoot: () => string;
    };
    return std.getStdRoot();
  } catch {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "std", "src"),
      join(here, "..", "..", "..", "std", "src"),
    ];
    for (const root of candidates) {
      if (existsSync(join(root, "prelude", "string.tsn"))) {
        return root;
      }
    }
    return null;
  }
}

function discoverPreludePaths(): readonly string[] {
  const root = discoverStdRoot();
  if (!root) {
    return [];
  }
  return [
    join(root, "prelude", "string.tsn"),
    join(root, "prelude", "array.tsn"),
    join(root, "prelude", "io.tsn"),
  ];
}

setStdRootProvider(discoverStdRoot);
setPreludePathsProvider(discoverPreludePaths);

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
 * The standard-library prelude is still auto-attached.
 */
export function compile(source: string, _options: CompileOptions = {}): CompileResult {
  const diagnostics = new DiagnosticCollector();
  const lexer = new Lexer(source, diagnostics);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();

  for (const decl of ast.body) {
    if (decl.kind === "ImportDeclaration") {
      diagnostics.error(
        "Import declarations require compiling from a file path (use compileFile)",
        decl.span,
        "E0400",
      );
    }
  }

  const synthetic: ResolvedModule = {
    path: "<source>",
    source,
    ast,
    moduleId: "",
    isEntry: true,
    imports: [],
  };

  const modules = attachPrelude([synthetic], diagnostics);

  if (!diagnostics.hasErrors) {
    validateModules(modules, diagnostics);
  }

  let monoModules: ResolvedModule[] = modules;

  if (!diagnostics.hasErrors) {
    const inst = typecheckModules(modules, diagnostics);
    if (!diagnostics.hasErrors) {
      monoModules = monomorphizeModules(modules, inst);
      const ir = new LlvmCodegen().emitModules(monoModules, inst);
      return {
        ast: monoModules.find((m) => m.isEntry)?.ast ?? ast,
        modules: monoModules,
        ir,
        diagnostics: diagnostics.diagnostics,
        success: true,
      };
    }
  }

  if (diagnostics.hasErrors) {
    return {
      ast,
      modules,
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  const ir = new LlvmCodegen().emitModules(monoModules);
  return {
    ast: monoModules.find((m) => m.isEntry)?.ast ?? ast,
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
  const modules = attachPrelude(resolved.modules, diagnostics, readFile);
  const entry = modules.find((m) => m.isEntry);
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
      modules,
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  validateModules(modules, diagnostics);

  let monoModules = modules;
  let inst: TypecheckInstantiations | undefined;
  if (!diagnostics.hasErrors) {
    inst = typecheckModules(modules, diagnostics);
    if (!diagnostics.hasErrors) {
      monoModules = monomorphizeModules(modules, inst);
    }
  }

  if (diagnostics.hasErrors) {
    return {
      ast: entry.ast,
      modules,
      ir: null,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  const ir = new LlvmCodegen().emitModules(monoModules, inst);
  return {
    ast: monoModules.find((m) => m.isEntry)?.ast ?? entry.ast,
    modules: monoModules,
    ir,
    diagnostics: diagnostics.diagnostics,
    success: true,
  };
}

export { formatDiagnostics } from "./pipeline-format.js";
