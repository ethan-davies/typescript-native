import type { Program } from "./ast/nodes.js";
import type { DiagnosticCollector } from "./diagnostics/diagnostic.js";

/**
 * Semantic checks for the v0 language beyond pure grammar.
 */
export function validate(program: Program, diagnostics: DiagnosticCollector): void {
  if (program.body.length === 0) {
    diagnostics.error("Program must define a main() function", program.span, "E0200");
    return;
  }

  if (program.body.length > 1) {
    const extra = program.body[1];
    diagnostics.error(
      "Only one top-level function is allowed",
      extra?.span ?? program.span,
      "E0201",
    );
  }

  const fn = program.body[0];
  if (!fn) {
    return;
  }

  if (fn.name.name !== "main") {
    diagnostics.error(
      `Entry function must be named 'main', found '${fn.name.name}'`,
      fn.name.span,
      "E0202",
    );
  }

  for (const stmt of fn.body) {
    const call = stmt.expression;
    if (call.callee.name !== "print") {
      diagnostics.error(
        `Only 'print' calls are supported, found '${call.callee.name}'`,
        call.callee.span,
        "E0203",
      );
      continue;
    }
    if (call.args.length !== 1 || call.args[0]?.kind !== "StringLiteral") {
      diagnostics.error(
        "'print' requires exactly one string argument",
        call.span,
        "E0204",
      );
    }
  }
}
