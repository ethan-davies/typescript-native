/**
 * Value vs reference vs compile-time-only classification for semantic types.
 *
 * Separate from what a type *is* (`TypeKind`): category answers whether values
 * of the type are copied, held as heap references, or exist only at compile time.
 *
 * Uses ExtendedValueType from typecheck-advanced to avoid importing typecheck
 * (typecheck re-exports this module).
 */
import type { ExtendedValueType } from "../typecheck-advanced.js";

export type TypeCategory = "value" | "reference" | "compileTimeOnly";

export type TypeKind =
  | "primitive"
  | "string"
  | "null"
  | "enum"
  | "struct"
  | "class"
  | "array"
  | "tuple"
  | "map"
  | "function"
  | "future"
  | "interface"
  | "object"
  | "literal"
  | "union"
  | "intersection"
  | "typeParam"
  | "void";

export type ClassifiableType = ExtendedValueType | "void";

const VALUE_PRIMITIVES = new Set<string>(["i32", "i64", "f32", "f64", "bool", "char"]);

/** What the type is, independent of value/reference category. */
export function typeKind(type: ClassifiableType): TypeKind {
  if (type === "void") {
    return "void";
  }
  if (typeof type === "string") {
    if (type === "string") {
      return "string";
    }
    if (type === "null") {
      return "null";
    }
    return "primitive";
  }
  switch (type.kind) {
    case "enum":
    case "struct":
    case "class":
    case "array":
    case "tuple":
    case "map":
    case "function":
    case "future":
    case "interface":
    case "object":
    case "literal":
    case "union":
    case "intersection":
    case "typeParam":
      return type.kind;
  }
}

/** Whether values of this type are copied, referenced, or compile-time only. */
export function typeCategory(type: ClassifiableType): TypeCategory {
  if (type === "void") {
    return "compileTimeOnly";
  }
  if (typeof type === "string") {
    if (VALUE_PRIMITIVES.has(type)) {
      return "value";
    }
    // `string` and `null` are reference-like.
    return "reference";
  }

  switch (type.kind) {
    case "enum":
    case "struct":
    case "tuple":
    case "object":
      return "value";
    case "class":
    case "array":
    case "map":
    case "function":
    case "future":
      return "reference";
    case "interface":
    case "typeParam":
      return "compileTimeOnly";
    case "literal":
      return type.literalKind === "string" ? "reference" : "value";
    case "union":
    case "intersection":
      return categoryFromArms(type.arms);
  }
}

function categoryFromArms(arms: readonly ClassifiableType[]): TypeCategory {
  let sawCompileTimeOnly = false;
  for (const arm of arms) {
    const cat = typeCategory(arm);
    if (cat === "reference") {
      return "reference";
    }
    if (cat === "compileTimeOnly") {
      sawCompileTimeOnly = true;
    }
  }
  return sawCompileTimeOnly ? "compileTimeOnly" : "value";
}

export function isValueCategory(type: ClassifiableType): boolean {
  return typeCategory(type) === "value";
}

export function isReferenceCategory(type: ClassifiableType): boolean {
  return typeCategory(type) === "reference";
}

export function isCompileTimeOnlyCategory(type: ClassifiableType): boolean {
  return typeCategory(type) === "compileTimeOnly";
}
