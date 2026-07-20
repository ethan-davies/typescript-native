import type {
  ArrayType,
  ClassDeclaration,
  ClassField,
  ClassMethod,
  ConstructorDeclaration,
  Expression,
  FunctionDeclaration,
  InterfaceDeclaration,
  InterfaceMethodSignature,
  NamedType,
  Parameter,
  PrimitiveType,
  Statement,
  StructDeclaration,
  StructField,
  StructMethod,
  TypeAnnotation,
  TypeParameter,
} from "../ast/nodes.js";

/** Map from type-parameter name → concrete (or further generic) annotation. */
export type TypeSubst = ReadonlyMap<string, TypeAnnotation>;

export function substituteAnnotation(ann: TypeAnnotation, subst: TypeSubst): TypeAnnotation {
  if (ann.kind === "PrimitiveType") {
    return ann;
  }
  if (ann.kind === "ArrayType") {
    const element = substituteAnnotation(ann.element, subst);
    const result: ArrayType = {
      kind: "ArrayType",
      element,
      span: ann.span,
    };
    return result;
  }
  if (ann.namespace === null && ann.typeArgs.length === 0 && subst.has(ann.name)) {
    return subst.get(ann.name)!;
  }
  if (ann.typeArgs.length === 0) {
    return ann;
  }
  const typeArgs = ann.typeArgs.map((a) => substituteAnnotation(a, subst));
  const result: NamedType = {
    kind: "NamedType",
    namespace: ann.namespace,
    name: ann.name,
    typeArgs,
    span: ann.span,
  };
  return result;
}

export function buildSubst(
  typeParams: readonly TypeParameter[],
  typeArgs: readonly TypeAnnotation[],
): TypeSubst {
  const map = new Map<string, TypeAnnotation>();
  for (let i = 0; i < typeParams.length; i += 1) {
    map.set(typeParams[i]!.name.name, typeArgs[i]!);
  }
  return map;
}

function substParams(params: readonly Parameter[], subst: TypeSubst): Parameter[] {
  return params.map((p) => ({
    ...p,
    typeAnnotation: substituteAnnotation(p.typeAnnotation, subst),
  }));
}

function substExpression(expr: Expression, subst: TypeSubst): Expression {
  switch (expr.kind) {
    case "CallExpression":
      return {
        ...expr,
        typeArgs: expr.typeArgs.map((a) => substituteAnnotation(a, subst)),
        args: expr.args.map((a) => substExpression(a, subst)),
        callee:
          expr.callee.kind === "MemberExpression"
            ? { ...expr.callee, object: substExpression(expr.callee.object, subst) }
            : expr.callee,
      };
    case "NewExpression":
      return {
        ...expr,
        typeArgs: expr.typeArgs.map((a) => substituteAnnotation(a, subst)),
        args: expr.args.map((a) => substExpression(a, subst)),
      };
    case "StructLiteral":
      return {
        ...expr,
        typeArgs: expr.typeArgs.map((a) => substituteAnnotation(a, subst)),
        fields: expr.fields.map((f) => ({
          ...f,
          value: substExpression(f.value, subst),
        })),
      };
    case "BinaryExpression":
      return {
        ...expr,
        left: substExpression(expr.left, subst),
        right: substExpression(expr.right, subst),
      };
    case "UnaryExpression":
      return { ...expr, operand: substExpression(expr.operand, subst) };
    case "IndexExpression":
      return {
        ...expr,
        object: substExpression(expr.object, subst),
        index: substExpression(expr.index, subst),
      };
    case "MemberExpression":
      return { ...expr, object: substExpression(expr.object, subst) };
    case "ArrayLiteral":
      return {
        ...expr,
        elements: expr.elements.map((e) => substExpression(e, subst)),
      };
    default:
      return expr;
  }
}

function substStatement(stmt: Statement, subst: TypeSubst): Statement {
  switch (stmt.kind) {
    case "VariableDeclaration":
      return {
        ...stmt,
        typeAnnotation: stmt.typeAnnotation
          ? substituteAnnotation(stmt.typeAnnotation, subst)
          : null,
        initializer: substExpression(stmt.initializer, subst),
      };
    case "AssignmentStatement":
      return {
        ...stmt,
        target:
          stmt.target.kind === "Identifier"
            ? stmt.target
            : stmt.target.kind === "IndexExpression"
              ? {
                  ...stmt.target,
                  object: substExpression(stmt.target.object, subst),
                  index: substExpression(stmt.target.index, subst),
                }
              : {
                  ...stmt.target,
                  object: substExpression(stmt.target.object, subst),
                },
        value: substExpression(stmt.value, subst),
      };
    case "UpdateStatement":
      return stmt;
    case "ExpressionStatement":
      return { ...stmt, expression: substExpression(stmt.expression, subst) };
    case "ReturnStatement":
      return {
        ...stmt,
        value: stmt.value ? substExpression(stmt.value, subst) : null,
      };
    case "IfStatement":
      return {
        ...stmt,
        condition: substExpression(stmt.condition, subst),
        consequent: stmt.consequent.map((s) => substStatement(s, subst)),
        alternate: Array.isArray(stmt.alternate)
          ? stmt.alternate.map((s) => substStatement(s, subst))
          : stmt.alternate
            ? (substStatement(stmt.alternate, subst) as typeof stmt.alternate)
            : null,
      };
    case "WhileStatement":
      return {
        ...stmt,
        condition: substExpression(stmt.condition, subst),
        body: stmt.body.map((s) => substStatement(s, subst)),
      };
    case "ForStatement":
      return {
        ...stmt,
        initializer: stmt.initializer
          ? (substStatement(stmt.initializer, subst) as typeof stmt.initializer)
          : null,
        condition: stmt.condition ? substExpression(stmt.condition, subst) : null,
        update: stmt.update
          ? stmt.update.kind === "UpdateStatement"
            ? stmt.update
            : (substStatement(stmt.update, subst) as typeof stmt.update)
          : null,
        body: stmt.body.map((s) => substStatement(s, subst)),
      };
    case "ForInStatement":
      return {
        ...stmt,
        iterable: substExpression(stmt.iterable, subst),
        body: stmt.body.map((s) => substStatement(s, subst)),
      };
    case "BreakStatement":
    case "ContinueStatement":
      return stmt;
  }
}

function substStatements(statements: readonly Statement[], subst: TypeSubst): Statement[] {
  return statements.map((s) => substStatement(s, subst));
}

export function specializeStructDecl(
  decl: StructDeclaration,
  instanceLocalName: string,
  subst: TypeSubst,
): StructDeclaration {
  return {
    kind: "StructDeclaration",
    exported: decl.exported,
    name: { kind: "Identifier", name: instanceLocalName, span: decl.name.span },
    typeParams: [],
    fields: decl.fields.map(
      (f): StructField => ({
        ...f,
        typeAnnotation: substituteAnnotation(f.typeAnnotation, subst),
      }),
    ),
    methods: decl.methods.map(
      (m): StructMethod => ({
        ...m,
        typeParams: [],
        params: substParams(m.params, subst),
        returnType: substituteAnnotation(m.returnType, subst),
        body: substStatements(m.body, subst),
      }),
    ),
    span: decl.span,
  };
}

export function specializeFunctionDecl(
  decl: FunctionDeclaration,
  instanceLocalName: string,
  subst: TypeSubst,
): FunctionDeclaration {
  return {
    kind: "FunctionDeclaration",
    exported: decl.exported,
    name: { kind: "Identifier", name: instanceLocalName, span: decl.name.span },
    typeParams: [],
    params: substParams(decl.params, subst),
    returnType: substituteAnnotation(decl.returnType, subst),
    body: substStatements(decl.body, subst),
    span: decl.span,
  };
}

export function specializeClassDecl(
  decl: ClassDeclaration,
  instanceLocalName: string,
  subst: TypeSubst,
): ClassDeclaration {
  return {
    kind: "ClassDeclaration",
    exported: decl.exported,
    isAbstract: decl.isAbstract,
    name: { kind: "Identifier", name: instanceLocalName, span: decl.name.span },
    typeParams: [],
    superclass: decl.superclass
      ? (substituteAnnotation(decl.superclass, subst) as NamedType)
      : null,
    implementsTypes: decl.implementsTypes.map(
      (t) => substituteAnnotation(t, subst) as NamedType,
    ),
    members: decl.members.map((member) => {
      if (member.kind === "ClassField") {
        const field: ClassField = {
          ...member,
          typeAnnotation: substituteAnnotation(member.typeAnnotation, subst),
          initializer: member.initializer
            ? substExpression(member.initializer, subst)
            : null,
        };
        return field;
      }
      if (member.kind === "ConstructorDeclaration") {
        const ctor: ConstructorDeclaration = {
          ...member,
          params: substParams(member.params, subst),
          body: substStatements(member.body, subst),
        };
        return ctor;
      }
      const method: ClassMethod = {
        ...member,
        typeParams: [],
        params: substParams(member.params, subst),
        returnType: substituteAnnotation(member.returnType, subst),
        body: member.body ? substStatements(member.body, subst) : null,
      };
      return method;
    }),
    span: decl.span,
  };
}

export function specializeInterfaceDecl(
  decl: InterfaceDeclaration,
  instanceLocalName: string,
  subst: TypeSubst,
): InterfaceDeclaration {
  return {
    kind: "InterfaceDeclaration",
    exported: decl.exported,
    name: { kind: "Identifier", name: instanceLocalName, span: decl.name.span },
    typeParams: [],
    bases: decl.bases.map((t) => substituteAnnotation(t, subst) as NamedType),
    methods: decl.methods.map(
      (m): InterfaceMethodSignature => ({
        ...m,
        typeParams: [],
        params: substParams(m.params, subst),
        returnType: substituteAnnotation(m.returnType, subst),
      }),
    ),
    span: decl.span,
  };
}

/** Specialize a single class method onto a (possibly already specialized) class name. */
export function specializeClassMethod(
  method: ClassMethod,
  specializedMethodName: string,
  subst: TypeSubst,
): ClassMethod {
  return {
    ...method,
    name: { kind: "Identifier", name: specializedMethodName, span: method.name.span },
    typeParams: [],
    params: substParams(method.params, subst),
    returnType: substituteAnnotation(method.returnType, subst),
    body: method.body ? substStatements(method.body, subst) : null,
  };
}

export function specializeStructMethod(
  method: StructMethod,
  specializedMethodName: string,
  subst: TypeSubst,
): StructMethod {
  return {
    ...method,
    name: { kind: "Identifier", name: specializedMethodName, span: method.name.span },
    typeParams: [],
    params: substParams(method.params, subst),
    returnType: substituteAnnotation(method.returnType, subst),
    body: substStatements(method.body, subst),
  };
}

export function typeParamAnnotation(name: string, span: TypeAnnotation["span"]): NamedType {
  return {
    kind: "NamedType",
    namespace: null,
    name,
    typeArgs: [],
    span,
  };
}

export function primitiveAnnotation(
  name: PrimitiveType["name"],
  span: TypeAnnotation["span"],
): PrimitiveType {
  return { kind: "PrimitiveType", name, span };
}
