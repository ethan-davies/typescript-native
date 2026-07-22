import type {
  ClassDeclaration,
  ClassMethod,
  Expression,
  FunctionDeclaration,
  NamedType,
  Program,
  Statement,
  StructDeclaration,
  StructMethod,
  TopLevelDeclaration,
  TypeAnnotation,
} from "../ast/nodes.js";
import type { ResolvedModule } from "../modules/resolve.js";
import {
  buildSubst,
  specializeClassDecl,
  specializeClassMethod,
  specializeFunctionDecl,
  specializeInterfaceDecl,
  specializeStructDecl,
  specializeStructMethod,
} from "./substitute.js";

export interface InstantiationRecord {
  readonly kind: "struct" | "class" | "interface" | "function" | "classMethod" | "structMethod";
  /** Specialized type/function local name, or specialized method name. */
  readonly instanceLocalName: string;
  readonly moduleId: string;
  readonly modulePath: string;
  readonly templateLocalName: string;
  readonly typeArgs: TypeAnnotation[];
  /** For methods: owning type's local name after class specialization (or original). */
  readonly ownerInstanceLocalName?: string;
  /** For methods: original method name on the template. */
  readonly methodTemplateName?: string;
  /** For methods: type args applied to the owner type (empty if owner non-generic). */
  readonly ownerTypeArgs?: TypeAnnotation[];
  /** For methods: method-level type args. */
  readonly methodTypeArgs?: TypeAnnotation[];
}

/** Collected during typecheck; consumed by monomorphize. */
export interface LambdaCaptureRecord {
  readonly name: string;
  readonly mutable: boolean;
}

export interface TypecheckInstantiations {
  readonly records: InstantiationRecord[];
  /** span.start.offset → specialized function local name */
  readonly callRewrites: ReadonlyMap<number, string>;
  /** span.start.offset → specialized method local name (property name) */
  readonly methodCallRewrites: ReadonlyMap<number, string>;
  /** span.start.offset → mangled LLVM name for extension method calls */
  readonly extensionCallRewrites: ReadonlyMap<number, string>;
  readonly newRewrites: ReadonlyMap<number, string>;
  readonly structLiteralRewrites: ReadonlyMap<number, string>;
  readonly typeRewrites: ReadonlyMap<number, string>;
  /** LambdaExpression span.start.offset → captured outer bindings */
  readonly lambdaCaptures: ReadonlyMap<number, readonly LambdaCaptureRecord[]>;
}

function rewriteType(
  ann: TypeAnnotation,
  typeRewrites: ReadonlyMap<number, string>,
): TypeAnnotation {
  switch (ann.kind) {
    case "PrimitiveType":
    case "LiteralType":
      return ann;
    case "ArrayType":
      return {
        kind: "ArrayType",
        element: rewriteType(ann.element, typeRewrites),
        span: ann.span,
      };
    case "TupleType":
      return {
        kind: "TupleType",
        elements: ann.elements.map((e) => rewriteType(e, typeRewrites)),
        span: ann.span,
      };
    case "NamedType": {
      const rewritten = typeRewrites.get(ann.span.start.offset);
      if (rewritten) {
        return {
          kind: "NamedType",
          namespace: null,
          name: rewritten,
          typeArgs: [],
          span: ann.span,
        };
      }
      if (ann.typeArgs.length === 0) {
        return ann;
      }
      return {
        kind: "NamedType",
        namespace: ann.namespace,
        name: ann.name,
        typeArgs: [],
        span: ann.span,
      };
    }
    case "UnionType":
      return {
        kind: "UnionType",
        types: ann.types.map((t) => rewriteType(t, typeRewrites)),
        span: ann.span,
      };
    case "IntersectionType":
      return {
        kind: "IntersectionType",
        types: ann.types.map((t) => rewriteType(t, typeRewrites)),
        span: ann.span,
      };
    case "ObjectType":
      return {
        kind: "ObjectType",
        fields: ann.fields.map((f) => ({
          ...f,
          typeAnnotation: rewriteType(f.typeAnnotation, typeRewrites),
        })),
        indexSignature: ann.indexSignature
          ? {
              ...ann.indexSignature,
              keyType: rewriteType(ann.indexSignature.keyType, typeRewrites),
              valueType: rewriteType(ann.indexSignature.valueType, typeRewrites),
            }
          : null,
        span: ann.span,
      };
    case "KeyofType":
      return {
        kind: "KeyofType",
        type: rewriteType(ann.type, typeRewrites),
        span: ann.span,
      };
    case "TypeofType":
      return ann;
    case "ConditionalType":
      return {
        kind: "ConditionalType",
        checkType: rewriteType(ann.checkType, typeRewrites),
        extendsType: rewriteType(ann.extendsType, typeRewrites),
        trueType: rewriteType(ann.trueType, typeRewrites),
        falseType: rewriteType(ann.falseType, typeRewrites),
        span: ann.span,
      };
    case "MappedType":
      return {
        kind: "MappedType",
        readonly: ann.readonly,
        typeParam: ann.typeParam,
        constraint: rewriteType(ann.constraint, typeRewrites),
        type: rewriteType(ann.type, typeRewrites),
        span: ann.span,
      };
    case "IndexedAccessType":
      return {
        kind: "IndexedAccessType",
        objectType: rewriteType(ann.objectType, typeRewrites),
        indexType: rewriteType(ann.indexType, typeRewrites),
        span: ann.span,
      };
    case "FunctionType":
      return {
        kind: "FunctionType",
        params: ann.params.map((p) => rewriteType(p, typeRewrites)),
        returnType: rewriteType(ann.returnType, typeRewrites),
        span: ann.span,
      };
  }
}

function rewriteExpression(expr: Expression, inst: TypecheckInstantiations): Expression {
  switch (expr.kind) {
    case "CallExpression": {
      const fnRewrite = inst.callRewrites.get(expr.span.start.offset);
      const methodRewrite = inst.methodCallRewrites.get(expr.span.start.offset);
      let callee = rewriteExpression(expr.callee, inst);
      if (fnRewrite && callee.kind === "Identifier") {
        callee = { ...callee, name: fnRewrite };
      } else if (methodRewrite && callee.kind === "MemberExpression") {
        callee = {
          ...callee,
          property: { ...callee.property, name: methodRewrite },
        };
      }
      return {
        ...expr,
        callee,
        typeArgs: [],
        args: expr.args.map((a) =>
          a.kind === "NamedArgument"
            ? { ...a, value: rewriteExpression(a.value, inst) }
            : rewriteExpression(a, inst),
        ),
      };
    }
    case "LambdaExpression":
      return {
        ...expr,
        params: expr.params.map((p) => ({
          ...p,
          typeAnnotation: p.typeAnnotation
            ? rewriteType(p.typeAnnotation, inst.typeRewrites)
            : null,
        })),
        returnType: expr.returnType
          ? rewriteType(expr.returnType, inst.typeRewrites)
          : null,
        body:
          expr.body.kind === "expression"
            ? {
                kind: "expression",
                expression: rewriteExpression(expr.body.expression, inst),
              }
            : {
                kind: "block",
                statements: expr.body.statements.map((s) => rewriteStatement(s, inst)),
              },
      };
    case "NewExpression": {
      const rewrite = inst.newRewrites.get(expr.span.start.offset);
      return {
        ...expr,
        className: rewrite ? { ...expr.className, name: rewrite } : expr.className,
        typeArgs: [],
        args: expr.args.map((a) =>
          a.kind === "NamedArgument"
            ? { ...a, value: rewriteExpression(a.value, inst) }
            : rewriteExpression(a, inst),
        ),
      };
    }
    case "StructLiteral": {
      const rewrite = inst.structLiteralRewrites.get(expr.span.start.offset);
      return {
        ...expr,
        name: rewrite ? { ...expr.name, name: rewrite } : expr.name,
        typeArgs: [],
        fields: expr.fields.map((f) => ({
          ...f,
          value: rewriteExpression(f.value, inst),
        })),
      };
    }
    case "BinaryExpression":
      return {
        ...expr,
        left: rewriteExpression(expr.left, inst),
        right: rewriteExpression(expr.right, inst),
      };
    case "UnaryExpression":
      return { ...expr, operand: rewriteExpression(expr.operand, inst) };
    case "NonNullExpression":
      return { ...expr, expression: rewriteExpression(expr.expression, inst) };
    case "NullCoalescingExpression":
      return {
        ...expr,
        left: rewriteExpression(expr.left, inst),
        right: rewriteExpression(expr.right, inst),
      };
    case "TypeofExpression":
      return { ...expr, operand: rewriteExpression(expr.operand, inst) };
    case "IsExpression":
      return {
        ...expr,
        value: rewriteExpression(expr.value, inst),
        typeAnnotation: rewriteType(expr.typeAnnotation, inst.typeRewrites),
      };
    case "IndexExpression":
      return {
        ...expr,
        object: rewriteExpression(expr.object, inst),
        index: rewriteExpression(expr.index, inst),
      };
    case "MemberExpression":
      return { ...expr, object: rewriteExpression(expr.object, inst) };
    case "ArrayLiteral":
      return {
        ...expr,
        elements: expr.elements.map((e) => rewriteExpression(e, inst)),
      };
    default:
      return expr;
  }
}

function rewriteStatement(stmt: Statement, inst: TypecheckInstantiations): Statement {
  switch (stmt.kind) {
    case "VariableDeclaration":
      return {
        ...stmt,
        typeAnnotation: stmt.typeAnnotation
          ? rewriteType(stmt.typeAnnotation, inst.typeRewrites)
          : null,
        initializer: stmt.initializer ? rewriteExpression(stmt.initializer, inst) : null,
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
                  object: rewriteExpression(stmt.target.object, inst),
                  index: rewriteExpression(stmt.target.index, inst),
                }
              : {
                  ...stmt.target,
                  object: rewriteExpression(stmt.target.object, inst),
                },
        value: rewriteExpression(stmt.value, inst),
      };
    case "UpdateStatement":
      return stmt;
    case "ExpressionStatement":
      return { ...stmt, expression: rewriteExpression(stmt.expression, inst) };
    case "ReturnStatement":
      return {
        ...stmt,
        value: stmt.value ? rewriteExpression(stmt.value, inst) : null,
      };
    case "IfStatement":
      return {
        ...stmt,
        condition: rewriteExpression(stmt.condition, inst),
        consequent: stmt.consequent.map((s) => rewriteStatement(s, inst)),
        alternate: Array.isArray(stmt.alternate)
          ? stmt.alternate.map((s) => rewriteStatement(s, inst))
          : stmt.alternate
            ? (rewriteStatement(stmt.alternate, inst) as typeof stmt.alternate)
            : null,
      };
    case "WhileStatement":
      return {
        ...stmt,
        condition: rewriteExpression(stmt.condition, inst),
        body: stmt.body.map((s) => rewriteStatement(s, inst)),
      };
    case "ForStatement":
      return {
        ...stmt,
        initializer: stmt.initializer
          ? (rewriteStatement(stmt.initializer, inst) as typeof stmt.initializer)
          : null,
        condition: stmt.condition ? rewriteExpression(stmt.condition, inst) : null,
        update: stmt.update
          ? stmt.update.kind === "UpdateStatement"
            ? stmt.update
            : (rewriteStatement(stmt.update, inst) as typeof stmt.update)
          : null,
        body: stmt.body.map((s) => rewriteStatement(s, inst)),
      };
    case "ForInStatement":
      return {
        ...stmt,
        iterable: rewriteExpression(stmt.iterable, inst),
        body: stmt.body.map((s) => rewriteStatement(s, inst)),
      };
    case "SwitchStatement":
      return {
        ...stmt,
        discriminant: rewriteExpression(stmt.discriminant, inst),
        cases: stmt.cases.map((switchCase) => ({
          ...switchCase,
          test: switchCase.test ? rewriteExpression(switchCase.test, inst) : null,
          body: switchCase.body.map((s) => rewriteStatement(s, inst)),
        })),
      };
    case "BreakStatement":
    case "ContinueStatement":
      return stmt;
    case "ThrowStatement":
      return { ...stmt, expression: rewriteExpression(stmt.expression, inst) };
    case "TryStatement":
      return {
        ...stmt,
        tryBlock: stmt.tryBlock.map((s) => rewriteStatement(s, inst)),
        catchClause: stmt.catchClause
          ? {
              ...stmt.catchClause,
              body: stmt.catchClause.body.map((s) => rewriteStatement(s, inst)),
            }
          : null,
        finallyBlock: stmt.finallyBlock
          ? stmt.finallyBlock.map((s) => rewriteStatement(s, inst))
          : null,
      };
  }
}

function rewriteDeclBody(
  decl: TopLevelDeclaration,
  inst: TypecheckInstantiations,
): TopLevelDeclaration {
  if (decl.kind === "FunctionDeclaration") {
    return {
      ...decl,
      params: decl.params.map((p) => ({
        ...p,
        typeAnnotation: rewriteType(p.typeAnnotation, inst.typeRewrites),
      })),
      returnType: rewriteType(decl.returnType, inst.typeRewrites),
      body: decl.body ? decl.body.map((s) => rewriteStatement(s, inst)) : null,
    };
  }
  if (decl.kind === "StructDeclaration") {
    return {
      ...decl,
      fields: decl.fields.map((f) => ({
        ...f,
        typeAnnotation: rewriteType(f.typeAnnotation, inst.typeRewrites),
      })),
      methods: decl.methods.map((m) => ({
        ...m,
        params: m.params.map((p) => ({
          ...p,
          typeAnnotation: rewriteType(p.typeAnnotation, inst.typeRewrites),
        })),
        returnType: rewriteType(m.returnType, inst.typeRewrites),
        body: m.body.map((s) => rewriteStatement(s, inst)),
      })),
    };
  }
  if (decl.kind === "ClassDeclaration") {
    return {
      ...decl,
      superclass: decl.superclass
        ? (rewriteType(decl.superclass, inst.typeRewrites) as NamedType)
        : null,
      implementsTypes: decl.implementsTypes.map(
        (t) => rewriteType(t, inst.typeRewrites) as NamedType,
      ),
      members: decl.members.map((member) => {
        if (member.kind === "ClassField") {
          return {
            ...member,
            typeAnnotation: rewriteType(member.typeAnnotation, inst.typeRewrites),
            initializer: member.initializer
              ? rewriteExpression(member.initializer, inst)
              : null,
          };
        }
        if (member.kind === "ConstructorDeclaration") {
          return {
            ...member,
            params: member.params.map((p) => ({
              ...p,
              typeAnnotation: rewriteType(p.typeAnnotation, inst.typeRewrites),
            })),
            body: member.body.map((s) => rewriteStatement(s, inst)),
          };
        }
        return {
          ...member,
          params: member.params.map((p) => ({
            ...p,
            typeAnnotation: rewriteType(p.typeAnnotation, inst.typeRewrites),
          })),
          returnType: rewriteType(member.returnType, inst.typeRewrites),
          body: member.body
            ? member.body.map((s) => rewriteStatement(s, inst))
            : null,
        };
      }),
    };
  }
  if (decl.kind === "InterfaceDeclaration") {
    return {
      ...decl,
      bases: decl.bases.map((t) => rewriteType(t, inst.typeRewrites) as NamedType),
      methods: decl.methods.map((m) => ({
        ...m,
        params: m.params.map((p) => ({
          ...p,
          typeAnnotation: rewriteType(p.typeAnnotation, inst.typeRewrites),
        })),
        returnType: rewriteType(m.returnType, inst.typeRewrites),
      })),
    };
  }
  return decl;
}

function findTemplate(
  modules: readonly ResolvedModule[],
  modulePath: string,
  localName: string,
  kind: InstantiationRecord["kind"],
): TopLevelDeclaration | null {
  const mod = modules.find((m) => m.path === modulePath);
  if (!mod) {
    return null;
  }
  for (const decl of mod.ast.body) {
    if (
      (kind === "struct" || kind === "structMethod") &&
      decl.kind === "StructDeclaration" &&
      decl.name.name === localName
    ) {
      return decl;
    }
    if (
      (kind === "class" || kind === "classMethod") &&
      decl.kind === "ClassDeclaration" &&
      decl.name.name === localName
    ) {
      return decl;
    }
    if (
      kind === "interface" &&
      decl.kind === "InterfaceDeclaration" &&
      decl.name.name === localName
    ) {
      return decl;
    }
    if (
      kind === "function" &&
      decl.kind === "FunctionDeclaration" &&
      decl.name.name === localName
    ) {
      return decl;
    }
  }
  return null;
}

function injectClassMethod(
  body: TopLevelDeclaration[],
  ownerLocalName: string,
  method: ClassMethod,
): void {
  for (let i = 0; i < body.length; i += 1) {
    const decl = body[i]!;
    if (decl.kind === "ClassDeclaration" && decl.name.name === ownerLocalName) {
      const updated: ClassDeclaration = {
        ...decl,
        members: [...decl.members, method],
      };
      body[i] = updated;
      return;
    }
  }
}

function injectStructMethod(
  body: TopLevelDeclaration[],
  ownerLocalName: string,
  method: StructMethod,
): void {
  for (let i = 0; i < body.length; i += 1) {
    const decl = body[i]!;
    if (decl.kind === "StructDeclaration" && decl.name.name === ownerLocalName) {
      const updated: StructDeclaration = {
        ...decl,
        methods: [...decl.methods, method],
      };
      body[i] = updated;
      return;
    }
  }
}

/**
 * Rewrite modules so codegen only sees concrete (non-generic) declarations.
 * Generic templates are removed; specialized clones are appended.
 */
export function monomorphizeModules(
  modules: readonly ResolvedModule[],
  instantiations: TypecheckInstantiations,
): ResolvedModule[] {
  const extras = new Map<string, TopLevelDeclaration[]>();
  const methodExtras: InstantiationRecord[] = [];

  for (const record of instantiations.records) {
    if (record.kind === "classMethod" || record.kind === "structMethod") {
      methodExtras.push(record);
      continue;
    }
    const template = findTemplate(
      modules,
      record.modulePath,
      record.templateLocalName,
      record.kind,
    );
    if (!template) {
      continue;
    }
    let specialized: TopLevelDeclaration | null = null;
    if (record.kind === "struct" && template.kind === "StructDeclaration") {
      specialized = specializeStructDecl(
        template,
        record.instanceLocalName,
        buildSubst(template.typeParams, record.typeArgs),
      );
    } else if (record.kind === "class" && template.kind === "ClassDeclaration") {
      specialized = specializeClassDecl(
        template,
        record.instanceLocalName,
        buildSubst(template.typeParams, record.typeArgs),
      );
    } else if (record.kind === "interface" && template.kind === "InterfaceDeclaration") {
      specialized = specializeInterfaceDecl(
        template,
        record.instanceLocalName,
        buildSubst(template.typeParams, record.typeArgs),
      );
    } else if (record.kind === "function" && template.kind === "FunctionDeclaration") {
      specialized = specializeFunctionDecl(
        template,
        record.instanceLocalName,
        buildSubst(template.typeParams, record.typeArgs),
      );
    }
    if (!specialized) {
      continue;
    }
    specialized = rewriteDeclBody(specialized, instantiations);
    const list = extras.get(record.modulePath) ?? [];
    if (!list.some((d) => "name" in d && d.name.name === record.instanceLocalName)) {
      list.push(specialized);
      extras.set(record.modulePath, list);
    }
  }

  return modules.map((mod) => {
    const body: TopLevelDeclaration[] = [];
    for (const decl of mod.ast.body) {
      if (
        (decl.kind === "StructDeclaration" ||
          decl.kind === "ClassDeclaration" ||
          decl.kind === "InterfaceDeclaration" ||
          decl.kind === "FunctionDeclaration") &&
        decl.typeParams.length > 0
      ) {
        // Keep generic extern declarations — they are C ABI imports, not templates to strip.
        if (decl.kind === "FunctionDeclaration" && decl.isExtern) {
          body.push(rewriteDeclBody(decl, instantiations));
        }
        continue;
      }
      // Strip generic methods from concrete types; specialized copies are injected below.
      if (decl.kind === "ClassDeclaration") {
        const stripped: ClassDeclaration = {
          ...decl,
          members: decl.members.map((m) => {
            if (m.kind === "ClassMethod" && m.typeParams.length > 0) {
              // Keep placeholder? Drop — specialized versions injected.
              return m;
            }
            return m;
          }).filter((m) => !(m.kind === "ClassMethod" && m.typeParams.length > 0)),
        };
        body.push(rewriteDeclBody(stripped, instantiations));
        continue;
      }
      if (decl.kind === "StructDeclaration") {
        const stripped: StructDeclaration = {
          ...decl,
          methods: decl.methods.filter((m) => m.typeParams.length === 0),
        };
        body.push(rewriteDeclBody(stripped, instantiations));
        continue;
      }
      body.push(rewriteDeclBody(decl, instantiations));
    }
    body.push(...(extras.get(mod.path) ?? []));

    for (const record of methodExtras) {
      if (record.modulePath !== mod.path) {
        continue;
      }
      const template = findTemplate(
        modules,
        record.modulePath,
        record.templateLocalName,
        record.kind,
      );
      if (!template) {
        continue;
      }
      if (record.kind === "classMethod" && template.kind === "ClassDeclaration") {
        const method = template.members.find(
          (m): m is ClassMethod =>
            m.kind === "ClassMethod" && m.name.name === record.methodTemplateName,
        );
        if (!method) {
          continue;
        }
        const ownerArgs = record.ownerTypeArgs ?? [];
        const methodArgs = record.methodTypeArgs ?? record.typeArgs;
        const subst = buildSubst(
          [...template.typeParams, ...method.typeParams],
          [...ownerArgs, ...methodArgs],
        );
        const specialized = specializeClassMethod(method, record.instanceLocalName, subst);
        const rewritten = rewriteDeclBody(
          {
            kind: "ClassDeclaration",
            exported: false,
            isAbstract: false,
            name: {
              kind: "Identifier",
              name: record.ownerInstanceLocalName ?? template.name.name,
              span: template.name.span,
            },
            typeParams: [],
            superclass: null,
            implementsTypes: [],
            members: [specialized],
            span: template.span,
          },
          instantiations,
        ) as ClassDeclaration;
        injectClassMethod(
          body,
          record.ownerInstanceLocalName ?? template.name.name,
          rewritten.members[0] as ClassMethod,
        );
      } else if (record.kind === "structMethod" && template.kind === "StructDeclaration") {
        const method = template.methods.find((m) => m.name.name === record.methodTemplateName);
        if (!method) {
          continue;
        }
        const ownerArgs = record.ownerTypeArgs ?? [];
        const methodArgs = record.methodTypeArgs ?? record.typeArgs;
        const subst = buildSubst(
          [...template.typeParams, ...method.typeParams],
          [...ownerArgs, ...methodArgs],
        );
        const specialized = specializeStructMethod(method, record.instanceLocalName, subst);
        injectStructMethod(
          body,
          record.ownerInstanceLocalName ?? template.name.name,
          specialized,
        );
      }
    }

    const ast: Program = {
      kind: "Program",
      body,
      span: mod.ast.span,
    };
    return { ...mod, ast };
  });
}

export function emptyInstantiations(): TypecheckInstantiations {
  return {
    records: [],
    callRewrites: new Map(),
    methodCallRewrites: new Map(),
    extensionCallRewrites: new Map(),
    newRewrites: new Map(),
    structLiteralRewrites: new Map(),
    typeRewrites: new Map(),
    lambdaCaptures: new Map(),
  };
}
