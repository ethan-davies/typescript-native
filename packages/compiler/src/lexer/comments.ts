import type { SourceSpan } from "../diagnostics/diagnostic.js";

export interface SourceComment {
  readonly kind: "line" | "block";
  /** Full lexeme including the line or block comment delimiters. */
  readonly text: string;
  readonly span: SourceSpan;
}
