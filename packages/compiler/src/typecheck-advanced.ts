/**
 * Advanced type variants, assignability, narrowing, and helpers for the type checker.
 */
import type { Expression, TypeAliasDeclaration, TypeAnnotation } from "./ast/nodes.js";
import type { DiagnosticCollector, SourceSpan } from "./diagnostics/diagnostic.js";

/** Mirror of base ValueType shapes without importing typecheck (avoids cycles). */
export type BaseValueType =
  | string
  | { readonly kind: "array"; readonly element: ExtendedValueType }
  | { readonly kind: "tuple"; readonly elements: readonly ExtendedValueType[] }
  | { readonly kind: "struct" | "class" | "interface" | "enum"; readonly name: string }
  | {
      readonly kind: "typeParam";
      readonly name: string;
      readonly constraintName: string | null;
      readonly constraintKind: "interface" | "class" | null;
    };

export interface UnionValueType {
  readonly kind: "union";
  readonly arms: readonly ExtendedValueType[];
}

export interface IntersectionValueType {
  readonly kind: "intersection";
  readonly arms: readonly ExtendedValueType[];
}

export interface ObjectFieldValue {
  readonly name: string;
  readonly type: ExtendedValueType;
  readonly readonly: boolean;
}

export interface ObjectValueType {
  readonly kind: "object";
  readonly name: string;
  readonly fields: readonly ObjectFieldValue[];
  readonly indexType: ExtendedValueType | null;
}

export interface LiteralValueType {
  readonly kind: "literal";
  readonly value: string | number;
  readonly literalKind: "string" | "number";
}

export interface MapValueType {
  readonly kind: "map";
  readonly valueType: ExtendedValueType;
}

export interface FunctionValueType {
  readonly kind: "function";
  readonly isAsync: boolean;
  readonly params: readonly ExtendedValueType[];
  readonly returnType: ExtendedValueType | "void";
}

/** Asynchronous result type produced by calling an async function. */
export interface FutureValueType {
  readonly kind: "future";
  readonly inner: ExtendedValueType | "void";
}

export type ExtendedValueType =
  | BaseValueType
  | UnionValueType
  | IntersectionValueType
  | ObjectValueType
  | LiteralValueType
  | MapValueType
  | FunctionValueType
  | FutureValueType;

export interface TypeAliasDef {
  readonly name: string;
  readonly localName: string;
  readonly decl: TypeAliasDeclaration;
  readonly exported: boolean;
}

export function isUnionType(type: ExtendedValueType): type is UnionValueType {
  return typeof type === "object" && type.kind === "union";
}

export function isIntersectionType(type: ExtendedValueType): type is IntersectionValueType {
  return typeof type === "object" && type.kind === "intersection";
}

export function isObjectType(type: ExtendedValueType): type is ObjectValueType {
  return typeof type === "object" && type.kind === "object";
}

export function isLiteralType(type: ExtendedValueType): type is LiteralValueType {
  return typeof type === "object" && type.kind === "literal";
}

export function isMapType(type: ExtendedValueType): type is MapValueType {
  return typeof type === "object" && type.kind === "map";
}

export function isFunctionType(type: ExtendedValueType): type is FunctionValueType {
  return typeof type === "object" && type.kind === "function";
}

export function isFutureType(type: ExtendedValueType): type is FutureValueType {
  return typeof type === "object" && type.kind === "future";
}

export function isTupleType(
  type: ExtendedValueType,
): type is { readonly kind: "tuple"; readonly elements: readonly ExtendedValueType[] } {
  return typeof type === "object" && type.kind === "tuple";
}

export function flattenUnion(type: ExtendedValueType): ExtendedValueType[] {
  if (isUnionType(type)) {
    return type.arms.flatMap(flattenUnion);
  }
  return [type];
}

export function makeUnion(arms: readonly ExtendedValueType[]): ExtendedValueType {
  const flat = arms.flatMap(flattenUnion);
  const unique: ExtendedValueType[] = [];
  for (const arm of flat) {
    if (!unique.some((u) => advancedTypesEqual(u, arm))) {
      unique.push(arm);
    }
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return { kind: "union", arms: unique };
}

export function makeIntersection(arms: readonly ExtendedValueType[]): ExtendedValueType {
  const flat: ExtendedValueType[] = [];
  for (const arm of arms) {
    if (isIntersectionType(arm)) {
      flat.push(...arm.arms);
    } else {
      flat.push(arm);
    }
  }
  const objects = flat.filter(isObjectType);
  const others = flat.filter((t) => !isObjectType(t));
  if (objects.length > 1) {
    const merged = mergeObjects(objects);
    if (merged) {
      const rest = [...others, merged];
      if (rest.length === 1) {
        return rest[0]!;
      }
      return { kind: "intersection", arms: rest };
    }
  }
  if (flat.length === 1) {
    return flat[0]!;
  }
  return { kind: "intersection", arms: flat };
}

function mergeObjects(objects: ObjectValueType[]): ObjectValueType | null {
  const fields = new Map<string, ObjectFieldValue>();
  let indexType: ExtendedValueType | null = null;
  for (const obj of objects) {
    for (const f of obj.fields) {
      const existing = fields.get(f.name);
      if (existing && !advancedTypesEqual(existing.type, f.type)) {
        return null;
      }
      fields.set(f.name, f);
    }
    if (obj.indexType) {
      if (indexType && !advancedTypesEqual(indexType, obj.indexType)) {
        return null;
      }
      indexType = obj.indexType;
    }
  }
  const fieldList = [...fields.values()];
  return {
    kind: "object",
    name: objectShapeName(fieldList, indexType),
    fields: fieldList,
    indexType,
  };
}

export function advancedTypeToString(type: ExtendedValueType): string {
  if (typeof type === "string") {
    return type;
  }
  switch (type.kind) {
    case "array":
      return `${advancedTypeToString(type.element)}[]`;
    case "tuple":
      return `[${type.elements.map(advancedTypeToString).join(", ")}]`;
    case "union":
      return type.arms.map(advancedTypeToString).join(" | ");
    case "intersection":
      return type.arms.map(advancedTypeToString).join(" & ");
    case "object": {
      const fields = type.fields
        .map((f) => `${f.readonly ? "readonly " : ""}${f.name}: ${advancedTypeToString(f.type)}`)
        .join("; ");
      const idx = type.indexType
        ? `${fields ? "; " : ""}[key: string]: ${advancedTypeToString(type.indexType)}`
        : "";
      return `{ ${fields}${idx} }`;
    }
    case "literal":
      return type.literalKind === "string" ? `"${type.value}"` : String(type.value);
    case "map":
      return `{ [key: string]: ${advancedTypeToString(type.valueType)} }`;
    case "function": {
      const params = type.params.map(advancedTypeToString).join(", ");
      const ret =
        type.returnType === "void" ? "void" : advancedTypeToString(type.returnType);
      const prefix = type.isAsync ? "async " : "";
      return `${prefix}(${params}) => ${ret}`;
    }
    case "future": {
      const inner =
        type.inner === "void" ? "void" : advancedTypeToString(type.inner);
      return `Future<${inner}>`;
    }
    case "typeParam":
      return type.constraintName
        ? `${type.name} extends ${type.constraintName}`
        : type.name;
    default:
      return type.name;
  }
}

export function advancedTypesEqual(a: ExtendedValueType, b: ExtendedValueType): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "array":
      return b.kind === "array" && advancedTypesEqual(a.element, b.element);
    case "tuple":
      return (
        b.kind === "tuple" &&
        a.elements.length === b.elements.length &&
        a.elements.every((el, i) => advancedTypesEqual(el, b.elements[i]!))
      );
    case "union":
      return (
        b.kind === "union" &&
        a.arms.length === b.arms.length &&
        a.arms.every((arm, i) => advancedTypesEqual(arm, b.arms[i]!))
      );
    case "intersection":
      return (
        b.kind === "intersection" &&
        a.arms.length === b.arms.length &&
        a.arms.every((arm, i) => advancedTypesEqual(arm, b.arms[i]!))
      );
    case "object":
      return (
        b.kind === "object" &&
        a.fields.length === b.fields.length &&
        a.fields.every(
          (f, i) =>
            f.name === b.fields[i]!.name &&
            advancedTypesEqual(f.type, b.fields[i]!.type) &&
            f.readonly === b.fields[i]!.readonly,
        ) &&
        ((a.indexType === null && b.indexType === null) ||
          (a.indexType !== null &&
            b.indexType !== null &&
            advancedTypesEqual(a.indexType, b.indexType)))
      );
    case "literal":
      return b.kind === "literal" && a.literalKind === b.literalKind && a.value === b.value;
    case "map":
      return b.kind === "map" && advancedTypesEqual(a.valueType, b.valueType);
    case "function":
      return (
        b.kind === "function" &&
        a.isAsync === b.isAsync &&
        a.params.length === b.params.length &&
        a.params.every((p, i) => advancedTypesEqual(p, b.params[i]!)) &&
        ((a.returnType === "void" && b.returnType === "void") ||
          (a.returnType !== "void" &&
            b.returnType !== "void" &&
            advancedTypesEqual(a.returnType, b.returnType)))
      );
    case "future":
      return (
        b.kind === "future" &&
        ((a.inner === "void" && b.inner === "void") ||
          (a.inner !== "void" &&
            b.inner !== "void" &&
            advancedTypesEqual(a.inner, b.inner)))
      );
    case "typeParam":
      return b.kind === "typeParam" && a.name === b.name;
    case "struct":
    case "class":
    case "interface":
    case "enum":
      return b.kind === a.kind && a.name === (b as typeof a).name;
  }
}

export function literalBaseType(lit: LiteralValueType): string {
  return lit.literalKind === "string" ? "string" : "i32";
}

export function typeofTagForType(type: ExtendedValueType): string | null {
  if (type === "null") {
    return "null";
  }
  if (type === "string") {
    return "string";
  }
  if (type === "bool") {
    return "bool";
  }
  if (type === "char") {
    return "char";
  }
  if (typeof type === "string" && (type === "i32" || type === "i64" || type === "f32" || type === "f64")) {
    return type;
  }
  if (isLiteralType(type)) {
    return type.literalKind === "string" ? "string" : "i32";
  }
  if (typeof type === "object") {
    // class, struct, array, interface, enum, object, map, union → object at runtime typeof
    if (
      type.kind === "class" ||
      type.kind === "struct" ||
      type.kind === "interface" ||
      type.kind === "enum" ||
      type.kind === "array" ||
      type.kind === "tuple" ||
      type.kind === "object" ||
      type.kind === "map"
    ) {
      return "object";
    }
  }
  return null;
}

export function narrowByTypeofTag(
  type: ExtendedValueType,
  tag: string,
  positive: boolean,
): ExtendedValueType {
  const arms = flattenUnion(type);
  const matched = arms.filter((arm) => {
    const armTag = typeofTagForType(arm);
    return positive ? armTag === tag : armTag !== tag;
  });
  if (matched.length === 0) {
    return type;
  }
  return makeUnion(matched);
}

export function stripNull(type: ExtendedValueType): ExtendedValueType {
  const arms = flattenUnion(type).filter((a) => a !== "null");
  if (arms.length === 0) {
    return "null";
  }
  return makeUnion(arms);
}

export function includesNull(type: ExtendedValueType): boolean {
  return flattenUnion(type).some((a) => a === "null");
}

export function narrowByNullCheck(
  type: ExtendedValueType,
  positive: boolean,
): ExtendedValueType {
  // positive = value is not null (from `!= null` or successful non-null branch)
  if (positive) {
    return stripNull(type);
  }
  return "null";
}

function armMatchesIsTarget(
  arm: ExtendedValueType,
  target: ExtendedValueType,
): boolean {
  if (target === "null") {
    return arm === "null";
  }
  return advancedTypesEqual(arm, target);
}

export function narrowByIsType(
  type: ExtendedValueType,
  target: ExtendedValueType,
  positive: boolean,
): ExtendedValueType {
  if (target === "null") {
    // `is null` positive → null; negative → strip null
    return narrowByNullCheck(type, !positive);
  }
  const arms = flattenUnion(type);
  const kept = positive
    ? arms.filter((arm) => armMatchesIsTarget(arm, target))
    : arms.filter((arm) => !armMatchesIsTarget(arm, target));
  if (kept.length === 0) {
    return type;
  }
  return makeUnion(kept);
}

export type AssignabilityFn = (from: ExtendedValueType, to: ExtendedValueType) => boolean;

export function advancedIsAssignable(
  from: ExtendedValueType,
  to: ExtendedValueType,
  baseAssign: AssignabilityFn,
): boolean {
  if (advancedTypesEqual(from, to)) {
    return true;
  }

  if (from === "null") {
    if (to === "null") {
      return true;
    }
    if (isUnionType(to)) {
      return to.arms.some((arm) => advancedIsAssignable(from, arm, baseAssign));
    }
    return false;
  }

  if (isLiteralType(from)) {
    const base = literalBaseType(from);
    if (advancedTypesEqual(base, to) || baseAssign(base, to)) {
      return true;
    }
    if (isUnionType(to)) {
      return to.arms.some((arm) => advancedIsAssignable(from, arm, baseAssign));
    }
  }

  if (isLiteralType(to) && isLiteralType(from)) {
    return from.literalKind === to.literalKind && from.value === to.value;
  }

  // Assigning a base string/number to a literal union: handled via union target

  if (isUnionType(from)) {
    return from.arms.every((arm) => advancedIsAssignable(arm, to, baseAssign));
  }

  if (isUnionType(to)) {
    return to.arms.some((arm) => advancedIsAssignable(from, arm, baseAssign));
  }

  if (isIntersectionType(to)) {
    return to.arms.every((arm) => advancedIsAssignable(from, arm, baseAssign));
  }

  if (isIntersectionType(from)) {
    return from.arms.every((arm) => advancedIsAssignable(arm, to, baseAssign));
  }

  if (isObjectType(to)) {
    if (isObjectType(from)) {
      for (const field of to.fields) {
        const src = from.fields.find((f) => f.name === field.name);
        if (!src || !advancedIsAssignable(src.type, field.type, baseAssign)) {
          return false;
        }
      }
      if (to.indexType) {
        if (!from.indexType || !advancedIsAssignable(from.indexType, to.indexType, baseAssign)) {
          return false;
        }
      }
      return true;
    }
    if (isMapType(from) && to.indexType && to.fields.length === 0) {
      return advancedIsAssignable(from.valueType, to.indexType, baseAssign);
    }
  }

  if (isMapType(to) && isMapType(from)) {
    return advancedIsAssignable(from.valueType, to.valueType, baseAssign);
  }

  if (isMapType(to) && isObjectType(from) && from.indexType) {
    return advancedIsAssignable(from.indexType, to.valueType, baseAssign);
  }

  if (isTupleType(from) && isTupleType(to)) {
    return (
      from.elements.length === to.elements.length &&
      from.elements.every((el, i) => advancedIsAssignable(el, to.elements[i]!, baseAssign))
    );
  }

  if (isFunctionType(from) && isFunctionType(to)) {
    if (from.isAsync !== to.isAsync) {
      return false;
    }
    if (from.params.length !== to.params.length) {
      return false;
    }
    // Invariant params/return for now (no variance).
    if (!from.params.every((p, i) => advancedTypesEqual(p, to.params[i]!))) {
      return false;
    }
    if (from.returnType === "void" || to.returnType === "void") {
      return from.returnType === to.returnType;
    }
    return advancedTypesEqual(from.returnType, to.returnType);
  }

  if (isFutureType(from) && isFutureType(to)) {
    if (from.inner === "void" || to.inner === "void") {
      return from.inner === to.inner;
    }
    return advancedIsAssignable(from.inner, to.inner, baseAssign);
  }

  return baseAssign(from, to);
}

export function keyofType(type: ExtendedValueType): ExtendedValueType | null {
  if (isObjectType(type)) {
    if (type.fields.length === 0) {
      return "string";
    }
    return makeUnion(
      type.fields.map((f) => ({
        kind: "literal" as const,
        value: f.name,
        literalKind: "string" as const,
      })),
    );
  }
  return null;
}

export function objectShapeName(
  fields: readonly ObjectFieldValue[],
  indexType: ExtendedValueType | null,
): string {
  const fieldPart = fields.map((f) => `${f.name}_${mangleValueRough(f.type)}`).join("__");
  const idx = indexType ? `__idx_${mangleValueRough(indexType)}` : "";
  return `Obj__${fieldPart || "empty"}${idx}`;
}

function mangleValueRough(type: ExtendedValueType): string {
  if (typeof type === "string") {
    return type;
  }
  if (type.kind === "literal") {
    return type.literalKind === "string" ? `s_${type.value}` : `n_${type.value}`;
  }
  if (type.kind === "array") {
    return `arr_${mangleValueRough(type.element)}`;
  }
  if (type.kind === "union") {
    return `u_${type.arms.map(mangleValueRough).join("_")}`;
  }
  if (type.kind === "map") {
    return `map_${mangleValueRough(type.valueType)}`;
  }
  if (type.kind === "object") {
    return type.name;
  }
  if (type.kind === "intersection") {
    return `i_${type.arms.map(mangleValueRough).join("_")}`;
  }
  if ("name" in type) {
    return String(type.name).replace(/\./g, "_");
  }
  return "x";
}

export type NarrowingFact =
  | { readonly kind: "typeof"; readonly name: string; readonly tag: string; readonly positive: boolean }
  | { readonly kind: "nullCheck"; readonly name: string; readonly isNotNull: boolean }
  | { readonly kind: "is"; readonly name: string; readonly type: ExtendedValueType; readonly positive: boolean };

export type TypeAnnResolver = (ann: import("./ast/nodes.js").TypeAnnotation) => ExtendedValueType | null;

function invertFact(fact: NarrowingFact): NarrowingFact {
  switch (fact.kind) {
    case "typeof":
      return { ...fact, positive: !fact.positive };
    case "nullCheck":
      return { ...fact, isNotNull: !fact.isNotNull };
    case "is":
      return { ...fact, positive: !fact.positive };
  }
}

export function invertFacts(facts: readonly NarrowingFact[]): NarrowingFact[] {
  return facts.map(invertFact);
}

export function narrowTypeByFact(type: ExtendedValueType, fact: NarrowingFact): ExtendedValueType {
  switch (fact.kind) {
    case "typeof":
      return narrowByTypeofTag(type, fact.tag, fact.positive);
    case "nullCheck":
      return narrowByNullCheck(type, fact.isNotNull);
    case "is":
      return narrowByIsType(type, fact.type, fact.positive);
  }
}

/** Extract true-branch narrowing facts from a condition expression. */
export function extractNarrowingFacts(
  expr: Expression,
  resolveAnn?: TypeAnnResolver,
): NarrowingFact[] {
  if (expr.kind === "UnaryExpression" && expr.operator === "!") {
    return invertFacts(extractNarrowingFacts(expr.operand, resolveAnn));
  }

  if (expr.kind === "BinaryExpression") {
    const { operator, left, right } = expr;

    if (operator === "&&") {
      // True branch: both sides true
      return [
        ...extractNarrowingFacts(left, resolveAnn),
        ...extractNarrowingFacts(right, resolveAnn),
      ];
    }
    if (operator === "||") {
      // True branch of || is hard; keep empty for true, use invert of both for false via invertFacts
      // For true-facts of `a || b` we cannot simply union. Leave empty.
      return [];
    }

    if (operator === "==" || operator === "!=") {
      const eq = operator === "==";

      // typeof x ==/!= "tag"
      if (
        left.kind === "TypeofExpression" &&
        left.operand.kind === "Identifier" &&
        right.kind === "StringLiteral"
      ) {
        return [{ kind: "typeof", name: left.operand.name, tag: right.value, positive: eq }];
      }
      if (
        right.kind === "TypeofExpression" &&
        right.operand.kind === "Identifier" &&
        left.kind === "StringLiteral"
      ) {
        return [{ kind: "typeof", name: right.operand.name, tag: left.value, positive: eq }];
      }

      // x == null / x != null
      if (left.kind === "Identifier" && right.kind === "NullLiteral") {
        return [{ kind: "nullCheck", name: left.name, isNotNull: !eq }];
      }
      if (right.kind === "Identifier" && left.kind === "NullLiteral") {
        return [{ kind: "nullCheck", name: right.name, isNotNull: !eq }];
      }
    }
  }

  if (expr.kind === "IsExpression" && expr.value.kind === "Identifier" && resolveAnn) {
    const target = resolveAnn(expr.typeAnnotation);
    if (target !== null) {
      return [{ kind: "is", name: expr.value.name, type: target, positive: true }];
    }
  }

  return [];
}

/** False-branch facts: invert true facts, with special handling for || / &&. */
export function extractFalseNarrowingFacts(
  expr: Expression,
  resolveAnn?: TypeAnnResolver,
): NarrowingFact[] {
  if (expr.kind === "BinaryExpression" && expr.operator === "||") {
    // False when both sides false
    return [
      ...extractFalseNarrowingFacts(expr.left, resolveAnn),
      ...extractFalseNarrowingFacts(expr.right, resolveAnn),
    ];
  }
  if (expr.kind === "BinaryExpression" && expr.operator === "&&") {
    // False branch of && is hard; invert combined true facts as approximation
    return invertFacts(extractNarrowingFacts(expr, resolveAnn));
  }
  return invertFacts(extractNarrowingFacts(expr, resolveAnn));
}

export function applyNarrowingFacts<T extends { type: ExtendedValueType; mutable: boolean }>(
  scope: Map<string, T>,
  facts: readonly NarrowingFact[],
): Map<string, T> {
  const next = new Map(scope);
  for (const fact of facts) {
    const binding = next.get(fact.name);
    if (!binding) {
      continue;
    }
    const narrowed = narrowTypeByFact(binding.type, fact);
    next.set(fact.name, { ...binding, type: narrowed });
  }
  return next;
}

/** Mutate scope bindings in place with narrowing facts (for post-if CFA). */
export function mutateScopeWithFacts<T extends { type: ExtendedValueType; mutable: boolean }>(
  scope: Map<string, T>,
  facts: readonly NarrowingFact[],
): void {
  for (const fact of facts) {
    const binding = scope.get(fact.name);
    if (!binding) {
      continue;
    }
    scope.set(fact.name, { ...binding, type: narrowTypeByFact(binding.type, fact) });
  }
}

/** @deprecated Use extractNarrowingFacts */
export interface TypeofNarrowing {
  readonly name: string;
  readonly tag: string;
  readonly positive: boolean;
}

export function extractTypeofNarrowing(expr: Expression): TypeofNarrowing | null {
  const facts = extractNarrowingFacts(expr);
  const f = facts.find((x): x is Extract<NarrowingFact, { kind: "typeof" }> => x.kind === "typeof");
  return f ? { name: f.name, tag: f.tag, positive: f.positive } : null;
}

export function cloneScopeWithNarrowing<T extends { type: ExtendedValueType; mutable: boolean }>(
  scope: Map<string, T>,
  narrowing: TypeofNarrowing | null,
): Map<string, T> {
  if (!narrowing) {
    return new Map(scope);
  }
  return applyNarrowingFacts(scope, [
    { kind: "typeof", name: narrowing.name, tag: narrowing.tag, positive: narrowing.positive },
  ]);
}

export function reportTypeError(
  diagnostics: DiagnosticCollector,
  message: string,
  span: SourceSpan,
  code = "E0390",
): null {
  diagnostics.error(message, span, code);
  return null;
}

/** Resolve indexed access T[K] when K is a string literal. */
export function indexedAccess(
  objectType: ExtendedValueType,
  indexType: ExtendedValueType,
): ExtendedValueType | null {
  if (isObjectType(objectType)) {
    if (isLiteralType(indexType) && indexType.literalKind === "string") {
      const field = objectType.fields.find((f) => f.name === String(indexType.value));
      return field?.type ?? objectType.indexType;
    }
    if (indexType === "string" && objectType.indexType) {
      return objectType.indexType;
    }
  }
  if (isMapType(objectType)) {
    return objectType.valueType;
  }
  return null;
}

export function expandMappedType(
  keys: readonly string[],
  valueForKey: (key: string) => ExtendedValueType | null,
  readonly: boolean,
): ObjectValueType | null {
  const fields: ObjectFieldValue[] = [];
  for (const key of keys) {
    const t = valueForKey(key);
    if (t === null) {
      return null;
    }
    fields.push({ name: key, type: t, readonly });
  }
  return {
    kind: "object",
    name: objectShapeName(fields, null),
    fields,
    indexType: null,
  };
}

export type { TypeAnnotation };
