import type { SourceSpan } from "../diagnostics/diagnostic.js";
import type { ResolvedModule } from "../modules/resolve.js";

export interface SemanticLocation {
  readonly file: string;
  readonly span: SourceSpan;
}

/**
 * Completion taxonomy aligned with LSP CompletionItemKind so the editor
 * can show the right icons for each suggestion.
 */
export type CompletionSymbolKind =
  | "keyword"
  | "function"
  | "method"
  | "field"
  | "property"
  | "variable"
  | "parameter"
  | "constant"
  | "class"
  | "struct"
  | "interface"
  | "enum"
  | "enumMember"
  | "type"
  | "module"
  | "constructor";

/** LSP semantic-token modifiers we emit. */
export type SemanticTokenModifier =
  | "declaration"
  | "definition"
  | "readonly"
  | "static"
  | "defaultLibrary";

export interface ScopeBindingInfo {
  readonly name: string;
  readonly detail: string;
  readonly kind: CompletionSymbolKind;
  /** When set, accepting this completion should insert an import. */
  readonly autoImport?: AutoImportInfo;
}

/** Metadata for auto-import completion items. */
export interface AutoImportInfo {
  readonly moduleSpecifier: string;
  readonly exportName: string;
  /**
   * Local binding name when it differs from `exportName` (e.g. name clash → alias).
   * When omitted, clients should use `exportName`.
   */
  readonly localName?: string;
}

export interface ScopeRegion {
  readonly file: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly bindings: readonly ScopeBindingInfo[];
}

export interface ModuleSymbolInfo {
  readonly name: string;
  readonly kind: CompletionSymbolKind;
  readonly detail: string;
  readonly location: SemanticLocation;
}

/** One parameter in a recorded call signature. */
export interface CallSignatureParameter {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
}

/** Resolved signature at a CallExpression / NewExpression site. */
export interface CallSignatureInfo {
  readonly label: string;
  readonly parameters: readonly CallSignatureParameter[];
  readonly returnType: string;
  readonly typeParameters: readonly string[];
  /** Span of the full call/new expression (for lookup). */
  readonly callSpan: SourceSpan;
}

/** Symbol classification for semantic tokens / rename conflicts. */
export interface SymbolSemanticInfo {
  readonly name: string;
  readonly kind: CompletionSymbolKind;
  readonly modifiers: readonly SemanticTokenModifier[];
  readonly location: SemanticLocation;
}

export interface SemanticModel {
  readonly modules: readonly ResolvedModule[];
  /** `${file}:${offset}` → display type string */
  readonly expressionTypes: ReadonlyMap<string, string>;
  /** Use-site `${file}:${offset}` → definition location */
  readonly definitions: ReadonlyMap<string, SemanticLocation>;
  /** Declaration name sites `${file}:${offset}` → self location (for outline / def) */
  readonly declarations: ReadonlyMap<string, SemanticLocation>;
  readonly scopes: readonly ScopeRegion[];
  /** Per-file top-level symbols for completion */
  readonly moduleSymbols: ReadonlyMap<string, readonly ModuleSymbolInfo[]>;
  /** `${file}:${offset}` of member access property → definition of that member */
  readonly memberDefinitions: ReadonlyMap<string, SemanticLocation>;
  /** `${file}:${offset}` of object expression that has members → completion items */
  readonly memberCompletions: ReadonlyMap<string, readonly ScopeBindingInfo[]>;
  /** `typeToString(type)` or type/class/enum local name → members */
  readonly membersByType: ReadonlyMap<string, readonly ScopeBindingInfo[]>;
  /** `${file}:${callSpan.start.offset}` → signature help info */
  readonly callSignatures: ReadonlyMap<string, CallSignatureInfo>;
  /** `${file}:${offset}` → symbol kind/modifiers for tokens */
  readonly symbolInfo: ReadonlyMap<string, SymbolSemanticInfo>;
}

export function semanticKey(file: string, offset: number): string {
  return `${file}:${offset}`;
}

export class SemanticCollector {
  readonly expressionTypes = new Map<string, string>();
  readonly definitions = new Map<string, SemanticLocation>();
  readonly declarations = new Map<string, SemanticLocation>();
  readonly scopes: ScopeRegion[] = [];
  readonly moduleSymbols = new Map<string, ModuleSymbolInfo[]>();
  readonly memberDefinitions = new Map<string, SemanticLocation>();
  readonly memberCompletions = new Map<string, ScopeBindingInfo[]>();
  readonly membersByType = new Map<string, ScopeBindingInfo[]>();
  readonly callSignatures = new Map<string, CallSignatureInfo>();
  readonly symbolInfo = new Map<string, SymbolSemanticInfo>();

  recordType(file: string, span: SourceSpan, typeString: string): void {
    this.expressionTypes.set(semanticKey(file, span.start.offset), typeString);
  }

  recordDefinition(useFile: string, useSpan: SourceSpan, def: SemanticLocation): void {
    this.definitions.set(semanticKey(useFile, useSpan.start.offset), def);
  }

  recordDeclaration(file: string, span: SourceSpan): void {
    this.declarations.set(semanticKey(file, span.start.offset), { file, span });
  }

  recordScope(region: ScopeRegion): void {
    this.scopes.push(region);
  }

  addModuleSymbol(file: string, symbol: ModuleSymbolInfo): void {
    const list = this.moduleSymbols.get(file) ?? [];
    list.push(symbol);
    this.moduleSymbols.set(file, list);
  }

  recordMemberDefinition(file: string, span: SourceSpan, def: SemanticLocation): void {
    this.memberDefinitions.set(semanticKey(file, span.start.offset), def);
  }

  recordMemberCompletions(file: string, span: SourceSpan, items: ScopeBindingInfo[]): void {
    this.memberCompletions.set(semanticKey(file, span.start.offset), items);
  }

  /** Members available on a type (keyed by `typeToString` or local type name). */
  recordMembersForType(typeString: string, items: readonly ScopeBindingInfo[]): void {
    const existing = this.membersByType.get(typeString) ?? [];
    const seen = new Set(existing.map((i) => i.name));
    for (const item of items) {
      if (!seen.has(item.name)) {
        seen.add(item.name);
        existing.push(item);
      }
    }
    this.membersByType.set(typeString, existing);
  }

  recordCallSignature(file: string, info: CallSignatureInfo): void {
    this.callSignatures.set(
      semanticKey(file, info.callSpan.start.offset),
      info,
    );
  }

  recordSymbolInfo(info: SymbolSemanticInfo): void {
    this.symbolInfo.set(
      semanticKey(info.location.file, info.location.span.start.offset),
      info,
    );
  }

  freeze(modules: readonly ResolvedModule[]): SemanticModel {
    return {
      modules,
      expressionTypes: this.expressionTypes,
      definitions: this.definitions,
      declarations: this.declarations,
      scopes: this.scopes,
      moduleSymbols: this.moduleSymbols,
      memberDefinitions: this.memberDefinitions,
      memberCompletions: this.memberCompletions,
      membersByType: this.membersByType,
      callSignatures: this.callSignatures,
      symbolInfo: this.symbolInfo,
    };
  }
}

export function emptySemanticModel(modules: readonly ResolvedModule[] = []): SemanticModel {
  return {
    modules,
    expressionTypes: new Map(),
    definitions: new Map(),
    declarations: new Map(),
    scopes: [],
    moduleSymbols: new Map(),
    memberDefinitions: new Map(),
    memberCompletions: new Map(),
    membersByType: new Map(),
    callSignatures: new Map(),
    symbolInfo: new Map(),
  };
}
