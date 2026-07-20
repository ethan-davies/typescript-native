/** Source location within a file (1-based line/column). */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** Span covering a contiguous region of source text. */
export interface SourceSpan {
  readonly start: SourceLocation;
  readonly end: SourceLocation;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly code?: string;
}

export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];

  error(message: string, span?: SourceSpan, code?: string): void {
    this.items.push({ severity: "error", message, ...(span ? { span } : {}), ...(code ? { code } : {}) });
  }

  warning(message: string, span?: SourceSpan, code?: string): void {
    this.items.push({ severity: "warning", message, ...(span ? { span } : {}), ...(code ? { code } : {}) });
  }

  info(message: string, span?: SourceSpan, code?: string): void {
    this.items.push({ severity: "info", message, ...(span ? { span } : {}), ...(code ? { code } : {}) });
  }

  get diagnostics(): readonly Diagnostic[] {
    return this.items;
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  /** Discard diagnostics beyond `length` (used for speculative parses). */
  truncate(length: number): void {
    if (length < this.items.length) {
      this.items.length = length;
    }
  }

  format(fileName = "<source>"): string {
    return this.items
      .map((d) => {
        const loc = d.span
          ? `${fileName}:${d.span.start.line}:${d.span.start.column}`
          : fileName;
        const code = d.code ? ` [${d.code}]` : "";
        return `${loc}: ${d.severity}${code}: ${d.message}`;
      })
      .join("\n");
  }
}
