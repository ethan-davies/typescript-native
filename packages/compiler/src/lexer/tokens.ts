import type { SourceSpan } from "../diagnostics/diagnostic.js";

export enum TokenKind {
  Identifier = "Identifier",
  String = "String",

  Function = "function",

  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  Semicolon = ";",

  Eof = "Eof",
  Invalid = "Invalid",
}

export interface Token {
  readonly kind: TokenKind;
  readonly lexeme: string;
  /** Decoded value for string literals; otherwise undefined. */
  readonly value?: string;
  readonly span: SourceSpan;
}

export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["function", TokenKind.Function],
]);
