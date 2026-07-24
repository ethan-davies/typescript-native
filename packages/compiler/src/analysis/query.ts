import type { SourceSpan } from "../diagnostics/diagnostic.js";
import { completeImportPaths } from "./export-index.js";
import {
  collectDocumentSymbols,
  type DocumentSymbolInfo,
} from "./document-symbols.js";
import {
  semanticKey,
  type CompletionSymbolKind,
  type ModuleSymbolInfo,
  type ScopeBindingInfo,
  type SemanticLocation,
  type SemanticModel,
} from "./semantic.js";

const KEYWORDS: readonly ScopeBindingInfo[] = [
  "function",
  "let",
  "const",
  "return",
  "if",
  "else",
  "while",
  "for",
  "break",
  "continue",
  "struct",
  "class",
  "interface",
  "enum",
  "type",
  "import",
  "export",
  "new",
  "this",
  "true",
  "false",
  "null",
  "extern",
  "abstract",
  "public",
  "private",
  "readonly",
  "static",
  "extends",
  "implements",
  "as",
  "is",
  "typeof",
  "keyof",
  "switch",
  "case",
  "default",
  "try",
  "catch",
  "finally",
  "throw",
  "async",
  "await",
].map((name) => ({ name, detail: "keyword", kind: "keyword" as const }));

const BUILTIN_VALUES: readonly ScopeBindingInfo[] = [
  { name: "print", detail: "(...args) => void", kind: "function" },
  { name: "createMap", detail: "() => Map", kind: "function" },
  { name: "Error", detail: "class Error", kind: "class" },
  { name: "Future", detail: "type Future<T>", kind: "type" },
];

const BUILTIN_TYPES: readonly ScopeBindingInfo[] = [
  "i32",
  "i64",
  "f32",
  "f64",
  "bool",
  "string",
  "char",
  "void",
  "null",
  "Future",
].map((name) => ({ name, detail: "type", kind: "type" as const }));

/** Sort order for completion kinds (lower = higher in the list). */
const KIND_SORT: Record<CompletionSymbolKind, string> = {
  keyword: "0",
  parameter: "1",
  variable: "2",
  constant: "2",
  function: "3",
  method: "3",
  field: "4",
  property: "4",
  class: "5",
  struct: "5",
  interface: "5",
  enum: "5",
  enumMember: "5",
  type: "5",
  module: "6",
  constructor: "3",
};

export interface HoverInfo {
  readonly contents: string;
  readonly span: SourceSpan;
}

export interface CompletionInfo {
  readonly items: readonly ScopeBindingInfo[];
  /** True when completing after `.` */
  readonly isMember: boolean;
  /** Prefix being completed (for client text edits). */
  readonly prefix: string;
}

/** One exported symbol available for auto-import. */
export interface ExportIndexEntry {
  readonly name: string;
  readonly exportName: string;
  readonly kind: CompletionSymbolKind;
  readonly moduleSpecifier: string;
  readonly modulePath: string;
}

export interface CompletionsAtOptions {
  readonly exportIndex?: readonly ExportIndexEntry[];
  readonly workspaceRoots?: readonly string[];
}

function findModule(model: SemanticModel, file: string) {
  return model.modules.find((m) => m.path === file);
}

function offsetFromPosition(source: string, line: number, column: number): number {
  let currentLine = 1;
  let offset = 0;
  while (offset < source.length && currentLine < line) {
    if (source[offset] === "\n") {
      currentLine += 1;
    }
    offset += 1;
  }
  return offset + (column - 1);
}

export function positionToOffset(
  model: SemanticModel,
  file: string,
  line: number,
  column: number,
): number | null {
  const mod = findModule(model, file);
  if (!mod) {
    return null;
  }
  return offsetFromPosition(mod.source, line, column);
}

function spanAtOffset(source: string, offset: number): SourceSpan {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  const start = { line, column, offset };
  return { start, end: start };
}

/** Span covering the full identifier starting at or containing `offset`. */
export function identifierSpanAt(source: string, offset: number): SourceSpan {
  const startOff = identifierStartOffset(source, offset);
  let endOff = startOff;
  while (endOff < source.length && /[A-Za-z0-9_]/.test(source[endOff]!)) {
    endOff += 1;
  }
  let line = 1;
  let column = 1;
  for (let i = 0; i < startOff && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  const start = { line, column, offset: startOff };
  let endLine = line;
  let endColumn = column;
  for (let i = startOff; i < endOff; i += 1) {
    if (source[i] === "\n") {
      endLine += 1;
      endColumn = 1;
    } else {
      endColumn += 1;
    }
  }
  return {
    start,
    end: { line: endLine, column: endColumn, offset: endOff },
  };
}

export function identifierStartOffset(source: string, offset: number): number {
  if (offset < 0 || offset > source.length) {
    return offset;
  }
  let start = Math.min(offset, source.length);
  if (start === source.length) {
    start -= 1;
  }
  const isIdent = (ch: string | undefined) =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  if (!isIdent(source[start]) && start > 0 && isIdent(source[start - 1])) {
    start -= 1;
  }
  while (start > 0 && isIdent(source[start - 1])) {
    start -= 1;
  }
  return start;
}

export function hoverAt(
  model: SemanticModel,
  file: string,
  offset: number,
): HoverInfo | null {
  const mod = findModule(model, file);
  if (!mod) {
    return null;
  }
  const start = identifierStartOffset(mod.source, offset);
  const key = semanticKey(file, start);
  const type = model.expressionTypes.get(key);
  if (type) {
    return {
      contents: type,
      span: spanAtOffset(mod.source, start),
    };
  }
  return null;
}

export function definitionAt(
  model: SemanticModel,
  file: string,
  offset: number,
): SemanticLocation | null {
  const mod = findModule(model, file);
  if (!mod) {
    return null;
  }
  const start = identifierStartOffset(mod.source, offset);
  const key = semanticKey(file, start);
  return (
    model.definitions.get(key) ??
    model.memberDefinitions.get(key) ??
    model.declarations.get(key) ??
    null
  );
}

/**
 * Find all references to the symbol at `offset`.
 * When `includeDeclaration` is false, the definition site is omitted.
 */
export function referencesAt(
  model: SemanticModel,
  file: string,
  offset: number,
  options: { includeDeclaration?: boolean } = {},
): SemanticLocation[] {
  const def = definitionAt(model, file, offset);
  if (!def) {
    return [];
  }
  return referencesForDefinition(model, def, options);
}

/**
 * Find all references to a known definition location within a semantic model.
 * Used for workspace-wide reference aggregation across multiple entry analyses.
 */
export function referencesForDefinition(
  model: SemanticModel,
  def: SemanticLocation,
  options: { includeDeclaration?: boolean } = {},
): SemanticLocation[] {
  const includeDeclaration = options.includeDeclaration !== false;
  const defKey = `${def.file}:${def.span.start.offset}`;
  const results: SemanticLocation[] = [];
  const seen = new Set<string>();

  if (includeDeclaration) {
    results.push({ file: def.file, span: def.span });
    seen.add(defKey);
  }

  for (const [useKey, loc] of model.definitions) {
    if (
      loc.file === def.file &&
      loc.span.start.offset === def.span.start.offset
    ) {
      const [useFile, useOff] = splitSemanticKey(useKey);
      if (!useFile || useOff === undefined || seen.has(useKey)) {
        continue;
      }
      if (
        !includeDeclaration &&
        useFile === def.file &&
        useOff === def.span.start.offset
      ) {
        continue;
      }
      seen.add(useKey);
      const useMod = findModule(model, useFile);
      if (!useMod) {
        continue;
      }
      results.push({
        file: useFile,
        span: identifierSpanAt(useMod.source, useOff),
      });
    }
  }

  for (const [useKey, loc] of model.memberDefinitions) {
    if (
      loc.file === def.file &&
      loc.span.start.offset === def.span.start.offset
    ) {
      const [useFile, useOff] = splitSemanticKey(useKey);
      if (!useFile || useOff === undefined || seen.has(useKey)) {
        continue;
      }
      if (
        !includeDeclaration &&
        useFile === def.file &&
        useOff === def.span.start.offset
      ) {
        continue;
      }
      seen.add(useKey);
      const useMod = findModule(model, useFile);
      if (!useMod) {
        continue;
      }
      results.push({
        file: useFile,
        span: identifierSpanAt(useMod.source, useOff),
      });
    }
  }

  return results;
}

/**
 * Union references to the same definition across multiple semantic models
 * (e.g. each importer analyzed as an entry point).
 */
export function mergeReferences(
  models: readonly SemanticModel[],
  def: SemanticLocation,
  options: { includeDeclaration?: boolean } = {},
): SemanticLocation[] {
  const seen = new Set<string>();
  const results: SemanticLocation[] = [];
  for (const model of models) {
    for (const loc of referencesForDefinition(model, def, options)) {
      const key = `${loc.file}:${loc.span.start.offset}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(loc);
    }
  }
  return results;
}

function splitSemanticKey(key: string): [string | null, number | undefined] {
  const idx = key.lastIndexOf(":");
  if (idx < 0) {
    return [null, undefined];
  }
  const file = key.slice(0, idx);
  const offset = Number(key.slice(idx + 1));
  if (!Number.isFinite(offset)) {
    return [null, undefined];
  }
  return [file, offset];
}

function membersForObject(
  model: SemanticModel,
  file: string,
  objStart: number,
  objName: string,
  offset: number,
): readonly ScopeBindingInfo[] {
  const fromExpr = model.memberCompletions.get(semanticKey(file, objStart));
  if (fromExpr && fromExpr.length > 0) {
    return fromExpr;
  }

  const typeFromExpr = model.expressionTypes.get(semanticKey(file, objStart));
  if (typeFromExpr) {
    const byType = model.membersByType.get(typeFromExpr);
    if (byType && byType.length > 0) {
      return byType;
    }
  }

  // Class/enum/struct name used as a qualifier (Foo.bar / Direction.Up).
  const byName = model.membersByType.get(objName);
  if (byName && byName.length > 0) {
    return byName;
  }

  for (const scope of model.scopes) {
    if (scope.file !== file || scope.startOffset > offset || offset > scope.endOffset) {
      continue;
    }
    const binding = scope.bindings.find((b) => b.name === objName);
    if (binding) {
      const byType = model.membersByType.get(binding.detail);
      if (byType && byType.length > 0) {
        return byType;
      }
    }
  }

  // Module-level type symbol named objName.
  const modSym = (model.moduleSymbols.get(file) ?? []).find((s) => s.name === objName);
  if (modSym) {
    const byType = model.membersByType.get(objName);
    if (byType && byType.length > 0) {
      return byType;
    }
  }

  return [];
}

function sortCompletions(items: ScopeBindingInfo[]): ScopeBindingInfo[] {
  return [...items].sort((a, b) => {
    const ka = KIND_SORT[a.kind] ?? "9";
    const kb = KIND_SORT[b.kind] ?? "9";
    if (ka !== kb) {
      return ka.localeCompare(kb);
    }
    return a.name.localeCompare(b.name);
  });
}

export function completionsAt(
  model: SemanticModel,
  file: string,
  offset: number,
  sourceText?: string,
  options?: CompletionsAtOptions,
): CompletionInfo {
  const mod = findModule(model, file);
  const source = sourceText ?? mod?.source ?? "";
  const before = source.slice(0, offset);

  // Import path completion: from "…|" or import "…|"
  const importPathMatch = before.match(
    /(?:from|import)\s+"([^"]*)$|(?:from|import)\s+'([^']*)$/,
  );
  if (importPathMatch) {
    const partial = importPathMatch[1] ?? importPathMatch[2] ?? "";
    const paths = completeImportPaths(
      file,
      partial,
      options?.workspaceRoots ?? [],
    );
    return {
      isMember: false,
      prefix: partial,
      items: paths.map((p) => ({
        name: p,
        detail: "module path",
        kind: "module" as const,
      })),
    };
  }

  const memberMatch = before.match(/(\w+)\s*\.\s*(\w*)$/);
  if (memberMatch) {
    const objName = memberMatch[1]!;
    const dotIndex = before.lastIndexOf(".");
    let objEnd = dotIndex - 1;
    while (objEnd >= 0 && /\s/.test(before[objEnd]!)) {
      objEnd -= 1;
    }
    let objStart = objEnd;
    while (objStart >= 0 && /[A-Za-z0-9_]/.test(before[objStart]!)) {
      objStart -= 1;
    }
    objStart += 1;
    const prefix = memberMatch[2] ?? "";
    const members = membersForObject(model, file, objStart, objName, offset);
    const filtered = prefix ? members.filter((m) => m.name.startsWith(prefix)) : members;
    return {
      isMember: true,
      prefix,
      items: sortCompletions([...filtered]),
    };
  }

  const items: ScopeBindingInfo[] = [...KEYWORDS, ...BUILTIN_VALUES, ...BUILTIN_TYPES];
  const seen = new Set<string>(items.map((k) => k.name));

  const add = (item: ScopeBindingInfo) => {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      items.push(item);
    }
  };

  for (const scope of model.scopes) {
    if (scope.file === file && scope.startOffset <= offset && offset <= scope.endOffset) {
      for (const b of scope.bindings) {
        add(b);
      }
    }
  }

  const moduleSyms = model.moduleSymbols.get(file) ?? [];
  for (const sym of moduleSyms) {
    if (sym.name.startsWith("__prelude_ext_")) {
      continue;
    }
    add({
      name: sym.name,
      detail: sym.detail,
      kind: sym.kind,
    });
  }

  if (options?.exportIndex && options.exportIndex.length > 0) {
    const alreadyImported = new Set<string>();
    for (const binding of mod?.imports ?? []) {
      if (binding.kind === "named") {
        alreadyImported.add(binding.localName);
        alreadyImported.add(binding.exportName);
      }
    }
    const autoSeen = new Set<string>();
    for (const entry of options.exportIndex) {
      if (alreadyImported.has(entry.name)) {
        continue;
      }
      if (entry.modulePath === file) {
        continue;
      }
      // Allow multiple modules exporting the same name; dedupe by name+specifier.
      const autoKey = `${entry.name}\0${entry.moduleSpecifier}`;
      if (autoSeen.has(autoKey)) {
        continue;
      }
      // Skip when an in-scope non-auto-import binding already owns the name.
      // (Auto-import items are not added to `seen`, so multiple sources remain.)
      if (seen.has(entry.name)) {
        continue;
      }
      autoSeen.add(autoKey);
      items.push({
        name: entry.name,
        detail: `Add import from "${entry.moduleSpecifier}"`,
        kind: entry.kind,
        autoImport: {
          moduleSpecifier: entry.moduleSpecifier,
          exportName: entry.exportName,
        },
      });
    }
  }

  const partial = before.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
  if (partial) {
    return {
      isMember: false,
      prefix: partial,
      items: sortCompletions(items.filter((i) => i.name.startsWith(partial))),
    };
  }
  return { isMember: false, prefix: "", items: sortCompletions(items) };
}

export function documentSymbolsForFile(
  model: SemanticModel,
  file: string,
): DocumentSymbolInfo[] {
  const mod = findModule(model, file);
  if (!mod) {
    return [];
  }
  return collectDocumentSymbols(mod.ast);
}

export type {
  CompletionSymbolKind,
  DocumentSymbolInfo,
  ModuleSymbolInfo,
  ScopeBindingInfo,
  SemanticLocation,
};
