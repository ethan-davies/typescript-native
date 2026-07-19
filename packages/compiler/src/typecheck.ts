import type {
  Expression,
  FunctionDeclaration,
  PrimitiveTypeName,
  Program,
  Statement,
  StructDeclaration,
  TypeAnnotation,
} from "./ast/nodes.js";
import type { DiagnosticCollector, SourceSpan } from "./diagnostics/diagnostic.js";

export type PrimitiveValueType = Exclude<PrimitiveTypeName, "void">;

export interface ArrayValueType {
  readonly kind: "array";
  readonly element: ValueType;
}

export interface StructValueType {
  readonly kind: "struct";
  readonly name: string;
}

export type ValueType = PrimitiveValueType | ArrayValueType | StructValueType;

export type ReturnType = ValueType | "void";

export interface StructFieldDef {
  readonly name: string;
  readonly type: ValueType;
}

export interface StructDef {
  readonly name: string;
  readonly fields: StructFieldDef[];
  readonly decl: StructDeclaration;
}

interface Binding {
  readonly type: ValueType;
  readonly mutable: boolean;
}

interface FunctionSig {
  readonly name: string;
  readonly params: ValueType[];
  readonly returnType: ReturnType;
  readonly decl: FunctionDeclaration;
}

const NUMERIC_PRIMITIVES = new Set<PrimitiveValueType>(["i32", "i64", "f32", "f64"]);
const EQUALITY_PRIMITIVES = new Set<PrimitiveValueType>(["i32", "i64", "f32", "f64", "bool", "char"]);

/**
 * Type-check a validated program: inference, annotations, arithmetic, calls, returns.
 */
export function typecheck(program: Program, diagnostics: DiagnosticCollector): void {
  const structs = collectStructs(program, diagnostics);
  const functions = new Map<string, FunctionSig>();

  for (const decl of program.body) {
    if (decl.kind !== "FunctionDeclaration") {
      continue;
    }
    const fn = decl;

    if (fn.name.name === "print") {
      diagnostics.error(
        "Cannot redefine builtin function 'print'",
        fn.name.span,
        "E0310",
      );
      continue;
    }

    if (structs.has(fn.name.name)) {
      diagnostics.error(
        `Name '${fn.name.name}' is already used as a struct`,
        fn.name.span,
        "E0330",
      );
      continue;
    }

    if (functions.has(fn.name.name)) {
      diagnostics.error(
        `Duplicate function '${fn.name.name}'`,
        fn.name.span,
        "E0311",
      );
      continue;
    }

    const params: ValueType[] = [];
    let paramsOk = true;
    for (const param of fn.params) {
      const paramType = resolveAnnotation(param.typeAnnotation, structs, diagnostics);
      if (paramType === null) {
        paramsOk = false;
        continue;
      }
      params.push(paramType);
    }

    if (!paramsOk) {
      continue;
    }

    const returnType = resolveReturnType(fn.returnType, structs, diagnostics);
    if (returnType === undefined) {
      continue;
    }

    functions.set(fn.name.name, {
      name: fn.name.name,
      params,
      returnType,
      decl: fn,
    });
  }

  for (const decl of program.body) {
    if (decl.kind === "FunctionDeclaration") {
      checkFunction(decl, functions, structs, diagnostics);
    }
  }
}

function collectStructs(
  program: Program,
  diagnostics: DiagnosticCollector,
): Map<string, StructDef> {
  const structs = new Map<string, StructDef>();
  const declarations: StructDeclaration[] = [];

  for (const decl of program.body) {
    if (decl.kind !== "StructDeclaration") {
      continue;
    }

    if (structs.has(decl.name.name) || declarations.some((d) => d.name.name === decl.name.name)) {
      diagnostics.error(
        `Duplicate struct '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }

    // Placeholder so nested/self references can resolve by name during field typing
    declarations.push(decl);
    structs.set(decl.name.name, {
      name: decl.name.name,
      fields: [],
      decl,
    });
  }

  for (const decl of declarations) {
    const fields: StructFieldDef[] = [];
    const seen = new Set<string>();
    let fieldsOk = true;

    for (const field of decl.fields) {
      if (seen.has(field.name.name)) {
        diagnostics.error(
          `Duplicate field '${field.name.name}' in struct '${decl.name.name}'`,
          field.name.span,
          "E0329",
        );
        fieldsOk = false;
        continue;
      }
      seen.add(field.name.name);

      const fieldType = resolveAnnotation(field.typeAnnotation, structs, diagnostics);
      if (fieldType === null) {
        fieldsOk = false;
        continue;
      }
      fields.push({ name: field.name.name, type: fieldType });
    }

    if (fieldsOk) {
      structs.set(decl.name.name, {
        name: decl.name.name,
        fields,
        decl,
      });
    } else {
      structs.delete(decl.name.name);
    }
  }

  return structs;
}

export function typeToString(type: ValueType | "void"): string {
  if (type === "void") {
    return "void";
  }
  if (typeof type === "string") {
    return type;
  }
  if (type.kind === "struct") {
    return type.name;
  }
  return `${typeToString(type.element)}[]`;
}

export function typesEqual(a: ValueType, b: ValueType): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a === "object" && typeof b === "object") {
    if (a.kind === "array" && b.kind === "array") {
      return typesEqual(a.element, b.element);
    }
    if (a.kind === "struct" && b.kind === "struct") {
      return a.name === b.name;
    }
  }
  return false;
}

export function isArrayType(type: ValueType): type is ArrayValueType {
  return typeof type === "object" && type.kind === "array";
}

export function isStructType(type: ValueType): type is StructValueType {
  return typeof type === "object" && type.kind === "struct";
}

export function isNumericType(type: ValueType): type is PrimitiveValueType {
  return typeof type === "string" && NUMERIC_PRIMITIVES.has(type);
}

export function isIntegerType(type: ValueType): boolean {
  return type === "i32" || type === "i64";
}

/**
 * Convert a type annotation to a value type.
 * Named types become struct types (existence is validated by typecheck via resolveAnnotation).
 */
export function annotationToValueType(ann: TypeAnnotation): ValueType | null {
  if (ann.kind === "PrimitiveType") {
    if (ann.name === "void") {
      return null;
    }
    return ann.name;
  }
  if (ann.kind === "NamedType") {
    return { kind: "struct", name: ann.name };
  }
  const element = annotationToValueType(ann.element);
  if (element === null) {
    return null;
  }
  return { kind: "array", element };
}

function resolveAnnotation(
  ann: TypeAnnotation,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (ann.kind === "PrimitiveType") {
    if (ann.name === "void") {
      diagnostics.error(
        "'void' cannot be used as a value type",
        ann.span,
        "E0302",
      );
      return null;
    }
    return ann.name;
  }
  if (ann.kind === "NamedType") {
    if (!structs.has(ann.name)) {
      diagnostics.error(`Unknown type '${ann.name}'`, ann.span, "E0104");
      return null;
    }
    return { kind: "struct", name: ann.name };
  }
  const element = resolveAnnotation(ann.element, structs, diagnostics);
  if (element === null) {
    return null;
  }
  return { kind: "array", element };
}

function resolveReturnType(
  ann: TypeAnnotation,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
): ReturnType | undefined {
  if (ann.kind === "PrimitiveType" && ann.name === "void") {
    return "void";
  }
  const value = resolveAnnotation(ann, structs, diagnostics);
  if (value === null) {
    return undefined;
  }
  return value;
}

function checkFunction(
  fn: FunctionDeclaration,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
): void {
  const scope = new Map<string, Binding>();
  const returnType =
    fn.returnType.kind === "PrimitiveType" && fn.returnType.name === "void"
      ? ("void" as const)
      : annotationToValueType(fn.returnType);
  if (returnType === null) {
    return;
  }

  for (const param of fn.params) {
    const paramType = annotationToValueType(param.typeAnnotation);
    if (paramType === null) {
      continue;
    }
    if (scope.has(param.name.name)) {
      diagnostics.error(
        `Duplicate parameter '${param.name.name}'`,
        param.name.span,
        "E0301",
      );
      continue;
    }
    scope.set(param.name.name, {
      type: paramType,
      mutable: false,
    });
  }

  for (const stmt of fn.body) {
    checkStatement(stmt, scope, functions, structs, returnType, diagnostics, 0);
  }

  if (returnType !== "void") {
    const last = fn.body[fn.body.length - 1];
    if (!last || last.kind !== "ReturnStatement" || last.value === null) {
      diagnostics.error(
        `Function '${fn.name.name}' must end with a return statement`,
        fn.name.span,
        "E0312",
      );
    }
  }
}

function checkStatement(
  stmt: Statement,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  returnType: ReturnType,
  diagnostics: DiagnosticCollector,
  loopDepth: number,
): void {
  switch (stmt.kind) {
    case "VariableDeclaration": {
      if (scope.has(stmt.name.name)) {
        diagnostics.error(
          `Variable '${stmt.name.name}' is already declared`,
          stmt.name.span,
          "E0301",
        );
        return;
      }

      let annotated: ValueType | null = null;
      if (stmt.typeAnnotation) {
        annotated = resolveAnnotation(stmt.typeAnnotation, structs, diagnostics);
        if (annotated === null) {
          return;
        }
      }

      const inferred = checkExpression(
        stmt.initializer,
        scope,
        functions,
        structs,
        diagnostics,
        false,
        annotated,
      );
      if (!inferred) {
        return;
      }

      let bindingType: ValueType = inferred;
      if (annotated) {
        if (!initializerMatchesAnnotation(stmt.initializer, inferred, annotated)) {
          diagnostics.error(
            typeMismatchMessage(annotated, inferred),
            stmt.initializer.span,
            "E0303",
          );
          return;
        }
        bindingType = annotated;
      }

      scope.set(stmt.name.name, {
        type: bindingType,
        mutable: stmt.mutability === "let",
      });
      return;
    }
    case "AssignmentStatement": {
      checkAssignment(stmt, scope, functions, structs, diagnostics);
      return;
    }
    case "UpdateStatement": {
      const binding = scope.get(stmt.name.name);
      if (!binding) {
        diagnostics.error(`Undefined variable '${stmt.name.name}'`, stmt.name.span, "E0304");
        return;
      }
      if (!binding.mutable) {
        diagnostics.error(
          `Cannot assign to const variable '${stmt.name.name}'`,
          stmt.name.span,
          "E0305",
        );
        return;
      }
      if (!isNumericType(binding.type)) {
        diagnostics.error(
          `Operator '${stmt.operator}' requires a numeric variable, got '${typeToString(binding.type)}'`,
          stmt.name.span,
          "E0306",
        );
      }
      return;
    }
    case "ExpressionStatement": {
      checkExpression(stmt.expression, scope, functions, structs, diagnostics, true);
      return;
    }
    case "ReturnStatement": {
      if (returnType === "void") {
        if (stmt.value !== null) {
          diagnostics.error(
            "Void function cannot return a value",
            stmt.value.span,
            "E0313",
          );
        }
        return;
      }

      if (stmt.value === null) {
        diagnostics.error(
          `Function must return a value of type '${typeToString(returnType)}'`,
          stmt.span,
          "E0314",
        );
        return;
      }

      const valueType = checkExpression(stmt.value, scope, functions, structs, diagnostics);
      if (!valueType) {
        return;
      }
      if (!valueMatchesBinding(stmt.value, valueType, returnType)) {
        diagnostics.error(
          typeMismatchMessage(returnType, valueType),
          stmt.value.span,
          "E0303",
        );
      }
      return;
    }
    case "IfStatement": {
      const condType = checkExpression(stmt.condition, scope, functions, structs, diagnostics);
      if (condType && condType !== "bool") {
        diagnostics.error(
          `If condition must be 'bool', got '${typeToString(condType)}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      for (const s of stmt.consequent) {
        checkStatement(s, scope, functions, structs, returnType, diagnostics, loopDepth);
      }
      if (stmt.alternate === null) {
        return;
      }
      if (Array.isArray(stmt.alternate)) {
        for (const s of stmt.alternate) {
          checkStatement(s, scope, functions, structs, returnType, diagnostics, loopDepth);
        }
      } else {
        checkStatement(stmt.alternate, scope, functions, structs, returnType, diagnostics, loopDepth);
      }
      return;
    }
    case "WhileStatement": {
      const condType = checkExpression(stmt.condition, scope, functions, structs, diagnostics);
      if (condType && condType !== "bool") {
        diagnostics.error(
          `While condition must be 'bool', got '${typeToString(condType)}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      for (const s of stmt.body) {
        checkStatement(s, scope, functions, structs, returnType, diagnostics, loopDepth + 1);
      }
      return;
    }
    case "ForStatement": {
      if (stmt.initializer) {
        checkStatement(stmt.initializer, scope, functions, structs, returnType, diagnostics, loopDepth);
      }
      if (stmt.condition) {
        const condType = checkExpression(stmt.condition, scope, functions, structs, diagnostics);
        if (condType && condType !== "bool") {
          diagnostics.error(
            `For condition must be 'bool', got '${typeToString(condType)}'`,
            stmt.condition.span,
            "E0316",
          );
        }
      }
      if (stmt.update) {
        checkStatement(stmt.update, scope, functions, structs, returnType, diagnostics, loopDepth);
      }
      for (const s of stmt.body) {
        checkStatement(s, scope, functions, structs, returnType, diagnostics, loopDepth + 1);
      }
      return;
    }
    case "ForInStatement": {
      const iterableType = checkExpression(stmt.iterable, scope, functions, structs, diagnostics);
      if (!iterableType) {
        return;
      }
      if (!isArrayType(iterableType)) {
        diagnostics.error(
          `For-in iterable must be an array, got '${typeToString(iterableType)}'`,
          stmt.iterable.span,
          "E0318",
        );
        return;
      }

      if (scope.has(stmt.name.name)) {
        diagnostics.error(
          `Variable '${stmt.name.name}' is already declared`,
          stmt.name.span,
          "E0301",
        );
        return;
      }

      // Bare / const → immutable loop var; let → mutable
      const mutable = stmt.mutability === "let";
      scope.set(stmt.name.name, {
        type: iterableType.element,
        mutable,
      });

      for (const s of stmt.body) {
        checkStatement(s, scope, functions, structs, returnType, diagnostics, loopDepth + 1);
      }

      scope.delete(stmt.name.name);
      return;
    }
    case "BreakStatement": {
      if (loopDepth === 0) {
        diagnostics.error("'break' used outside of a loop", stmt.span, "E0317");
      }
      return;
    }
    case "ContinueStatement": {
      if (loopDepth === 0) {
        diagnostics.error("'continue' used outside of a loop", stmt.span, "E0317");
      }
      return;
    }
  }
}

function checkAssignment(
  stmt: Extract<Statement, { kind: "AssignmentStatement" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
): void {
  if (stmt.target.kind === "Identifier") {
    const binding = scope.get(stmt.target.name);
    if (!binding) {
      diagnostics.error(`Undefined variable '${stmt.target.name}'`, stmt.target.span, "E0304");
      return;
    }
    if (!binding.mutable) {
      diagnostics.error(
        `Cannot assign to const variable '${stmt.target.name}'`,
        stmt.target.span,
        "E0305",
      );
      return;
    }

    if (stmt.operator === "+=" || stmt.operator === "-=") {
      if (!isNumericType(binding.type)) {
        diagnostics.error(
          `Operator '${stmt.operator}' requires a numeric variable, got '${typeToString(binding.type)}'`,
          stmt.target.span,
          "E0306",
        );
        return;
      }
    }

    const valueType = checkExpression(stmt.value, scope, functions, structs, diagnostics);
    if (!valueType) {
      return;
    }
    if (!valueMatchesBinding(stmt.value, valueType, binding.type)) {
      diagnostics.error(
        typeMismatchMessage(binding.type, valueType),
        stmt.value.span,
        "E0303",
      );
    }
    return;
  }

  if (stmt.target.kind === "MemberExpression") {
    const fieldType = checkMemberLvalue(stmt.target, scope, functions, structs, diagnostics);
    if (!fieldType) {
      return;
    }

    if (stmt.operator === "+=" || stmt.operator === "-=") {
      if (!isNumericType(fieldType)) {
        diagnostics.error(
          `Operator '${stmt.operator}' requires a numeric field, got '${typeToString(fieldType)}'`,
          stmt.target.span,
          "E0306",
        );
        return;
      }
    }

    const valueType = checkExpression(stmt.value, scope, functions, structs, diagnostics);
    if (!valueType) {
      return;
    }
    if (!valueMatchesBinding(stmt.value, valueType, fieldType)) {
      diagnostics.error(
        typeMismatchMessage(fieldType, valueType),
        stmt.value.span,
        "E0303",
      );
    }
    return;
  }

  // Index assignment: arr[i] = value — allowed even if arr is const
  const objectType = checkExpression(stmt.target.object, scope, functions, structs, diagnostics);
  const indexType = checkExpression(stmt.target.index, scope, functions, structs, diagnostics);
  if (!objectType || !indexType) {
    return;
  }
  if (!isArrayType(objectType)) {
    diagnostics.error(
      `Cannot index into type '${typeToString(objectType)}'`,
      stmt.target.object.span,
      "E0319",
    );
    return;
  }
  if (!isIntegerType(indexType)) {
    diagnostics.error(
      `Array index must be an integer, got '${typeToString(indexType)}'`,
      stmt.target.index.span,
      "E0320",
    );
    return;
  }

  const elementType = objectType.element;
  if (stmt.operator === "+=" || stmt.operator === "-=") {
    if (!isNumericType(elementType)) {
      diagnostics.error(
        `Operator '${stmt.operator}' requires a numeric element, got '${typeToString(elementType)}'`,
        stmt.target.span,
        "E0306",
      );
      return;
    }
  }

  const valueType = checkExpression(stmt.value, scope, functions, structs, diagnostics);
  if (!valueType) {
    return;
  }
  if (!valueMatchesBinding(stmt.value, valueType, elementType)) {
    diagnostics.error(
      typeMismatchMessage(elementType, valueType),
      stmt.value.span,
      "E0303",
    );
  }
}

/** Resolve the field type of a member lvalue (allows const struct field mutation). */
function checkMemberLvalue(
  expr: Extract<Expression, { kind: "MemberExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  const objectType = checkExpression(expr.object, scope, functions, structs, diagnostics);
  if (!objectType) {
    return null;
  }
  if (!isStructType(objectType)) {
    diagnostics.error(
      `Cannot assign to field of type '${typeToString(objectType)}'`,
      expr.object.span,
      "E0331",
    );
    return null;
  }
  const def = structs.get(objectType.name);
  if (!def) {
    diagnostics.error(`Unknown struct '${objectType.name}'`, expr.object.span, "E0104");
    return null;
  }
  const field = def.fields.find((f) => f.name === expr.property.name);
  if (!field) {
    diagnostics.error(
      `Unknown field '${expr.property.name}' on struct '${objectType.name}'`,
      expr.property.span,
      "E0324",
    );
    return null;
  }
  return field.type;
}

function checkExpression(
  expr: Expression,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall = false,
  expectedType: ValueType | null = null,
): ValueType | null {
  switch (expr.kind) {
    case "IntegerLiteral":
      return "i32";
    case "FloatLiteral":
      return "f64";
    case "BooleanLiteral":
      return "bool";
    case "StringLiteral":
      return "string";
    case "CharLiteral":
      return "char";
    case "StructLiteral": {
      const def = structs.get(expr.name.name);
      if (!def) {
        diagnostics.error(`Unknown struct '${expr.name.name}'`, expr.name.span, "E0104");
        return null;
      }

      const seen = new Set<string>();
      for (const init of expr.fields) {
        if (seen.has(init.name.name)) {
          diagnostics.error(
            `Duplicate field '${init.name.name}' in struct literal`,
            init.name.span,
            "E0329",
          );
          return null;
        }
        seen.add(init.name.name);

        const field = def.fields.find((f) => f.name === init.name.name);
        if (!field) {
          diagnostics.error(
            `Unknown field '${init.name.name}' on struct '${def.name}'`,
            init.name.span,
            "E0324",
          );
          return null;
        }

        const valueType = checkExpression(
          init.value,
          scope,
          functions,
          structs,
          diagnostics,
          false,
          field.type,
        );
        if (!valueType) {
          return null;
        }
        if (!valueMatchesBinding(init.value, valueType, field.type)) {
          diagnostics.error(
            typeMismatchMessage(field.type, valueType),
            init.value.span,
            "E0303",
          );
          return null;
        }
      }

      for (const field of def.fields) {
        if (!seen.has(field.name)) {
          diagnostics.error(
            `Missing field '${field.name}' in struct literal for '${def.name}'`,
            expr.span,
            "E0332",
          );
          return null;
        }
      }

      return { kind: "struct", name: def.name };
    }
    case "ArrayLiteral": {
      if (expr.elements.length === 0) {
        if (expectedType && isArrayType(expectedType)) {
          return expectedType;
        }
        diagnostics.error(
          "Empty array literal requires a type annotation",
          expr.span,
          "E0321",
        );
        return null;
      }

      let elementType: ValueType | null = null;
      const expectedElement =
        expectedType && isArrayType(expectedType) ? expectedType.element : null;

      for (const element of expr.elements) {
        const t = checkExpression(element, scope, functions, structs, diagnostics, false, expectedElement);
        if (!t) {
          return null;
        }
        if (elementType === null) {
          elementType = expectedElement ?? t;
          if (expectedElement && !valueMatchesBinding(element, t, expectedElement)) {
            diagnostics.error(
              typeMismatchMessage(expectedElement, t),
              element.span,
              "E0303",
            );
            return null;
          }
          continue;
        }
        if (!valueMatchesBinding(element, t, elementType) && !typesEqual(t, elementType)) {
          if (
            !(
              element.kind === "IntegerLiteral" &&
              isIntegerType(elementType) &&
              isIntegerType(t)
            ) &&
            !(
              element.kind === "FloatLiteral" &&
              (elementType === "f32" || elementType === "f64") &&
              (t === "f32" || t === "f64")
            )
          ) {
            diagnostics.error(
              `Array elements must have the same type; expected '${typeToString(elementType)}', got '${typeToString(t)}'`,
              element.span,
              "E0322",
            );
            return null;
          }
        }
      }

      return { kind: "array", element: elementType! };
    }
    case "IndexExpression": {
      const objectType = checkExpression(expr.object, scope, functions, structs, diagnostics);
      const indexType = checkExpression(expr.index, scope, functions, structs, diagnostics);
      if (!objectType || !indexType) {
        return null;
      }
      if (!isArrayType(objectType)) {
        diagnostics.error(
          `Cannot index into type '${typeToString(objectType)}'`,
          expr.object.span,
          "E0319",
        );
        return null;
      }
      if (!isIntegerType(indexType)) {
        diagnostics.error(
          `Array index must be an integer, got '${typeToString(indexType)}'`,
          expr.index.span,
          "E0320",
        );
        return null;
      }
      return objectType.element;
    }
    case "MemberExpression": {
      const objectType = checkExpression(expr.object, scope, functions, structs, diagnostics);
      if (!objectType) {
        return null;
      }
      if (isStructType(objectType)) {
        const def = structs.get(objectType.name);
        if (!def) {
          diagnostics.error(`Unknown struct '${objectType.name}'`, expr.object.span, "E0104");
          return null;
        }
        const field = def.fields.find((f) => f.name === expr.property.name);
        if (!field) {
          diagnostics.error(
            `Unknown field '${expr.property.name}' on struct '${objectType.name}'`,
            expr.property.span,
            "E0324",
          );
          return null;
        }
        return field.type;
      }
      if (expr.property.name === "length") {
        if (!isArrayType(objectType)) {
          diagnostics.error(
            `Property 'length' is only available on arrays, got '${typeToString(objectType)}'`,
            expr.span,
            "E0323",
          );
          return null;
        }
        return "i32";
      }
      diagnostics.error(
        `Unknown property '${expr.property.name}'`,
        expr.property.span,
        "E0324",
      );
      return null;
    }
    case "Identifier": {
      const binding = scope.get(expr.name);
      if (!binding) {
        diagnostics.error(`Undefined variable '${expr.name}'`, expr.span, "E0304");
        return null;
      }
      return binding.type;
    }
    case "UnaryExpression": {
      const operand = checkExpression(expr.operand, scope, functions, structs, diagnostics);
      if (!operand) {
        return null;
      }
      if (expr.operator === "!") {
        if (operand !== "bool") {
          diagnostics.error(
            `Operator '!' requires a bool operand, got '${typeToString(operand)}'`,
            expr.span,
            "E0306",
          );
          return null;
        }
        return "bool";
      }
      if (!isNumericType(operand)) {
        diagnostics.error(
          `Operator '-' requires a numeric operand, got '${typeToString(operand)}'`,
          expr.span,
          "E0306",
        );
        return null;
      }
      return operand;
    }
    case "BinaryExpression": {
      const left = checkExpression(expr.left, scope, functions, structs, diagnostics);
      const right = checkExpression(expr.right, scope, functions, structs, diagnostics);
      if (!left || !right) {
        return null;
      }

      if (expr.operator === "&&" || expr.operator === "||") {
        if (left !== "bool" || right !== "bool") {
          diagnostics.error(
            `Operator '${expr.operator}' requires two bool operands, got '${typeToString(left)}' and '${typeToString(right)}'`,
            expr.span,
            "E0306",
          );
          return null;
        }
        return "bool";
      }

      if (
        expr.operator === "==" ||
        expr.operator === "!=" ||
        expr.operator === "<" ||
        expr.operator === "<=" ||
        expr.operator === ">" ||
        expr.operator === ">="
      ) {
        return checkComparison(expr.operator, left, right, expr.span, diagnostics);
      }

      if (expr.operator === "+") {
        if (left === "string" && right === "string") {
          return "string";
        }
        if (isNumericType(left) && typesEqual(left, right)) {
          return left;
        }
        diagnostics.error(
          `Operator '+' requires two string or two matching numeric operands, got '${typeToString(left)}' and '${typeToString(right)}'`,
          expr.span,
          "E0306",
        );
        return null;
      }

      if (!isNumericType(left) || !typesEqual(left, right)) {
        diagnostics.error(
          `Operator '${expr.operator}' requires two matching numeric operands, got '${typeToString(left)}' and '${typeToString(right)}'`,
          expr.span,
          "E0306",
        );
        return null;
      }
      return left;
    }
    case "CallExpression": {
      if (expr.callee.kind === "MemberExpression") {
        return checkMethodCall(expr, scope, functions, structs, diagnostics, allowVoidCall);
      }

      if (expr.callee.name === "print") {
        if (!allowVoidCall) {
          diagnostics.error("'print' cannot be used as a value", expr.span, "E0309");
          return null;
        }
        if (expr.args.length === 0) {
          diagnostics.error("'print' requires at least one argument", expr.span, "E0308");
          return null;
        }
        for (const arg of expr.args) {
          const argType = checkExpression(arg, scope, functions, structs, diagnostics);
          if (!argType) {
            return null;
          }
          if (isStructType(argType)) {
            diagnostics.error(
              `Cannot print struct value of type '${typeToString(argType)}'; print individual fields instead`,
              arg.span,
              "E0333",
            );
            return null;
          }
        }
        return null;
      }

      const sig = functions.get(expr.callee.name);
      if (!sig) {
        diagnostics.error(
          `Unknown function '${expr.callee.name}'`,
          expr.callee.span,
          "E0307",
        );
        return null;
      }

      if (expr.args.length !== sig.params.length) {
        diagnostics.error(
          `Function '${sig.name}' expects ${sig.params.length} argument(s), got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }

      for (let i = 0; i < expr.args.length; i += 1) {
        const arg = expr.args[i]!;
        const expected = sig.params[i]!;
        const argType = checkExpression(arg, scope, functions, structs, diagnostics);
        if (!argType) {
          return null;
        }
        if (!valueMatchesBinding(arg, argType, expected)) {
          diagnostics.error(
            typeMismatchMessage(expected, argType),
            arg.span,
            "E0303",
          );
          return null;
        }
      }

      if (sig.returnType === "void") {
        if (!allowVoidCall) {
          diagnostics.error(
            `Void function '${sig.name}' cannot be used as a value`,
            expr.span,
            "E0309",
          );
        }
        return null;
      }

      return sig.returnType;
    }
  }
}

function checkMethodCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null {
  if (expr.callee.kind !== "MemberExpression") {
    return null;
  }

  const objectType = checkExpression(expr.callee.object, scope, functions, structs, diagnostics);
  if (!objectType) {
    return null;
  }
  if (!isArrayType(objectType)) {
    diagnostics.error(
      `Methods are only available on arrays, got '${typeToString(objectType)}'`,
      expr.callee.object.span,
      "E0326",
    );
    return null;
  }

  const method = expr.callee.property.name;
  const elementType = objectType.element;

  switch (method) {
    case "push": {
      if (expr.args.length !== 1) {
        diagnostics.error(
          `Method 'push' expects 1 argument, got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }
      const arg = expr.args[0]!;
      const argType = checkExpression(arg, scope, functions, structs, diagnostics);
      if (!argType) {
        return null;
      }
      if (!valueMatchesBinding(arg, argType, elementType)) {
        diagnostics.error(typeMismatchMessage(elementType, argType), arg.span, "E0303");
        return null;
      }
      if (!allowVoidCall) {
        diagnostics.error("'push' cannot be used as a value", expr.span, "E0309");
      }
      return null;
    }
    case "pop": {
      if (expr.args.length !== 0) {
        diagnostics.error(
          `Method 'pop' expects 0 arguments, got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }
      return elementType;
    }
    case "includes": {
      if (expr.args.length !== 1) {
        diagnostics.error(
          `Method 'includes' expects 1 argument, got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }
      if (!supportsEquality(elementType)) {
        diagnostics.error(
          `Method 'includes' is not supported for element type '${typeToString(elementType)}'`,
          expr.span,
          "E0327",
        );
        return null;
      }
      const arg = expr.args[0]!;
      const argType = checkExpression(arg, scope, functions, structs, diagnostics);
      if (!argType) {
        return null;
      }
      if (!valueMatchesBinding(arg, argType, elementType)) {
        diagnostics.error(typeMismatchMessage(elementType, argType), arg.span, "E0303");
        return null;
      }
      return "bool";
    }
    case "indexOf": {
      if (expr.args.length !== 1) {
        diagnostics.error(
          `Method 'indexOf' expects 1 argument, got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }
      if (!supportsEquality(elementType)) {
        diagnostics.error(
          `Method 'indexOf' is not supported for element type '${typeToString(elementType)}'`,
          expr.span,
          "E0327",
        );
        return null;
      }
      const arg = expr.args[0]!;
      const argType = checkExpression(arg, scope, functions, structs, diagnostics);
      if (!argType) {
        return null;
      }
      if (!valueMatchesBinding(arg, argType, elementType)) {
        diagnostics.error(typeMismatchMessage(elementType, argType), arg.span, "E0303");
        return null;
      }
      return "i32";
    }
    default:
      diagnostics.error(`Unknown method '${method}'`, expr.callee.property.span, "E0324");
      return null;
  }
}

function supportsEquality(type: ValueType): boolean {
  return typeof type === "string" && EQUALITY_PRIMITIVES.has(type);
}

function typeMismatchMessage(expected: ValueType | PrimitiveTypeName, got: ValueType | PrimitiveTypeName): string {
  return `Expected ${typeToString(expected as ValueType)}, got ${typeToString(got as ValueType)}`;
}

/** Integer/float literals may be annotated as any integer/float width. */
function initializerMatchesAnnotation(
  initializer: Expression,
  inferred: ValueType,
  annotated: ValueType,
): boolean {
  return valueMatchesBinding(initializer, inferred, annotated);
}

function checkComparison(
  operator: "==" | "!=" | "<" | "<=" | ">" | ">=",
  left: ValueType,
  right: ValueType,
  span: SourceSpan,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (!typesEqual(left, right)) {
    diagnostics.error(
      `Operator '${operator}' requires matching operand types, got '${typeToString(left)}' and '${typeToString(right)}'`,
      span,
      "E0306",
    );
    return null;
  }

  const isEquality = operator === "==" || operator === "!=";
  if (isEquality) {
    if (supportsEquality(left)) {
      return "bool";
    }
    diagnostics.error(
      `Operator '${operator}' is not supported for type '${typeToString(left)}'`,
      span,
      "E0306",
    );
    return null;
  }

  if (!isNumericType(left)) {
    diagnostics.error(
      `Operator '${operator}' requires two matching numeric operands, got '${typeToString(left)}' and '${typeToString(right)}'`,
      span,
      "E0306",
    );
    return null;
  }
  return "bool";
}

function valueMatchesBinding(
  value: Expression,
  inferred: ValueType,
  expected: ValueType,
): boolean {
  if (typesEqual(inferred, expected)) {
    return true;
  }
  // Array literal width coercion for elements is handled per-element; here for whole value:
  if (value.kind === "IntegerLiteral" && (expected === "i32" || expected === "i64")) {
    return true;
  }
  if (value.kind === "FloatLiteral" && (expected === "f32" || expected === "f64")) {
    return true;
  }
  // Array of int lits into i64[] etc.
  if (
    value.kind === "ArrayLiteral" &&
    isArrayType(inferred) &&
    isArrayType(expected)
  ) {
    if (value.elements.length === 0) {
      return true;
    }
    return value.elements.every((el) => {
      const elInferred =
        el.kind === "IntegerLiteral"
          ? ("i32" as const)
          : el.kind === "FloatLiteral"
            ? ("f64" as const)
            : null;
      if (elInferred === null) {
        // fall back: require exact match of array element types already checked
        return typesEqual(inferred.element, expected.element);
      }
      return valueMatchesBinding(el, elInferred, expected.element);
    });
  }
  return false;
}
