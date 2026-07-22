import type {
  ArrayType,
  ClassDeclaration,
  ClassField,
  ClassMethod,
  ConditionalType,
  ConstructorDeclaration,
  Expression,
  FunctionDeclaration,
  FunctionType,
  IndexedAccessType,
  InterfaceDeclaration,
  InterfaceMethodSignature,
  IntersectionType,
  KeyofType,
  MappedType,
  NamedType,
  ObjectType,
  Parameter,
  PrimitiveType,
  Statement,
  StructDeclaration,
  StructField,
  StructMethod,
  TupleType,
  TypeAnnotation,
  TypeParameter,
  TypeofType,
  UnionType,
} from "../ast/nodes.js";

/** Map from type-parameter name → concrete (or further generic) annotation. */
export type TypeSubst = ReadonlyMap<string, TypeAnnotation>;

export function substituteAnnotation(ann: TypeAnnotation, subst: TypeSubst): TypeAnnotation {
  switch (ann.kind) {
    case "PrimitiveType":
    case "LiteralType":
      return ann;
    case "ArrayType": {
      const element = substituteAnnotation(ann.element, subst);
      const result: ArrayType = {
        kind: "ArrayType",
        element,
        span: ann.span,
      };
      return result;
    }
    case "TupleType": {
      const result: TupleType = {
        kind: "TupleType",
        elements: ann.elements.map((e) => substituteAnnotation(e, subst)),
        span: ann.span,
      };
      return result;
    }
    case "NamedType": {
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
    case "UnionType": {
      const result: UnionType = {
        kind: "UnionType",
        types: ann.types.map((t) => substituteAnnotation(t, subst)),
        span: ann.span,
      };
      return result;
    }
    case "IntersectionType": {
      const result: IntersectionType = {
        kind: "IntersectionType",
        types: ann.types.map((t) => substituteAnnotation(t, subst)),
        span: ann.span,
      };
      return result;
    }
    case "ObjectType": {
      const result: ObjectType = {
        kind: "ObjectType",
        fields: ann.fields.map((f) => ({
          ...f,
          typeAnnotation: substituteAnnotation(f.typeAnnotation, subst),
        })),
        indexSignature: ann.indexSignature
          ? {
              ...ann.indexSignature,
              keyType: substituteAnnotation(ann.indexSignature.keyType, subst),
              valueType: substituteAnnotation(ann.indexSignature.valueType, subst),
            }
          : null,
        span: ann.span,
      };
      return result;
    }
    case "KeyofType": {
      const result: KeyofType = {
        kind: "KeyofType",
        type: substituteAnnotation(ann.type, subst),
        span: ann.span,
      };
      return result;
    }
    case "TypeofType": {
      const result: TypeofType = {
        kind: "TypeofType",
        expression: substituteExpression(ann.expression, subst),
        span: ann.span,
      };
      return result;
    }
    case "ConditionalType": {
      const result: ConditionalType = {
        kind: "ConditionalType",
        checkType: substituteAnnotation(ann.checkType, subst),
        extendsType: substituteAnnotation(ann.extendsType, subst),
        trueType: substituteAnnotation(ann.trueType, subst),
        falseType: substituteAnnotation(ann.falseType, subst),
        span: ann.span,
      };
      return result;
    }
    case "MappedType": {
      const result: MappedType = {
        kind: "MappedType",
        readonly: ann.readonly,
        typeParam: ann.typeParam,
        constraint: substituteAnnotation(ann.constraint, subst),
        type: substituteAnnotation(ann.type, subst),
        span: ann.span,
      };
      return result;
    }
    case "IndexedAccessType": {
      const result: IndexedAccessType = {
        kind: "IndexedAccessType",
        objectType: substituteAnnotation(ann.objectType, subst),
        indexType: substituteAnnotation(ann.indexType, subst),
        span: ann.span,
      };
      return result;
    }
    case "FunctionType": {
      const result: FunctionType = {
        kind: "FunctionType",
        params: ann.params.map((p) => substituteAnnotation(p, subst)),
        returnType: substituteAnnotation(ann.returnType, subst),
        span: ann.span,
      };
      return result;
    }
  }
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
    defaultValue: p.defaultValue ? substituteExpression(p.defaultValue, subst) : null,
  }));
}

export function substituteExpression(expr: Expression, subst: TypeSubst): Expression {
  switch (expr.kind) {
    case "CallExpression":
      return {
        ...expr,
        typeArgs: expr.typeArgs.map((a) => substituteAnnotation(a, subst)),
        args: expr.args.map((a) =>
          a.kind === "NamedArgument"
            ? { ...a, value: substituteExpression(a.value, subst) }
            : substituteExpression(a, subst),
        ),
        callee: substituteExpression(expr.callee, subst),
      };
    case "LambdaExpression":
      return {
        ...expr,
        params: expr.params.map((p) => ({
          ...p,
          typeAnnotation: p.typeAnnotation
            ? substituteAnnotation(p.typeAnnotation, subst)
            : null,
        })),
        returnType: expr.returnType ? substituteAnnotation(expr.returnType, subst) : null,
        body:
          expr.body.kind === "expression"
            ? {
                kind: "expression",
                expression: substituteExpression(expr.body.expression, subst),
              }
            : {
                kind: "block",
                statements: expr.body.statements.map((s) => substStatement(s, subst)),
              },
      };
    case "NewExpression":
      return {
        ...expr,
        typeArgs: expr.typeArgs.map((a) => substituteAnnotation(a, subst)),
        args: expr.args.map((a) =>
          a.kind === "NamedArgument"
            ? { ...a, value: substituteExpression(a.value, subst) }
            : substituteExpression(a, subst),
        ),
      };
    case "StructLiteral":
      return {
        ...expr,
        typeArgs: expr.typeArgs.map((a) => substituteAnnotation(a, subst)),
        fields: expr.fields.map((f) => ({
          ...f,
          value: substituteExpression(f.value, subst),
        })),
      };
    case "BinaryExpression":
      return {
        ...expr,
        left: substituteExpression(expr.left, subst),
        right: substituteExpression(expr.right, subst),
      };
    case "UnaryExpression":
      return { ...expr, operand: substituteExpression(expr.operand, subst) };
    case "NonNullExpression":
      return { ...expr, expression: substituteExpression(expr.expression, subst) };
    case "NullCoalescingExpression":
      return {
        ...expr,
        left: substituteExpression(expr.left, subst),
        right: substituteExpression(expr.right, subst),
      };
    case "TypeofExpression":
      return { ...expr, operand: substituteExpression(expr.operand, subst) };
    case "IsExpression":
      return {
        ...expr,
        value: substituteExpression(expr.value, subst),
        typeAnnotation: substituteAnnotation(expr.typeAnnotation, subst),
      };
    case "IndexExpression":
      return {
        ...expr,
        object: substituteExpression(expr.object, subst),
        index: substituteExpression(expr.index, subst),
      };
    case "MemberExpression":
      return { ...expr, object: substituteExpression(expr.object, subst) };
    case "ArrayLiteral":
      return {
        ...expr,
        elements: expr.elements.map((e) => substituteExpression(e, subst)),
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
        initializer: stmt.initializer ? substituteExpression(stmt.initializer, subst) : null,
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
                  object: substituteExpression(stmt.target.object, subst),
                  index: substituteExpression(stmt.target.index, subst),
                }
              : {
                  ...stmt.target,
                  object: substituteExpression(stmt.target.object, subst),
                },
        value: substituteExpression(stmt.value, subst),
      };
    case "UpdateStatement":
      return stmt;
    case "ExpressionStatement":
      return { ...stmt, expression: substituteExpression(stmt.expression, subst) };
    case "ReturnStatement":
      return {
        ...stmt,
        value: stmt.value ? substituteExpression(stmt.value, subst) : null,
      };
    case "IfStatement":
      return {
        ...stmt,
        condition: substituteExpression(stmt.condition, subst),
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
        condition: substituteExpression(stmt.condition, subst),
        body: stmt.body.map((s) => substStatement(s, subst)),
      };
    case "ForStatement":
      return {
        ...stmt,
        initializer: stmt.initializer
          ? (substStatement(stmt.initializer, subst) as typeof stmt.initializer)
          : null,
        condition: stmt.condition ? substituteExpression(stmt.condition, subst) : null,
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
        iterable: substituteExpression(stmt.iterable, subst),
        body: stmt.body.map((s) => substStatement(s, subst)),
      };
    case "SwitchStatement":
      return {
        ...stmt,
        discriminant: substituteExpression(stmt.discriminant, subst),
        cases: stmt.cases.map((switchCase) => ({
          ...switchCase,
          test: switchCase.test ? substituteExpression(switchCase.test, subst) : null,
          body: switchCase.body.map((s) => substStatement(s, subst)),
        })),
      };
    case "BreakStatement":
    case "ContinueStatement":
      return stmt;
    case "ThrowStatement":
      return { ...stmt, expression: substituteExpression(stmt.expression, subst) };
    case "TryStatement":
      return {
        ...stmt,
        tryBlock: stmt.tryBlock.map((s) => substStatement(s, subst)),
        catchClause: stmt.catchClause
          ? {
              ...stmt.catchClause,
              body: stmt.catchClause.body.map((s) => substStatement(s, subst)),
            }
          : null,
        finallyBlock: stmt.finallyBlock
          ? stmt.finallyBlock.map((s) => substStatement(s, subst))
          : null,
      };
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
            ? substituteExpression(member.initializer, subst)
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
    indexSignature: decl.indexSignature
      ? {
          ...decl.indexSignature,
          keyType: substituteAnnotation(decl.indexSignature.keyType, subst),
          valueType: substituteAnnotation(decl.indexSignature.valueType, subst),
        }
      : null,
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
