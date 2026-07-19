import type {
  CallExpression,
  FunctionDeclaration,
  Program,
  StringLiteral,
} from "../ast/nodes.js";

/**
 * Lowers a validated AST to LLVM IR text that links with libc `puts`.
 */
export class LlvmCodegen {
  private stringCounter = 0;
  private readonly stringGlobals = new Map<string, { name: string; length: number }>();

  emit(program: Program): string {
    this.stringCounter = 0;
    this.stringGlobals.clear();

    const fn = program.body[0];
    if (!fn) {
      throw new Error("LlvmCodegen.emit called without a function");
    }

    const bodyLines = this.emitMainBody(fn);
    const globalLines = this.emitStringGlobals();

    return [
      "; ModuleID = 'typescript-native'",
      'source_filename = "typescript-native"',
      "",
      ...globalLines,
      globalLines.length > 0 ? "" : null,
      "declare i32 @puts(ptr noundef) nounwind",
      "",
      "define i32 @main() {",
      "entry:",
      ...bodyLines,
      "  ret i32 0",
      "}",
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private emitMainBody(fn: FunctionDeclaration): string[] {
    const lines: string[] = [];
    let temp = 0;

    for (const stmt of fn.body) {
      const call = stmt.expression;
      this.assertPrintCall(call);
      const arg = call.args[0] as StringLiteral;
      const global = this.internString(arg.value);
      const ptrName = `%str${temp}`;
      temp += 1;
      lines.push(
        `  ${ptrName} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
      );
      lines.push(`  call i32 @puts(ptr noundef ${ptrName})`);
    }

    return lines;
  }

  private assertPrintCall(call: CallExpression): void {
    if (call.callee.name !== "print" || call.args[0]?.kind !== "StringLiteral") {
      throw new Error("LlvmCodegen expected print(string) calls only");
    }
  }

  private internString(value: string): { name: string; length: number } {
    const existing = this.stringGlobals.get(value);
    if (existing) {
      return existing;
    }

    const name = `.str.${this.stringCounter}`;
    this.stringCounter += 1;
    // +1 for the null terminator included in the global constant
    const length = Buffer.byteLength(value, "utf8") + 1;
    const entry = { name, length };
    this.stringGlobals.set(value, entry);
    return entry;
  }

  private emitStringGlobals(): string[] {
    const lines: string[] = [];
    for (const [value, { name, length }] of this.stringGlobals) {
      const encoded = encodeLlvmString(value);
      lines.push(
        `@${name} = private unnamed_addr constant [${length} x i8] c"${encoded}\\00", align 1`,
      );
    }
    return lines;
  }
}

/** Escape a UTF-8 string for an LLVM `c"..."` constant (without the trailing NUL). */
export function encodeLlvmString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c || byte < 0x20 || byte > 0x7e) {
      out += `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}
