import type { Diagnostic } from "./diagnostics/diagnostic.js";

export function formatDiagnostics(diagnostics: readonly Diagnostic[], fileName = "<source>"): string {
  return diagnostics
    .map((d) => {
      const loc = d.span
        ? `${fileName}:${d.span.start.line}:${d.span.start.column}`
        : fileName;
      const code = d.code ? ` [${d.code}]` : "";
      return `${loc}: ${d.severity}${code}: ${d.message}`;
    })
    .join("\n");
}
