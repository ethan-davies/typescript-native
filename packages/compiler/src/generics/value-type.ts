import type { TypeAnnotation } from "../ast/nodes.js";

/** Minimal structural mirror of ValueType to avoid circular imports. */
export type MonoValueType =
  | string
  | { readonly kind: "array"; readonly element: MonoValueType }
  | { readonly kind: "tuple"; readonly elements: readonly MonoValueType[] }
  | { readonly kind: "struct" | "class" | "interface" | "enum"; readonly name: string }
  | { readonly kind: "typeParam"; readonly name: string }
  | {
      readonly kind: "function";
      readonly isAsync: boolean;
      readonly params: readonly MonoValueType[];
      readonly returnType: MonoValueType | "void";
    }
  | {
      readonly kind: "future";
      readonly inner: MonoValueType | "void";
    }
  | { readonly kind: "ptr"; readonly element: MonoValueType | "void" }
  | {
      readonly kind: "fnptr";
      readonly params: readonly MonoValueType[];
      readonly returnType: MonoValueType | "void";
    }
  | {
      readonly kind: "fixedArray";
      readonly element: MonoValueType;
      readonly length: number;
    };

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
  if (type.kind === "tuple") {
    return {
      kind: "TupleType",
      elements: type.elements.map(valueTypeToAnnotation),
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
  if (type.kind === "function") {
    return {
      kind: "FunctionType",
      isAsync: type.isAsync ?? false,
      params: type.params.map(valueTypeToAnnotation),
      returnType:
        type.returnType === "void"
          ? { kind: "PrimitiveType", name: "void", span: EMPTY_SPAN }
          : valueTypeToAnnotation(type.returnType),
      span: EMPTY_SPAN,
    };
  }
  if (type.kind === "future") {
    return {
      kind: "NamedType",
      namespace: null,
      name: "Future",
      typeArgs: [
        type.inner === "void"
          ? { kind: "PrimitiveType", name: "void", span: EMPTY_SPAN }
          : valueTypeToAnnotation(type.inner),
      ],
      span: EMPTY_SPAN,
    };
  }
  if (type.kind === "ptr") {
    return {
      kind: "PtrType",
      element:
        type.element === "void"
          ? { kind: "PrimitiveType", name: "void", span: EMPTY_SPAN }
          : valueTypeToAnnotation(type.element),
      span: EMPTY_SPAN,
    };
  }
  if (type.kind === "fnptr") {
    return {
      kind: "FnPtrType",
      params: type.params.map(valueTypeToAnnotation),
      returnType:
        type.returnType === "void"
          ? { kind: "PrimitiveType", name: "void", span: EMPTY_SPAN }
          : valueTypeToAnnotation(type.returnType),
      span: EMPTY_SPAN,
    };
  }
  if (type.kind === "fixedArray") {
    return {
      kind: "FixedArrayType",
      element: valueTypeToAnnotation(type.element),
      length: type.length,
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
