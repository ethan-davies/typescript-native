import type { SourceSpan } from "../diagnostics/diagnostic.js";
import {
  definitionAt,
  identifierSpanAt,
  referencesAt,
} from "./query.js";
import type { SemanticLocation, SemanticModel } from "./semantic.js";

export interface RenameTextEdit {
  readonly file: string;
  readonly span: SourceSpan;
  readonly newText: string;
}

export interface RenameResult {
  readonly edits: readonly RenameTextEdit[];
  readonly error?: string;
}

export function prepareRenameAt(
  model: SemanticModel,
  file: string,
  offset: number,
): SemanticLocation | null {
  const def = definitionAt(model, file, offset);
  if (!def) {
    return null;
  }
  const mod = model.modules.find((m) => m.path === file);
  if (!mod) {
    return null;
  }
  return {
    file,
    span: identifierSpanAt(mod.source, offset),
  };
}

/**
 * Compute workspace text edits to rename the symbol at `offset` to `newName`.
 * Returns an error when the new name would conflict in scope.
 */
export function renameAt(
  model: SemanticModel,
  file: string,
  offset: number,
  newName: string,
): RenameResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    return { edits: [], error: `Invalid identifier '${newName}'` };
  }

  const def = definitionAt(model, file, offset);
  if (!def) {
    return { edits: [], error: "No symbol to rename at this position" };
  }

  const oldName = nameAt(model, def);
  if (oldName === newName) {
    return { edits: [] };
  }

  const conflict = findRenameConflict(model, def, newName);
  if (conflict) {
    return { edits: [], error: conflict };
  }

  const refs = referencesAt(model, file, offset, { includeDeclaration: true });
  const seen = new Set<string>();
  const edits: RenameTextEdit[] = [];
  for (const loc of refs) {
    const key = `${loc.file}:${loc.span.start.offset}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edits.push({ file: loc.file, span: loc.span, newText: newName });
  }

  // Ensure the definition itself is included even if references omitted it.
  const defKey = `${def.file}:${def.span.start.offset}`;
  if (!seen.has(defKey)) {
    edits.push({ file: def.file, span: def.span, newText: newName });
  }

  return { edits };
}

function nameAt(model: SemanticModel, loc: SemanticLocation): string {
  const info = model.symbolInfo.get(
    `${loc.file}:${loc.span.start.offset}`,
  );
  if (info) {
    return info.name;
  }
  const mod = model.modules.find((m) => m.path === loc.file);
  if (!mod) {
    return "";
  }
  const span = identifierSpanAt(mod.source, loc.span.start.offset);
  return mod.source.slice(span.start.offset, span.end.offset);
}

function findRenameConflict(
  model: SemanticModel,
  def: SemanticLocation,
  newName: string,
): string | null {
  // Module-level sibling symbols
  const modSyms = model.moduleSymbols.get(def.file) ?? [];
  for (const sym of modSyms) {
    if (
      sym.name === newName &&
      sym.location.span.start.offset !== def.span.start.offset
    ) {
      return `A symbol named '${newName}' already exists in this module`;
    }
  }

  // Same scope region that contains the definition
  for (const scope of model.scopes) {
    if (scope.file !== def.file) {
      continue;
    }
    if (
      def.span.start.offset < scope.startOffset ||
      def.span.start.offset > scope.endOffset
    ) {
      continue;
    }
    for (const binding of scope.bindings) {
      if (binding.name === newName) {
        return `A binding named '${newName}' already exists in this scope`;
      }
    }
  }

  return null;
}
