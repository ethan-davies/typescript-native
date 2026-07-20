/**
 * Encode a type annotation for use in a monomorphized symbol name.
 * Examples: i32 → i32, string → string, T[] → arr__T, Array<i32> → Array__i32
 */
import type { TypeAnnotation } from "../ast/nodes.js";

export function mangleTypeAnnotation(ann: TypeAnnotation): string {
  if (ann.kind === "PrimitiveType") {
    return ann.name;
  }
  if (ann.kind === "ArrayType") {
    return `arr__${mangleTypeAnnotation(ann.element)}`;
  }
  const base = ann.namespace ? `${ann.namespace}_${ann.name}` : ann.name;
  if (ann.typeArgs.length === 0) {
    return base;
  }
  return mangleInstance(base, ann.typeArgs);
}

/** `Array` + [i32, string] → `Array__i32__string` */
export function mangleInstance(baseLocalName: string, typeArgs: readonly TypeAnnotation[]): string {
  if (typeArgs.length === 0) {
    return baseLocalName;
  }
  return `${baseLocalName}__${typeArgs.map(mangleTypeAnnotation).join("__")}`;
}

/** Method instance: `Cache__get__i32` or with class args `Cache__string__get__i32`. */
export function mangleMethodInstance(
  ownerLocalName: string,
  methodName: string,
  ownerTypeArgs: readonly TypeAnnotation[],
  methodTypeArgs: readonly TypeAnnotation[],
): string {
  const owner = mangleInstance(ownerLocalName, ownerTypeArgs);
  if (methodTypeArgs.length === 0) {
    return `${owner}__${methodName}`;
  }
  return `${owner}__${methodName}__${methodTypeArgs.map(mangleTypeAnnotation).join("__")}`;
}

export function mangleFunctionInstance(
  functionName: string,
  typeArgs: readonly TypeAnnotation[],
): string {
  return mangleInstance(functionName, typeArgs);
}
