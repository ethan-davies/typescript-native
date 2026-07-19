import type { SourceSpan } from "../diagnostics/diagnostic.js";

export enum TokenKind {
  Identifier = "Identifier",
  String = "String",
  Char = "Char",
  Integer = "Integer",
  Float = "Float",

  Function = "function",
  Struct = "struct",
  Let = "let",
  Const = "const",
  Return = "return",
  True = "true",
  False = "false",
  If = "if",
  Else = "else",
  ElseIf = "elseif",
  While = "while",
  For = "for",
  Break = "break",
  Continue = "continue",
  In = "in",

  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  LBracket = "[",
  RBracket = "]",
  Semicolon = ";",
  Colon = ":",
  Comma = ",",
  Dot = ".",
  Plus = "+",
  PlusPlus = "++",
  PlusEqual = "+=",
  Minus = "-",
  MinusMinus = "--",
  MinusEqual = "-=",
  Star = "*",
  Slash = "/",
  Percent = "%",
  Equal = "=",
  EqualEqual = "==",
  Bang = "!",
  BangEqual = "!=",
  Less = "<",
  LessEqual = "<=",
  Greater = ">",
  GreaterEqual = ">=",
  AmpAmp = "&&",
  PipePipe = "||",

  Eof = "Eof",
  Invalid = "Invalid",
}

export interface Token {
  readonly kind: TokenKind;
  readonly lexeme: string;
  /** Decoded value for string/char literals; otherwise undefined. */
  readonly value?: string;
  readonly span: SourceSpan;
}

export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["function", TokenKind.Function],
  ["struct", TokenKind.Struct],
  ["let", TokenKind.Let],
  ["const", TokenKind.Const],
  ["return", TokenKind.Return],
  ["true", TokenKind.True],
  ["false", TokenKind.False],
  ["if", TokenKind.If],
  ["else", TokenKind.Else],
  ["elseif", TokenKind.ElseIf],
  ["while", TokenKind.While],
  ["for", TokenKind.For],
  ["break", TokenKind.Break],
  ["continue", TokenKind.Continue],
  ["in", TokenKind.In],
]);
