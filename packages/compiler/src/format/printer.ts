import type {
  ArrayBindingPattern,
  Assignable,
  BindingPattern,
  CallArgument,
  ClassMember,
  Expression,
  ImportClause,
  ImportDeclaration,
  LambdaBody,
  Parameter,
  Program,
  Statement,
  TopLevelDeclaration,
  TypeAnnotation,
  TypeParameter,
} from "../ast/nodes.js";
import {
  type CommentAttachments,
  printComment,
} from "./comments.js";
import { compareImportSpecifiers, importGroupsDiffer } from "./imports.js";
import {
  type FormatOptions,
  indentUnit,
  resolveFormatOptions,
} from "./options.js";

export function printProgram(
  program: Program,
  options: Partial<FormatOptions> = {},
  comments: CommentAttachments = emptyComments(),
): string {
  const printer = new Printer(resolveFormatOptions(options), comments);
  return printer.printProgram(program);
}

function emptyComments(): CommentAttachments {
  return {
    leading: new Map(),
    trailing: new Map(),
    eof: [],
  };
}

class Printer {
  private readonly unit: string;
  private readonly lineWidth: number;

  constructor(
    private readonly options: FormatOptions,
    private readonly comments: CommentAttachments,
  ) {
    this.unit = indentUnit(options);
    this.lineWidth = options.lineWidth;
  }

  printProgram(program: Program): string {
    const parts: string[] = [];
    for (const c of this.comments.leading.get(program) ?? []) {
      parts.push(printComment(c, ""));
    }
    const body = reorderTopLevel(program.body);

    for (let i = 0; i < body.length; i++) {
      const decl = body[i]!;
      if (i > 0) {
        const prev = body[i - 1]!;
        if (
          !(
            prev.kind === "ImportDeclaration" &&
            decl.kind === "ImportDeclaration" &&
            !importGroupsDiffer(prev.source.value, decl.source.value)
          )
        ) {
          parts.push("");
        }
      }
      // File-level leading comments stay adjacent to the first declaration.
      parts.push(this.printTopLevel(decl, 0));
    }

    for (const c of this.comments.eof) {
      if (parts.length > 0 && parts[parts.length - 1] !== "") {
        parts.push("");
      }
      parts.push(printComment(c, ""));
    }

    const text = parts.join("\n");
    return text.length === 0 ? "\n" : text.endsWith("\n") ? text : `${text}\n`;
  }

  private printTopLevel(decl: TopLevelDeclaration, indent: number): string {
    const pad = this.pad(indent);
    const leading = this.leadingLines(decl, pad);
    let body: string;
    switch (decl.kind) {
      case "ImportDeclaration":
        body = this.printImport(decl);
        break;
      case "ExportNamedFromDeclaration": {
        const specs = decl.specifiers
          .map((s) =>
            s.importedName.name === s.exportName.name
              ? s.importedName.name
              : `${s.importedName.name} as ${s.exportName.name}`,
          )
          .join(", ");
        body = `export { ${specs} } from ${this.stringLit(decl.source)};`;
        break;
      }
      case "ExportAllFromDeclaration":
        body = `export * from ${this.stringLit(decl.source)};`;
        break;
      case "FunctionDeclaration":
        body = this.printFunction(decl, indent);
        break;
      case "ModuleVariableDeclaration": {
        const exp = decl.exported ? "export " : "";
        const ann = decl.typeAnnotation
          ? `: ${this.printType(decl.typeAnnotation)}`
          : "";
        body = `${exp}${decl.mutability} ${decl.name.name}${ann} = ${this.printExpr(decl.initializer, indent)};`;
        break;
      }
      case "StructDeclaration":
        body = this.printStruct(decl, indent);
        break;
      case "EnumDeclaration":
        body = this.printEnum(decl, indent);
        break;
      case "ClassDeclaration":
        body = this.printClass(decl, indent);
        break;
      case "InterfaceDeclaration":
        body = this.printInterface(decl, indent);
        break;
      case "TypeAliasDeclaration": {
        const exp = decl.exported ? "export " : "";
        const tps = this.printTypeParams(decl.typeParams);
        body = `${exp}type ${decl.name.name}${tps} = ${this.printType(decl.type)};`;
        break;
      }
    }
    return this.withTrailing(
      decl,
      leading.length > 0 ? `${leading.join("\n")}\n${pad}${body}` : `${pad}${body}`,
      pad,
    );
  }

  private printImport(decl: ImportDeclaration): string {
    const src = this.stringLit(decl.source);
    const clause = decl.clause;
    if (clause.kind === "NamespaceImport") {
      if (clause.style === "star") {
        const name = clause.localName?.name ?? "_";
        return `import * as ${name} from ${src};`;
      }
      if (clause.localName) {
        return `import ${src} as ${clause.localName.name};`;
      }
      return `import ${src};`;
    }
    return this.printNamedImport(clause, src, 0);
  }

  private printNamedImport(
    clause: Extract<ImportClause, { kind: "NamedImports" }>,
    src: string,
    indent: number,
  ): string {
    const specs = clause.specifiers.map((s) =>
      s.importedName.name === s.localName.name
        ? s.importedName.name
        : `${s.importedName.name} as ${s.localName.name}`,
    );
    const flat = `import { ${specs.join(", ")} } from ${src};`;
    if (this.fits(flat, indent) || specs.length <= 1) {
      return flat;
    }
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    const lines = specs.map((s) => `${inner}${s},`);
    return `import {\n${lines.join("\n")}\n${pad}} from ${src};`;
  }

  private printFunction(
    decl: {
      exported: boolean;
      isExtern: boolean;
      isAsync?: boolean;
      name: { name: string };
      typeParams: TypeParameter[];
      params: Parameter[];
      returnType: TypeAnnotation;
      body: Statement[] | null;
    },
    indent: number,
  ): string {
    const exp = decl.exported ? "export " : "";
    const ext = decl.isExtern ? "extern " : "";
    const asyncKw = decl.isAsync ? "async " : "";
    const tps = this.printTypeParams(decl.typeParams);
    const params = this.printParamList(decl.params, indent);
    const ret = this.printType(decl.returnType);
    const header = `${exp}${ext}${asyncKw}function ${decl.name.name}${tps}${params}: ${ret}`;
    if (decl.isExtern || decl.body === null) {
      return `${header};`;
    }
    return `${header} ${this.printBlock(decl.body, indent)}`;
  }

  private printParamList(params: Parameter[], indent: number): string {
    const items = params.map((p) => this.printParam(p));
    const flat = `(${items.join(", ")})`;
    if (this.fits(flat, indent) || items.length === 0) {
      return flat;
    }
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    return `(\n${items.map((p) => `${inner}${p},`).join("\n")}\n${pad})`;
  }

  private printParam(p: Parameter): string {
    let out = `${p.name.name}: ${this.printType(p.typeAnnotation)}`;
    if (p.defaultValue) {
      out += ` = ${this.printExpr(p.defaultValue, 0)}`;
    }
    return out;
  }

  private printTypeParams(params: TypeParameter[]): string {
    if (params.length === 0) {
      return "";
    }
    const inner = params
      .map((p) =>
        p.constraint
          ? `${p.name.name} extends ${this.printType(p.constraint)}`
          : p.name.name,
      )
      .join(", ");
    return `<${inner}>`;
  }

  private printStruct(
    decl: {
      exported: boolean;
      name: { name: string };
      typeParams: TypeParameter[];
      fields: readonly {
        name: { name: string };
        typeAnnotation: TypeAnnotation;
      }[];
      methods: readonly {
        name: { name: string };
        typeParams: TypeParameter[];
        params: Parameter[];
        returnType: TypeAnnotation;
        body: Statement[];
      }[];
    },
    indent: number,
  ): string {
    const exp = decl.exported ? "export " : "";
    const tps = this.printTypeParams(decl.typeParams);
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    const lines: string[] = [`${exp}struct ${decl.name.name}${tps} {`];
    for (const field of decl.fields) {
      lines.push(
        `${inner}${field.name.name}: ${this.printType(field.typeAnnotation)};`,
      );
    }
    for (const method of decl.methods) {
      if (lines.length > 1) {
        lines.push("");
      }
      const mtps = this.printTypeParams(method.typeParams);
      const params = this.printParamList(method.params, indent + 1);
      const header = `${inner}${method.name.name}${mtps}${params}: ${this.printType(method.returnType)}`;
      lines.push(`${header} ${this.printBlock(method.body, indent + 1)}`);
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  private printEnum(
    decl: {
      exported: boolean;
      name: { name: string };
      variants: readonly { name: { name: string } }[];
    },
    indent: number,
  ): string {
    const exp = decl.exported ? "export " : "";
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    const lines = [`${exp}enum ${decl.name.name} {`];
    for (const v of decl.variants) {
      lines.push(`${inner}${v.name.name},`);
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  private printClass(
    decl: {
      exported: boolean;
      isAbstract: boolean;
      name: { name: string };
      typeParams: TypeParameter[];
      superclass: {
        namespace: string | null;
        name: string;
        typeArgs: TypeAnnotation[];
      } | null;
      implementsTypes: readonly {
        namespace: string | null;
        name: string;
        typeArgs: TypeAnnotation[];
      }[];
      members: ClassMember[];
    },
    indent: number,
  ): string {
    const exp = decl.exported ? "export " : "";
    const abs = decl.isAbstract ? "abstract " : "";
    const tps = this.printTypeParams(decl.typeParams);
    let header = `${exp}${abs}class ${decl.name.name}${tps}`;
    if (decl.superclass) {
      header += ` extends ${this.printNamedType(decl.superclass)}`;
    }
    if (decl.implementsTypes.length > 0) {
      header +=
        " implements " +
        decl.implementsTypes.map((t) => this.printNamedType(t)).join(", ");
    }
    const pad = this.pad(indent);
    const lines: string[] = [`${header} {`];
    for (let i = 0; i < decl.members.length; i++) {
      const member = decl.members[i]!;
      if (i > 0) {
        lines.push("");
      }
      lines.push(this.printClassMember(member, indent + 1));
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  private printClassMember(member: ClassMember, indent: number): string {
    const pad = this.pad(indent);
    const leading = this.leadingLines(member, pad);
    let body: string;
    switch (member.kind) {
      case "ClassField": {
        const visOut = member.visibility === "private" ? "private " : "";
        const st = member.isStatic ? "static " : "";
        const ro = member.isReadonly ? "readonly " : "";
        let line = `${pad}${visOut}${st}${ro}${member.name.name}: ${this.printType(member.typeAnnotation)}`;
        if (member.initializer) {
          line += ` = ${this.printExpr(member.initializer, indent)}`;
        }
        body = `${line};`;
        break;
      }
      case "ClassMethod": {
        const methodVis = member.visibility === "private" ? "private " : "";
        const st = member.isStatic ? "static " : "";
        const abs = member.isAbstract ? "abstract " : "";
        const asyncKw = member.isAsync ? "async " : "";
        const tps = this.printTypeParams(member.typeParams);
        const params = this.printParamList(member.params, indent);
        const header = `${pad}${methodVis}${st}${abs}${asyncKw}${member.name.name}${tps}${params}: ${this.printType(member.returnType)}`;
        if (member.isAbstract || member.body === null) {
          body = `${header};`;
        } else {
          body = `${header} ${this.printBlock(member.body, indent)}`;
        }
        break;
      }
      case "ConstructorDeclaration": {
        const vis = member.visibility === "private" ? "private " : "";
        const params = this.printParamList(member.params, indent);
        body = `${pad}${vis}constructor${params} ${this.printBlock(member.body, indent)}`;
        break;
      }
    }
    const withLead =
      leading.length > 0 ? `${leading.join("\n")}\n${body}` : body;
    return this.withTrailing(member, withLead, pad);
  }

  private printInterface(
    decl: {
      exported: boolean;
      name: { name: string };
      typeParams: TypeParameter[];
      bases: readonly {
        namespace: string | null;
        name: string;
        typeArgs: TypeAnnotation[];
      }[];
      methods: readonly {
        name: { name: string };
        typeParams: TypeParameter[];
        params: Parameter[];
        returnType: TypeAnnotation;
        isAsync?: boolean;
      }[];
      indexSignature: {
        keyName: { name: string };
        keyType: TypeAnnotation;
        valueType: TypeAnnotation;
      } | null;
    },
    indent: number,
  ): string {
    const exp = decl.exported ? "export " : "";
    const tps = this.printTypeParams(decl.typeParams);
    let header = `${exp}interface ${decl.name.name}${tps}`;
    if (decl.bases.length > 0) {
      header +=
        " extends " + decl.bases.map((b) => this.printNamedType(b)).join(", ");
    }
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    const lines: string[] = [`${header} {`];
    for (const method of decl.methods) {
      const asyncKw = method.isAsync ? "async " : "";
      const mtps = this.printTypeParams(method.typeParams);
      const params = this.printParamList(method.params, indent + 1);
      lines.push(
        `${inner}${asyncKw}${method.name.name}${mtps}${params}: ${this.printType(method.returnType)};`,
      );
    }
    if (decl.indexSignature) {
      const ix = decl.indexSignature;
      lines.push(
        `${inner}[${ix.keyName.name}: ${this.printType(ix.keyType)}]: ${this.printType(ix.valueType)};`,
      );
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  private printBlock(statements: Statement[], indent: number): string {
    if (statements.length === 0) {
      return "{}";
    }
    const pad = this.pad(indent);
    const lines: string[] = [];
    for (const s of statements) {
      lines.push(this.printStatement(s, indent + 1));
    }
    return `{\n${lines.join("\n")}\n${pad}}`;
  }

  private printStatement(stmt: Statement, indent: number): string {
    const pad = this.pad(indent);
    const leading = this.leadingLines(stmt, pad);
    let body: string;
    switch (stmt.kind) {
      case "VariableDeclaration": {
        let out = `${stmt.mutability} ${this.printBinding(stmt.binding)}`;
        if (stmt.typeAnnotation) {
          out += `: ${this.printType(stmt.typeAnnotation)}`;
        }
        if (stmt.initializer) {
          out += ` = ${this.printExpr(stmt.initializer, indent)}`;
        }
        body = `${pad}${out};`;
        break;
      }
      case "AssignmentStatement":
        body = `${pad}${this.printAssignable(stmt.target)} ${stmt.operator} ${this.printExpr(stmt.value, indent)};`;
        break;
      case "UpdateStatement":
        body = `${pad}${stmt.name.name}${stmt.operator};`;
        break;
      case "ExpressionStatement":
        body = `${pad}${this.printExpr(stmt.expression, indent)};`;
        break;
      case "ReturnStatement":
        body = stmt.value
          ? `${pad}return ${this.printExpr(stmt.value, indent)};`
          : `${pad}return;`;
        break;
      case "IfStatement":
        body = `${pad}${this.printIf(stmt, indent)}`;
        break;
      case "WhileStatement":
        body = `${pad}while (${this.printExpr(stmt.condition, indent)}) ${this.printBlock(stmt.body, indent)}`;
        break;
      case "ForStatement": {
        const init = stmt.initializer ? this.printForInit(stmt.initializer) : "";
        const cond = stmt.condition ? this.printExpr(stmt.condition, indent) : "";
        const upd = stmt.update ? this.printForUpdate(stmt.update) : "";
        body = `${pad}for (${init}; ${cond}; ${upd}) ${this.printBlock(stmt.body, indent)}`;
        break;
      }
      case "ForInStatement": {
        const bind =
          stmt.mutability === null
            ? stmt.name.name
            : `${stmt.mutability} ${stmt.name.name}`;
        body = `${pad}for (${bind} in ${this.printExpr(stmt.iterable, indent)}) ${this.printBlock(stmt.body, indent)}`;
        break;
      }
      case "SwitchStatement": {
        const inner = this.pad(indent + 1);
        const lines = [
          `${pad}switch (${this.printExpr(stmt.discriminant, indent)}) {`,
        ];
        for (const c of stmt.cases) {
          if (c.isDefault) {
            lines.push(`${inner}default:`);
          } else {
            lines.push(
              `${inner}case ${this.printExpr(c.test!, indent + 1)}:`,
            );
          }
          for (const s of c.body) {
            lines.push(this.printStatement(s, indent + 2));
          }
        }
        lines.push(`${pad}}`);
        body = lines.join("\n");
        break;
      }
      case "BreakStatement":
        body = `${pad}break;`;
        break;
      case "ContinueStatement":
        body = `${pad}continue;`;
        break;
      case "ThrowStatement":
        body = `${pad}throw ${this.printExpr(stmt.expression, indent)};`;
        break;
      case "TryStatement": {
        let out = `${pad}try ${this.printBlock(stmt.tryBlock, indent)}`;
        if (stmt.catchClause) {
          out += ` catch (${stmt.catchClause.parameter.name}) ${this.printBlock(stmt.catchClause.body, indent)}`;
        }
        if (stmt.finallyBlock) {
          out += ` finally ${this.printBlock(stmt.finallyBlock, indent)}`;
        }
        body = out;
        break;
      }
    }
    const withLead =
      leading.length > 0 ? `${leading.join("\n")}\n${body}` : body;
    return this.withTrailing(stmt, withLead, pad);
  }

  private printIf(
    stmt: {
      condition: Expression;
      consequent: Statement[];
      alternate:
        | {
            kind: "IfStatement";
            condition: Expression;
            consequent: Statement[];
            alternate: unknown;
          }
        | Statement[]
        | null;
    },
    indent: number,
  ): string {
    let out = `if (${this.printExpr(stmt.condition, indent)}) ${this.printBlock(stmt.consequent, indent)}`;
    if (stmt.alternate === null) {
      return out;
    }
    if (Array.isArray(stmt.alternate)) {
      return `${out} else ${this.printBlock(stmt.alternate, indent)}`;
    }
    const alt = stmt.alternate as {
      kind: "IfStatement";
      condition: Expression;
      consequent: Statement[];
      alternate: typeof stmt.alternate;
    };
    return `${out} elseif (${this.printExpr(alt.condition, indent)}) ${this.printIfBody(alt, indent)}`;
  }

  private printIfBody(
    stmt: {
      condition: Expression;
      consequent: Statement[];
      alternate: { kind: "IfStatement" } | Statement[] | null;
    },
    indent: number,
  ): string {
    let out = this.printBlock(stmt.consequent, indent);
    if (stmt.alternate === null) {
      return out;
    }
    if (Array.isArray(stmt.alternate)) {
      return `${out} else ${this.printBlock(stmt.alternate, indent)}`;
    }
    const alt = stmt.alternate as {
      kind: "IfStatement";
      condition: Expression;
      consequent: Statement[];
      alternate: typeof stmt.alternate;
    };
    return `${out} elseif (${this.printExpr(alt.condition, indent)}) ${this.printIfBody(alt, indent)}`;
  }

  private printForInit(
    init: {
      kind: string;
      mutability?: string;
      binding?: BindingPattern;
      typeAnnotation?: TypeAnnotation | null;
      initializer?: Expression | null;
      target?: Assignable;
      operator?: string;
      value?: Expression;
    },
  ): string {
    if (init.kind === "VariableDeclaration") {
      let out = `${init.mutability} ${this.printBinding(init.binding!)}`;
      if (init.typeAnnotation) {
        out += `: ${this.printType(init.typeAnnotation)}`;
      }
      if (init.initializer) {
        out += ` = ${this.printExpr(init.initializer, 0)}`;
      }
      return out;
    }
    return `${this.printAssignable(init.target!)} ${init.operator} ${this.printExpr(init.value!, 0)}`;
  }

  private printForUpdate(
    update: {
      kind: string;
      name?: { name: string };
      operator: string;
      target?: Assignable;
      value?: Expression;
    },
  ): string {
    if (update.kind === "UpdateStatement") {
      return `${update.name!.name}${update.operator}`;
    }
    return `${this.printAssignable(update.target!)} ${update.operator} ${this.printExpr(update.value!, 0)}`;
  }

  private printBinding(binding: BindingPattern): string {
    if (binding.kind === "Identifier") {
      return binding.name;
    }
    return this.printArrayBinding(binding);
  }

  private printArrayBinding(binding: ArrayBindingPattern): string {
    const elems = binding.elements
      .map((e) => (e.name ? e.name.name : ""))
      .join(", ");
    return `[${elems}]`;
  }

  private printAssignable(target: Assignable): string {
    switch (target.kind) {
      case "Identifier":
        return target.name;
      case "IndexExpression":
      case "MemberExpression":
        return this.printExpr(target, 0);
    }
  }

  private printExpr(expr: Expression, indent: number): string {
    switch (expr.kind) {
      case "Identifier":
        return expr.name;
      case "StringLiteral":
        return expr.raw;
      case "TemplateLiteral": {
        let out = "`";
        for (let i = 0; i < expr.quasis.length; i += 1) {
          out += escapeTemplateQuasi(expr.quasis[i] ?? "");
          if (i < expr.expressions.length) {
            out += "${" + this.printExpr(expr.expressions[i]!, indent) + "}";
          }
        }
        out += "`";
        return out;
      }
      case "IntegerLiteral":
        return expr.raw;
      case "FloatLiteral":
        return expr.raw;
      case "BooleanLiteral":
        return expr.value ? "true" : "false";
      case "NullLiteral":
        return "null";
      case "CharLiteral":
        return expr.raw;
      case "ThisExpression":
        return "this";
      case "SuperExpression":
        return "super";
      case "BinaryExpression":
        return this.printBinary(expr.left, expr.operator, expr.right, indent);
      case "UnaryExpression": {
        const operand = this.printExprWithParen(
          expr.operand,
          unaryPrecedence,
          indent,
        );
        return `${expr.operator}${operand}`;
      }
      case "AwaitExpression":
        return `await ${this.printExprWithParen(expr.argument, unaryPrecedence, indent)}`;
      case "NonNullExpression":
        return `${this.printExpr(expr.expression, indent)}!`;
      case "NullCoalescingExpression":
        return `${this.printExprWithParen(expr.left, nullCoalescePrecedence, indent)} ?? ${this.printExprWithParen(expr.right, nullCoalescePrecedence + 0.1, indent)}`;
      case "TypeofExpression":
        return `typeof ${this.printExpr(expr.operand, indent)}`;
      case "IsExpression":
        return `${this.printExpr(expr.value, indent)} is ${this.printType(expr.typeAnnotation)}`;
      case "IndexExpression": {
        if (expr.optional) {
          return `${this.printExpr(expr.object, indent)}?.[${this.printExpr(expr.index, indent)}]`;
        }
        return `${this.printExpr(expr.object, indent)}[${this.printExpr(expr.index, indent)}]`;
      }
      case "MemberExpression": {
        const op = expr.optional ? "?." : ".";
        return `${this.printExpr(expr.object, indent)}${op}${expr.property.name}`;
      }
      case "ArrayLiteral":
        return this.printArray(expr.elements, indent);
      case "StructLiteral":
        return this.printStructLiteral(expr, indent);
      case "NewExpression": {
        const ns = expr.namespace ? `${expr.namespace.name}.` : "";
        const targs =
          expr.typeArgs.length > 0
            ? `<${expr.typeArgs.map((t) => this.printType(t)).join(", ")}>`
            : "";
        const args = this.printArgList(expr.args, indent);
        return `new ${ns}${expr.className.name}${targs}${args}`;
      }
      case "CallExpression":
        return this.printCall(expr, indent);
      case "LambdaExpression":
        return this.printLambda(expr, indent);
    }
  }

  private printArray(elements: Expression[], indent: number): string {
    const items = elements.map((e) => this.printExpr(e, indent + 1));
    const flat = `[${items.join(", ")}]`;
    if (this.fits(flat, indent) || items.length <= 1) {
      return flat;
    }
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    return `[\n${items.map((e) => `${inner}${e},`).join("\n")}\n${pad}]`;
  }

  private printStructLiteral(
    expr: {
      namespace: { name: string } | null;
      name: { name: string };
      typeArgs: TypeAnnotation[];
      fields: readonly { name: { name: string }; value: Expression }[];
    },
    indent: number,
  ): string {
    const ns = expr.namespace ? `${expr.namespace.name}.` : "";
    const targs =
      expr.typeArgs.length > 0
        ? `<${expr.typeArgs.map((t) => this.printType(t)).join(", ")}>`
        : "";
    const fields = expr.fields.map(
      (f) => `${f.name.name}: ${this.printExpr(f.value, indent + 1)}`,
    );
    const prefix = `${ns}${expr.name.name}${targs}`;
    const flat = `${prefix} { ${fields.join(", ")} }`;
    if (this.fits(flat, indent) || fields.length <= 1) {
      return flat;
    }
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    // Trailing commas in multiline struct literals — parser accepts them in field lists.
    return `${prefix} {\n${fields.map((f) => `${inner}${f},`).join("\n")}\n${pad}}`;
  }

  private printArgList(args: CallArgument[], indent: number): string {
    const items = args.map((a) => this.printArg(a, indent + 1));
    const flat = `(${items.join(", ")})`;
    if (this.fits(flat, indent) || items.length === 0) {
      return flat;
    }
    const pad = this.pad(indent);
    const inner = this.pad(indent + 1);
    return `(\n${items.map((a) => `${inner}${a},`).join("\n")}\n${pad})`;
  }

  private printCall(
    expr: {
      callee: Expression;
      typeArgs: TypeAnnotation[];
      args: CallArgument[];
    },
    indent: number,
  ): string {
    const chain = flattenCallChain(expr);
    if (chain && chain.links.length >= 1) {
      return this.printMethodChain(chain, indent);
    }
    const targs =
      expr.typeArgs.length > 0
        ? `<${expr.typeArgs.map((t) => this.printType(t)).join(", ")}>`
        : "";
    return `${this.printExpr(expr.callee, indent)}${targs}${this.printArgList(expr.args, indent)}`;
  }

  private printMethodChain(
    chain: {
      root: Expression;
      links: {
        optional: boolean;
        property: string;
        typeArgs: TypeAnnotation[];
        args: CallArgument[];
      }[];
    },
    indent: number,
  ): string {
    const root = this.printExpr(chain.root, indent);
    const linkTexts = chain.links.map((link) => {
      const op = link.optional ? "?." : ".";
      const targs =
        link.typeArgs.length > 0
          ? `<${link.typeArgs.map((t) => this.printType(t)).join(", ")}>`
          : "";
      // Args for chain links: try flat first for measuring
      const argsFlat = `(${link.args.map((a) => this.printArg(a, 0)).join(", ")})`;
      return `${op}${link.property}${targs}${argsFlat}`;
    });
    const flat = root + linkTexts.join("");
    if (this.fits(flat, indent)) {
      // Re-print with proper indent for nested args if needed
      return (
        root +
        chain.links
          .map((link) => {
            const op = link.optional ? "?." : ".";
            const targs =
              link.typeArgs.length > 0
                ? `<${link.typeArgs.map((t) => this.printType(t)).join(", ")}>`
                : "";
            return `${op}${link.property}${targs}${this.printArgList(link.args, indent)}`;
          })
          .join("")
      );
    }
    const inner = this.pad(indent + 1);
    const lines = [root];
    for (const link of chain.links) {
      const op = link.optional ? "?." : ".";
      const targs =
        link.typeArgs.length > 0
          ? `<${link.typeArgs.map((t) => this.printType(t)).join(", ")}>`
          : "";
      lines.push(
        `${inner}${op}${link.property}${targs}${this.printArgList(link.args, indent + 1)}`,
      );
    }
    return lines.join("\n");
  }

  private printLambda(
    expr: {
      isAsync: boolean;
      params: readonly {
        name: { name: string };
        typeAnnotation: TypeAnnotation | null;
      }[];
      returnType: TypeAnnotation | null;
      body: LambdaBody;
    },
    indent: number,
  ): string {
    const asyncKw = expr.isAsync ? "async " : "";
    const params = expr.params
      .map((p) =>
        p.typeAnnotation
          ? `${p.name.name}: ${this.printType(p.typeAnnotation)}`
          : p.name.name,
      )
      .join(", ");
    const ret = expr.returnType ? `: ${this.printType(expr.returnType)}` : "";
    const head = `${asyncKw}(${params})${ret} => `;
    if (expr.body.kind === "expression") {
      return `${head}${this.printExpr(expr.body.expression, indent)}`;
    }
    return `${head}${this.printBlock(expr.body.statements, indent)}`;
  }

  private printArg(arg: CallArgument, indent: number): string {
    if (arg.kind === "NamedArgument") {
      return `${arg.name.name}: ${this.printExpr(arg.value, indent)}`;
    }
    return this.printExpr(arg, indent);
  }

  private printType(type: TypeAnnotation): string {
    switch (type.kind) {
      case "PrimitiveType":
        return type.name;
      case "ArrayType":
        return `${this.printType(type.element)}[]`;
      case "TupleType":
        return `[${type.elements.map((t) => this.printType(t)).join(", ")}]`;
      case "NamedType":
        return this.printNamedType(type);
      case "UnionType":
        return type.types.map((t) => this.printType(t)).join(" | ");
      case "IntersectionType":
        return type.types.map((t) => this.printType(t)).join(" & ");
      case "ObjectType": {
        const parts: string[] = [];
        for (const f of type.fields) {
          const ro = f.readonly ? "readonly " : "";
          parts.push(
            `${ro}${f.name.name}: ${this.printType(f.typeAnnotation)}`,
          );
        }
        if (type.indexSignature) {
          const ix = type.indexSignature;
          parts.push(
            `[${ix.keyName.name}: ${this.printType(ix.keyType)}]: ${this.printType(ix.valueType)}`,
          );
        }
        return `{ ${parts.join("; ")} }`;
      }
      case "LiteralType":
        return type.literalKind === "string"
          ? escapeStringLiteral(String(type.value))
          : String(type.value);
      case "KeyofType":
        return `keyof ${this.printType(type.type)}`;
      case "TypeofType":
        return `typeof ${this.printExpr(type.expression, 0)}`;
      case "ConditionalType":
        return `${this.printType(type.checkType)} extends ${this.printType(type.extendsType)} ? ${this.printType(type.trueType)} : ${this.printType(type.falseType)}`;
      case "MappedType": {
        const ro = type.readonly ? "readonly " : "";
        return `{ ${ro}[${type.typeParam.name} in ${this.printType(type.constraint)}]: ${this.printType(type.type)} }`;
      }
      case "IndexedAccessType":
        return `${this.printType(type.objectType)}[${this.printType(type.indexType)}]`;
      case "FunctionType": {
        const asyncKw = type.isAsync ? "async " : "";
        return `${asyncKw}(${type.params.map((t) => this.printType(t)).join(", ")}) => ${this.printType(type.returnType)}`;
      }
    }
  }

  private printNamedType(type: {
    namespace: string | null;
    name: string;
    typeArgs: TypeAnnotation[];
  }): string {
    const ns = type.namespace ? `${type.namespace}.` : "";
    const targs =
      type.typeArgs.length > 0
        ? `<${type.typeArgs.map((t) => this.printType(t)).join(", ")}>`
        : "";
    return `${ns}${type.name}${targs}`;
  }

  private printBinary(
    left: Expression,
    operator: string,
    right: Expression,
    indent: number,
  ): string {
    const prec = binaryPrecedence(operator);
    return `${this.printExprWithParen(left, prec, indent)} ${operator} ${this.printExprWithParen(right, prec + 0.1, indent)}`;
  }

  private printExprWithParen(
    expr: Expression,
    minPrecedence: number,
    indent: number,
  ): string {
    const text = this.printExpr(expr, indent);
    if (exprPrecedence(expr) < minPrecedence) {
      return `(${text})`;
    }
    return text;
  }

  private stringLit(lit: { raw: string; value: string }): string {
    return lit.raw;
  }

  private pad(level: number): string {
    return this.unit.repeat(level);
  }

  private fits(text: string, indent: number): boolean {
    const prefix = this.pad(indent).length;
    const longest = text.split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    return prefix + longest <= this.lineWidth;
  }

  private leadingLines(node: object, pad: string): string[] {
    const comments = this.comments.leading.get(node);
    if (!comments || comments.length === 0) {
      return [];
    }
    return comments.map((c) => printComment(c, pad));
  }

  private withTrailing(node: object, text: string, _pad: string): string {
    const comments = this.comments.trailing.get(node);
    if (!comments || comments.length === 0) {
      return text;
    }
    // Same-line trailing comments after the last line.
    const lines = text.split("\n");
    const last = lines.length - 1;
    let line = lines[last]!;
    for (const c of comments) {
      line += ` ${c.text}`;
    }
    lines[last] = line;
    return lines.join("\n");
  }
}

function reorderTopLevel(
  body: TopLevelDeclaration[],
): TopLevelDeclaration[] {
  const imports: ImportDeclaration[] = [];
  const rest: TopLevelDeclaration[] = [];
  for (const decl of body) {
    if (decl.kind === "ImportDeclaration") {
      imports.push(decl);
    } else {
      rest.push(decl);
    }
  }
  imports.sort((a, b) => compareImportSpecifiers(a.source.value, b.source.value));
  return [...imports, ...rest];
}

type CallChain = {
  root: Expression;
  links: {
    optional: boolean;
    property: string;
    typeArgs: TypeAnnotation[];
    args: CallArgument[];
  }[];
};

function flattenCallChain(expr: {
  callee: Expression;
  typeArgs: TypeAnnotation[];
  args: CallArgument[];
}): CallChain | null {
  if (expr.callee.kind !== "MemberExpression") {
    return null;
  }

  const links: CallChain["links"] = [];
  let currentCallee: Expression = expr.callee;
  let typeArgs: TypeAnnotation[] = expr.typeArgs;
  let args: CallArgument[] = expr.args;

  for (;;) {
    if (currentCallee.kind !== "MemberExpression") {
      break;
    }
    links.push({
      optional: currentCallee.optional,
      property: currentCallee.property.name,
      typeArgs,
      args,
    });

    const obj: Expression = currentCallee.object;
    if (obj.kind === "CallExpression" && obj.callee.kind === "MemberExpression") {
      currentCallee = obj.callee;
      typeArgs = obj.typeArgs;
      args = obj.args;
      continue;
    }
    return { root: obj, links: links.reverse() };
  }

  return links.length > 0
    ? { root: currentCallee, links: links.reverse() }
    : null;
}

const unaryPrecedence = 14;
const nullCoalescePrecedence = 3;

function binaryPrecedence(op: string): number {
  switch (op) {
    case "||":
      return 4;
    case "&&":
      return 5;
    case "==":
    case "!=":
      return 8;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return 9;
    case "+":
    case "-":
      return 11;
    case "*":
    case "/":
    case "%":
      return 12;
    default:
      return 0;
  }
}

function exprPrecedence(expr: Expression): number {
  switch (expr.kind) {
    case "BinaryExpression":
      return binaryPrecedence(expr.operator);
    case "NullCoalescingExpression":
      return nullCoalescePrecedence;
    case "UnaryExpression":
    case "TypeofExpression":
      return unaryPrecedence;
    case "IsExpression":
      return 7;
    default:
      return 100;
  }
}

function escapeStringLiteral(value: string): string {
  let out = "\"";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case "\"":
        out += "\\\"";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        out += ch;
    }
  }
  out += "\"";
  return out;
}

function escapeTemplateQuasi(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case "`":
        out += "\\`";
        break;
      case "$":
        out += "\\$";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        out += ch;
    }
  }
  return out;
}
