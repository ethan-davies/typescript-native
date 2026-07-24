/**
 * Public FFI helpers: C-ABI compatibility checks, attribute parsing, unsafe ops.
 */
import type {
  Attribute,
  FunctionDeclaration,
  StructDeclaration,
} from "./ast/nodes.js";
import type { SourceSpan } from "./diagnostics/diagnostic.js";
import type { DiagnosticCollector } from "./diagnostics/diagnostic.js";

/** Structural ValueType subset used by FFI checks (avoids circular imports). */
export type FfiType =
  | string
  | "void"
  | { readonly kind: "ptr"; readonly element: FfiType }
  | {
      readonly kind: "fnptr";
      readonly params: readonly FfiType[];
      readonly returnType: FfiType;
    }
  | {
      readonly kind: "fixedArray";
      readonly element: FfiType;
      readonly length: number;
    }
  | { readonly kind: "struct"; readonly name: string }
  | { readonly kind: "class"; readonly name: string }
  | { readonly kind: "array"; readonly element: FfiType }
  | { readonly kind: "function"; readonly params?: unknown; readonly returnType?: unknown }
  | { readonly kind: string; readonly [key: string]: unknown };

export function isPtrType(t: FfiType): t is {
  readonly kind: "ptr";
  readonly element: FfiType;
} {
  return typeof t === "object" && t !== null && t.kind === "ptr";
}

export function isFnPtrType(t: FfiType): t is {
  readonly kind: "fnptr";
  readonly params: readonly FfiType[];
  readonly returnType: FfiType;
} {
  return typeof t === "object" && t !== null && t.kind === "fnptr";
}

export function isFixedArrayType(t: FfiType): t is {
  readonly kind: "fixedArray";
  readonly element: FfiType;
  readonly length: number;
} {
  return typeof t === "object" && t !== null && t.kind === "fixedArray";
}

const C_INT_PRIMITIVES = new Set<string>([
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "isize",
  "usize",
  "char",
]);

const C_FLOAT_PRIMITIVES = new Set<string>(["f32", "f64"]);

export function isCAbiPrimitive(t: FfiType): boolean {
  if (t === "void") {
    return true;
  }
  if (typeof t === "string") {
    return C_INT_PRIMITIVES.has(t) || C_FLOAT_PRIMITIVES.has(t);
  }
  return false;
}

export function isCAbiCompatible(
  t: FfiType,
  options: {
    allowLegacyString?: boolean;
    isReprCStruct?: (name: string) => boolean;
  } = {},
): boolean {
  if (t === "void") {
    return true;
  }
  if (typeof t === "string") {
    if (t === "string") {
      return options.allowLegacyString === true;
    }
    if (t === "bool" || t === "null") {
      return false;
    }
    return isCAbiPrimitive(t);
  }
  if (isPtrType(t)) {
    return isCAbiCompatible(t.element, { ...options, allowLegacyString: false });
  }
  if (isFnPtrType(t)) {
    for (const p of t.params) {
      if (!isCAbiCompatible(p, { ...options, allowLegacyString: false })) {
        return false;
      }
    }
    return isCAbiCompatible(t.returnType, { ...options, allowLegacyString: false });
  }
  if (isFixedArrayType(t)) {
    return isCAbiCompatible(t.element, { ...options, allowLegacyString: false });
  }
  if (t.kind === "struct") {
    return options.isReprCStruct?.(String(t.name)) === true;
  }
  return false;
}

export function cAbiIncompatibilityReason(t: FfiType): string {
  if (t === "void") {
    return "";
  }
  if (typeof t === "string") {
    if (t === "string") {
      return "Type `string` cannot be used in a C-compatible context. Use `Ptr<u8>` or a C-compatible representation instead.";
    }
    if (t === "bool") {
      return "Type `bool` is not C ABI compatible (use `u8` or `i32`).";
    }
    return `Type \`${t}\` is not C ABI compatible.`;
  }
  if (t.kind === "function") {
    return "Type is a Sonite callable (closure) and cannot be passed as a native function pointer. Use `FnPtr<(...) => ...>`.";
  }
  if (t.kind === "class") {
    return `Type \`${String(t.name)}\` is a managed class and cannot be used in a C-compatible context.`;
  }
  if (t.kind === "array") {
    return "Sonite arrays (`T[]`) are not C-compatible. Use `Ptr<T>` or a fixed-size `T[N]` in `@repr(\"C\")` structs.";
  }
  if (t.kind === "struct") {
    return `Struct \`${String(t.name)}\` is not marked @repr("C").`;
  }
  return "Type is not C ABI compatible.";
}

export interface ParsedFfiAttributes {
  readonly abi: "C" | null;
  readonly repr: "C" | null;
  readonly symbol: string | null;
}

export function parseFfiAttributes(
  attributes: readonly Attribute[],
  diagnostics: DiagnosticCollector,
  allowed: ReadonlySet<string>,
): ParsedFfiAttributes {
  let abi: "C" | null = null;
  let repr: "C" | null = null;
  let symbol: string | null = null;

  for (const attr of attributes) {
    const name = attr.name.name;
    if (!allowed.has(name)) {
      diagnostics.error(
        `Unknown or disallowed attribute '@${name}'`,
        attr.span,
        "E0501",
      );
      continue;
    }
    if (name === "abi") {
      if (attr.value !== "C") {
        diagnostics.error(
          `Unsupported ABI '${attr.value ?? ""}'; only @abi("C") is supported`,
          attr.span,
          "E0502",
        );
      } else {
        abi = "C";
      }
    } else if (name === "repr") {
      if (attr.value !== "C") {
        diagnostics.error(
          `Unsupported representation '${attr.value ?? ""}'; only @repr("C") is supported`,
          attr.span,
          "E0503",
        );
      } else {
        repr = "C";
      }
    } else if (name === "symbol") {
      if (!attr.value || attr.value.length === 0) {
        diagnostics.error(`@symbol requires a non-empty string`, attr.span, "E0504");
      } else {
        symbol = attr.value;
      }
    }
  }

  return { abi, repr, symbol };
}

const FUNCTION_ATTRS = new Set(["abi", "symbol"]);
const STRUCT_ATTRS = new Set(["repr"]);

export function validateFunctionAttributes(
  decl: FunctionDeclaration,
  diagnostics: DiagnosticCollector,
): string | null {
  const parsed = parseFfiAttributes(decl.attributes, diagnostics, FUNCTION_ATTRS);
  if (!decl.isExtern && (parsed.abi || parsed.symbol)) {
    diagnostics.error(
      `@abi and @symbol are only valid on extern functions`,
      decl.name.span,
      "E0506",
    );
  }
  return parsed.symbol;
}

export function validateStructAttributes(
  decl: StructDeclaration,
  diagnostics: DiagnosticCollector,
): boolean {
  const parsed = parseFfiAttributes(decl.attributes, diagnostics, STRUCT_ATTRS);
  if (parsed.abi || parsed.symbol) {
    diagnostics.error(
      `@abi and @symbol are only valid on extern functions`,
      decl.name.span,
      "E0506",
    );
  }
  return parsed.repr === "C";
}

/** Std / prelude modules are a trusted FFI boundary (extern calls allowed without unsafe). */
export function isTrustedFfiModule(modulePath: string): boolean {
  const normalized = modulePath.replace(/\\/g, "/");
  return (
    normalized.includes("/packages/std/") ||
    normalized.includes("/std/src/") ||
    /\/prelude\//.test(normalized)
  );
}

export function requireUnsafe(
  inUnsafe: boolean,
  diagnostics: DiagnosticCollector,
  span: SourceSpan,
  what: string,
): boolean {
  if (inUnsafe) {
    return true;
  }
  diagnostics.error(
    `${what} requires an unsafe context (use \`unsafe { ... }\` or \`unsafe function\`)`,
    span,
    "E0510",
  );
  return false;
}
