import type { TypeAnnotation } from "../ast/nodes.js";

/** Minimal structural mirror of ValueType to avoid circular imports. */
export type MonoValueType =
  | string
  | { readonly kind: "array"; readonly element: MonoValueType }
  | { readonly kind: "struct" | "class" | "interface" | "enum"; readonly name: string }
  | { readonly kind: "typeParam"; readonly name: string };

const EMPTY_SPAN = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 },
};

/** Convert a checked value type back to an annotation for mangling / subst. */
export function valueTypeToAnnotation(type: MonoValueType): TypeAnnotation {
  if (typeof type === "string") {
    return { kind: "PrimitiveType", name: type as "i32", span: EMPTY_SPAN };
  }
  if (type.kind === "array") {
    return {
      kind: "ArrayType",
      element: valueTypeToAnnotation(type.element),
      span: EMPTY_SPAN,
    };
  }
  if (type.kind === "typeParam") {
    return {
      kind: "NamedType",
      namespace: null,
      name: type.name,
      typeArgs: [],
      span: EMPTY_SPAN,
    };
  }
  // Use the concrete type's name as written for monomorphization (already mangled instance).
  const name = type.name.includes(".") ? type.name.split(".").pop()! : type.name;
  return {
    kind: "NamedType",
    namespace: null,
    name,
    typeArgs: [],
    span: EMPTY_SPAN,
  };
}
