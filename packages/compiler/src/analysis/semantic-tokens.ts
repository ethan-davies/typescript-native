import type { SourceSpan } from "../diagnostics/diagnostic.js";
import type {
  CompletionSymbolKind,
  SemanticModel,
  SemanticTokenModifier,
  SymbolSemanticInfo,
} from "./semantic.js";
import { semanticKey } from "./semantic.js";

/** LSP semantic token types we advertise (order = legend indices). */
export const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
] as const;

export type SemanticTokenTypeName = (typeof SEMANTIC_TOKEN_TYPES)[number];

export interface SemanticToken {
  readonly line: number; // 0-based
  readonly startChar: number; // 0-based
  readonly length: number;
  readonly tokenType: number;
  readonly tokenModifiers: number;
}

function kindToTokenType(kind: CompletionSymbolKind): SemanticTokenTypeName {
  switch (kind) {
    case "module":
      return "namespace";
    case "type":
      return "type";
    case "class":
      return "class";
    case "enum":
      return "enum";
    case "interface":
      return "interface";
    case "struct":
      return "struct";
    case "parameter":
      return "parameter";
    case "variable":
    case "constant":
      return "variable";
    case "property":
    case "field":
      return "property";
    case "enumMember":
      return "enumMember";
    case "function":
    case "constructor":
      return "function";
    case "method":
      return "method";
    case "keyword":
      return "keyword";
    default:
      return "variable";
  }
}

function modifierBit(mod: SemanticTokenModifier): number {
  const idx = SEMANTIC_TOKEN_MODIFIERS.indexOf(
    mod as (typeof SEMANTIC_TOKEN_MODIFIERS)[number],
  );
  if (idx < 0) {
    return 0;
  }
  return 1 << idx;
}

function modifiersMask(mods: readonly SemanticTokenModifier[]): number {
  let mask = 0;
  for (const m of mods) {
    mask |= modifierBit(m);
  }
  return mask;
}

function tokenTypeIndex(name: SemanticTokenTypeName): number {
  return SEMANTIC_TOKEN_TYPES.indexOf(name);
}

function spanLength(span: SourceSpan): number {
  return Math.max(0, span.end.offset - span.start.offset);
}

/**
 * Build full-document semantic tokens for `file`, based on resolved symbolInfo
 * plus use-sites from definitions/memberDefinitions (inheriting kind from defs).
 */
export function semanticTokensForFile(
  model: SemanticModel,
  file: string,
): SemanticToken[] {
  const tokens = new Map<string, SemanticToken>();

  const addInfo = (info: SymbolSemanticInfo, isDecl: boolean) => {
    if (info.location.file !== file) {
      return;
    }
    const span = info.location.span;
    const length = spanLength(span);
    if (length <= 0) {
      return;
    }
    const key = semanticKey(file, span.start.offset);
    const mods = isDecl
      ? info.modifiers
      : info.modifiers.filter(
          (m) => m !== "declaration" && m !== "definition",
        );
    tokens.set(key, {
      line: Math.max(0, span.start.line - 1),
      startChar: Math.max(0, span.start.column - 1),
      length,
      tokenType: tokenTypeIndex(kindToTokenType(info.kind)),
      tokenModifiers: modifiersMask(mods),
    });
  };

  for (const info of model.symbolInfo.values()) {
    if (info.location.file === file) {
      addInfo(info, true);
    }
  }

  // Use-sites: inherit classification from the definition's symbolInfo.
  for (const [useKey, def] of model.definitions) {
    if (!useKey.startsWith(`${file}:`)) {
      continue;
    }
    const defInfo = model.symbolInfo.get(
      `${def.file}:${def.span.start.offset}`,
    );
    if (!defInfo) {
      continue;
    }
    const useOff = Number(useKey.slice(file.length + 1));
    if (!Number.isFinite(useOff)) {
      continue;
    }
    if (tokens.has(useKey)) {
      continue; // declaration already recorded
    }
    const mod = model.modules.find((m) => m.path === file);
    if (!mod) {
      continue;
    }
    // Reconstruct span from source identifier
    let end = useOff;
    while (end < mod.source.length && /[A-Za-z0-9_]/.test(mod.source[end]!)) {
      end += 1;
    }
    let line = 1;
    let column = 1;
    for (let i = 0; i < useOff; i += 1) {
      if (mod.source[i] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    const mods = defInfo.modifiers.filter(
      (m) => m !== "declaration" && m !== "definition",
    );
    tokens.set(useKey, {
      line: line - 1,
      startChar: column - 1,
      length: Math.max(1, end - useOff),
      tokenType: tokenTypeIndex(kindToTokenType(defInfo.kind)),
      tokenModifiers: modifiersMask(mods),
    });
  }

  for (const [useKey, def] of model.memberDefinitions) {
    if (!useKey.startsWith(`${file}:`)) {
      continue;
    }
    const defInfo = model.symbolInfo.get(
      `${def.file}:${def.span.start.offset}`,
    );
    if (!defInfo) {
      continue;
    }
    if (tokens.has(useKey)) {
      continue;
    }
    const useOff = Number(useKey.slice(file.length + 1));
    if (!Number.isFinite(useOff)) {
      continue;
    }
    const mod = model.modules.find((m) => m.path === file);
    if (!mod) {
      continue;
    }
    let end = useOff;
    while (end < mod.source.length && /[A-Za-z0-9_]/.test(mod.source[end]!)) {
      end += 1;
    }
    let line = 1;
    let column = 1;
    for (let i = 0; i < useOff; i += 1) {
      if (mod.source[i] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    const mods = defInfo.modifiers.filter(
      (m) => m !== "declaration" && m !== "definition",
    );
    tokens.set(useKey, {
      line: line - 1,
      startChar: column - 1,
      length: Math.max(1, end - useOff),
      tokenType: tokenTypeIndex(kindToTokenType(defInfo.kind)),
      tokenModifiers: modifiersMask(mods),
    });
  }

  return [...tokens.values()].sort((a, b) => {
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.startChar - b.startChar;
  });
}

/** Encode tokens as LSP semanticTokens/full data array (delta-encoded). */
export function encodeSemanticTokens(tokens: readonly SemanticToken[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const t of tokens) {
    const deltaLine = t.line - prevLine;
    const deltaStart = deltaLine === 0 ? t.startChar - prevChar : t.startChar;
    data.push(deltaLine, deltaStart, t.length, t.tokenType, t.tokenModifiers);
    prevLine = t.line;
    prevChar = t.startChar;
  }
  return data;
}
