import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Program } from "./ast/nodes.js";
import { LlvmCodegen } from "./codegen/llvm.js";
import {
  DiagnosticCollector,
  type Diagnostic,
} from "./diagnostics/diagnostic.js";
import {
  monomorphizeModules,
  type TypecheckInstantiations,
} from "./generics/monomorphize.js";
import { Lexer } from "./lexer/lexer.js";
import { attachPrelude, setPreludePathsProvider } from "./modules/prelude.js";
import { applyPackageRootsFromProject } from "./modules/project-roots.js";
import {
  resolveModules,
  setStdRootProvider,
  type ResolvedModule,
} from "./modules/resolve.js";
import { Parser } from "./parser/parser.js";
import { typecheckModules } from "./typecheck.js";
import { validateModules, validateModulesLoose } from "./validate.js";
import { emptySemanticModel, type SemanticModel } from "./analysis/semantic.js";

function discoverStdRoot(): string | null {
  const fromEnv = process.env.SONITE_STD_ROOT;
  if (fromEnv && existsSync(join(fromEnv, "prelude", "string.sn"))) {
    return fromEnv;
  }
  try {
    const require = createRequire(import.meta.url);
    const std = require("@sonite/std") as {
      getStdRoot: () => string;
    };
    return std.getStdRoot();
  } catch {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "std", "src"),
      join(here, "..", "..", "..", "std", "src"),
      // Bundled beside a packaged LSP server: dist/server.js → ../stdlib
      join(here, "..", "stdlib"),
      join(here, "stdlib"),
    ];
    for (const root of candidates) {
      if (existsSync(join(root, "prelude", "string.sn"))) {
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
    join(root, "prelude", "string.sn"),
    join(root, "prelude", "array.sn"),
    join(root, "prelude", "number.sn"),
    join(root, "prelude", "bool.sn"),
    join(root, "prelude", "nullable.sn"),
    join(root, "prelude", "io.sn"),
    join(root, "prelude", "bytes.sn"),
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
export function compile(
  source: string,
  options: CompileOptions = {},
): CompileResult {
  const diagnostics = new DiagnosticCollector();
  const fileName = options.fileName ?? "<source>";
  diagnostics.setFile(fileName);
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
    path: fileName,
    identity: `file://${fileName}`,
    source,
    ast,
    moduleId: "",
    isEntry: true,
    imports: [],
    reexportSources: [],
  };

  const modules = attachPrelude([synthetic], diagnostics);

  if (!diagnostics.hasErrors) {
    validateModules(modules, diagnostics);
  }

  let monoModules: ResolvedModule[] = modules;

  if (!diagnostics.hasErrors) {
    const inst = typecheckModules(modules, diagnostics);
    if (!diagnostics.hasErrors) {
      monoModules = monomorphizeModules(modules, inst.instantiations);
      const ir = new LlvmCodegen().emitModules(
        monoModules,
        inst.instantiations,
      );
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
 * Compile an entry `.sn` file and all transitively imported modules.
 */
export function compileFile(
  entryPath: string,
  options: CompileFileOptions = {},
): CompileResult {
  const diagnostics = new DiagnosticCollector();
  const readFile =
    options.readFile ??
    ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const absoluteEntry = resolvePath(entryPath);
  applyPackageRootsFromProject(dirname(absoluteEntry));

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
    const checked = typecheckModules(modules, diagnostics);
    inst = checked.instantiations;
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

export interface AnalyzeFileOptions {
  readonly readFile?: (absolutePath: string) => string;
}

export interface AnalyzeResult {
  readonly modules: readonly ResolvedModule[];
  readonly diagnostics: readonly Diagnostic[];
  readonly semantic: SemanticModel;
  readonly success: boolean;
}

/**
 * Resolve, validate, and typecheck a `.sn` file without codegen.
 * Suitable for IDE / LSP use. The open file need not define `main`.
 * Continues semantic analysis even when the parser already reported errors,
 * so completions/hover still work on incomplete buffers.
 */
export function analyzeFile(
  entryPath: string,
  options: AnalyzeFileOptions = {},
): AnalyzeResult {
  const diagnostics = new DiagnosticCollector();
  const readFile =
    options.readFile ??
    ((absolutePath: string) => readFileSync(absolutePath, "utf8"));
  const absoluteEntry = resolvePath(entryPath);
  applyPackageRootsFromProject(dirname(absoluteEntry));

  const resolved = resolveModules(absoluteEntry, readFile, diagnostics);
  const modules = attachPrelude(resolved.modules, diagnostics, readFile);

  if (modules.length === 0) {
    return {
      modules,
      diagnostics: diagnostics.diagnostics,
      semantic: emptySemanticModel(modules),
      success: false,
    };
  }

  validateModulesLoose(modules, diagnostics);
  const checked = typecheckModules(modules, diagnostics);

  return {
    modules,
    diagnostics: diagnostics.diagnostics,
    semantic: checked.semantic,
    success: !diagnostics.hasErrors,
  };
}

export { formatDiagnostics } from "./pipeline-format.js";
