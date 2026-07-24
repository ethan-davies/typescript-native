/**
 * Encode a type annotation for use in a monomorphized symbol name.
 * Examples: i32 → i32, string → string, T[] → arr__T, Array<i32> → Array__i32
 */
import type { TypeAnnotation } from "../ast/nodes.js";

export function mangleTypeAnnotation(ann: TypeAnnotation): string {
  switch (ann.kind) {
    case "PrimitiveType":
      return ann.name;
    case "ArrayType":
      return `arr__${mangleTypeAnnotation(ann.element)}`;
    case "TupleType":
      return `tup__${ann.elements.map(mangleTypeAnnotation).join("__")}`;
    case "NamedType": {
      const base = ann.namespace ? `${ann.namespace}_${ann.name}` : ann.name;
      if (ann.typeArgs.length === 0) {
        return base;
      }
      return mangleInstance(base, ann.typeArgs);
    }
    case "UnionType":
      return `union__${ann.types.map(mangleTypeAnnotation).join("__or__")}`;
    case "IntersectionType":
      return `inter__${ann.types.map(mangleTypeAnnotation).join("__and__")}`;
    case "ObjectType": {
      const fields = ann.fields
        .map((f) => `${f.name.name}__${mangleTypeAnnotation(f.typeAnnotation)}`)
        .join("__");
      const idx = ann.indexSignature
        ? `__idx__${mangleTypeAnnotation(ann.indexSignature.valueType)}`
        : "";
      return `obj__${fields}${idx}`;
    }
    case "LiteralType":
      return ann.literalKind === "string"
        ? `litstr__${String(ann.value).replace(/[^a-zA-Z0-9]/g, "_")}`
        : `litnum__${ann.value}`;
    case "KeyofType":
      return `keyof__${mangleTypeAnnotation(ann.type)}`;
    case "TypeofType":
      return "typeof";
    case "ConditionalType":
      return `cond__${mangleTypeAnnotation(ann.checkType)}__${mangleTypeAnnotation(ann.extendsType)}`;
    case "MappedType":
      return `mapped__${mangleTypeAnnotation(ann.constraint)}__${mangleTypeAnnotation(ann.type)}`;
    case "IndexedAccessType":
      return `idxacc__${mangleTypeAnnotation(ann.objectType)}__${mangleTypeAnnotation(ann.indexType)}`;
    case "FunctionType":
      return `fn__${ann.params.map(mangleTypeAnnotation).join("__")}__to__${mangleTypeAnnotation(ann.returnType)}`;
    case "PtrType":
      return `ptr__${mangleTypeAnnotation(ann.element)}`;
    case "FnPtrType":
      return `fnptr__${ann.params.map(mangleTypeAnnotation).join("__")}__to__${mangleTypeAnnotation(ann.returnType)}`;
    case "FixedArrayType":
      return `fixarr__${mangleTypeAnnotation(ann.element)}__${ann.length}`;
    case "MissingType":
      return "missing";
  }
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
