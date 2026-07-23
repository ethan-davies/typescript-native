import type {
  ArrayBindingPattern,
  Assignable,
  BindingPattern,
  CallArgument,
  ClassMember,
  Expression,
  ImportClause,
  LambdaBody,
  Parameter,
  Program,
  Statement,
  TopLevelDeclaration,
  TypeAnnotation,
  TypeParameter,
} from "../ast/nodes.js";

const INDENT = "  ";

export function printProgram(program: Program): string {
  const parts: string[] = [];
  for (let i = 0; i < program.body.length; i++) {
    if (i > 0) {
      parts.push("");
    }
    parts.push(printTopLevel(program.body[i]!));
  }
  const text = parts.join("\n");
  return text.length === 0 ? "\n" : text.endsWith("\n") ? text : text + "\n";
}

function printTopLevel(decl: TopLevelDeclaration): string {
  switch (decl.kind) {
    case "ImportDeclaration":
      return printImport(decl.clause, decl.source.value);
    case "FunctionDeclaration":
      return printFunction(decl);
    case "StructDeclaration":
      return printStruct(decl);
    case "EnumDeclaration":
      return printEnum(decl);
    case "ClassDeclaration":
      return printClass(decl);
    case "InterfaceDeclaration":
      return printInterface(decl);
    case "TypeAliasDeclaration": {
      const exp = decl.exported ? "export " : "";
      const tps = printTypeParams(decl.typeParams);
      return `${exp}type ${decl.name.name}${tps} = ${printType(decl.type)};`;
    }
  }
}

function printImport(clause: ImportClause, source: string): string {
  const src = escapeStringLiteral(source);
  if (clause.kind === "NamespaceImport") {
    if (clause.localName) {
      return `import ${src} as ${clause.localName.name};`;
    }
    return `import ${src};`;
  }
  const specs = clause.specifiers
    .map((s) =>
      s.importedName.name === s.localName.name
        ? s.importedName.name
        : `${s.importedName.name} as ${s.localName.name}`,
    )
    .join(", ");
  return `import { ${specs} } from ${src};`;
}

function printFunction(decl: {
  exported: boolean;
  isExtern: boolean;
  name: { name: string };
  typeParams: TypeParameter[];
  params: Parameter[];
  returnType: TypeAnnotation;
  body: Statement[] | null;
}): string {
  const exp = decl.exported ? "export " : "";
  const ext = decl.isExtern ? "extern " : "";
  const tps = printTypeParams(decl.typeParams);
  const params = decl.params.map(printParam).join(", ");
  const ret = printType(decl.returnType);
  const header = `${exp}${ext}function ${decl.name.name}${tps}(${params}): ${ret}`;
  if (decl.isExtern || decl.body === null) {
    return `${header};`;
  }
  return `${header} ${printBlock(decl.body, 0)}`;
}

function printParam(p: Parameter): string {
  let out = `${p.name.name}: ${printType(p.typeAnnotation)}`;
  if (p.defaultValue) {
    out += ` = ${printExpr(p.defaultValue)}`;
  }
  return out;
}

function printTypeParams(params: TypeParameter[]): string {
  if (params.length === 0) {
    return "";
  }
  const inner = params
    .map((p) =>
      p.constraint
        ? `${p.name.name} extends ${printType(p.constraint)}`
        : p.name.name,
    )
    .join(", ");
  return `<${inner}>`;
}

function printStruct(decl: {
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
}): string {
  const exp = decl.exported ? "export " : "";
  const tps = printTypeParams(decl.typeParams);
  const lines: string[] = [`${exp}struct ${decl.name.name}${tps} {`];
  for (const field of decl.fields) {
    lines.push(
      `${INDENT}${field.name.name}: ${printType(field.typeAnnotation)};`,
    );
  }
  for (const method of decl.methods) {
    if (lines.length > 1) {
      lines.push("");
    }
    const mtps = printTypeParams(method.typeParams);
    const params = method.params.map(printParam).join(", ");
    const header = `${INDENT}${method.name.name}${mtps}(${params}): ${printType(method.returnType)}`;
    lines.push(`${header} ${printBlock(method.body, 1)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function printEnum(decl: {
  exported: boolean;
  name: { name: string };
  variants: readonly { name: { name: string } }[];
}): string {
  const exp = decl.exported ? "export " : "";
  const lines = [`${exp}enum ${decl.name.name} {`];
  for (const v of decl.variants) {
    lines.push(`${INDENT}${v.name.name},`);
  }
  lines.push("}");
  return lines.join("\n");
}

function printClass(decl: {
  exported: boolean;
  isAbstract: boolean;
  name: { name: string };
  typeParams: TypeParameter[];
  superclass: { namespace: string | null; name: string; typeArgs: TypeAnnotation[] } | null;
  implementsTypes: readonly {
    namespace: string | null;
    name: string;
    typeArgs: TypeAnnotation[];
  }[];
  members: ClassMember[];
}): string {
  const exp = decl.exported ? "export " : "";
  const abs = decl.isAbstract ? "abstract " : "";
  const tps = printTypeParams(decl.typeParams);
  let header = `${exp}${abs}class ${decl.name.name}${tps}`;
  if (decl.superclass) {
    header += ` extends ${printNamedType(decl.superclass)}`;
  }
  if (decl.implementsTypes.length > 0) {
    header +=
      " implements " +
      decl.implementsTypes.map(printNamedType).join(", ");
  }
  const lines: string[] = [`${header} {`];
  for (let i = 0; i < decl.members.length; i++) {
    const member = decl.members[i]!;
    if (i > 0) {
      lines.push("");
    }
    lines.push(printClassMember(member, 1));
  }
  lines.push("}");
  return lines.join("\n");
}

function printClassMember(member: ClassMember, indent: number): string {
  const pad = INDENT.repeat(indent);
  switch (member.kind) {
    case "ClassField": {
      // Default visibility is public; omit the keyword unless private.
      const visOut = member.visibility === "private" ? "private " : "";
      const st = member.isStatic ? "static " : "";
      const ro = member.isReadonly ? "readonly " : "";
      let line = `${pad}${visOut}${st}${ro}${member.name.name}: ${printType(member.typeAnnotation)}`;
      if (member.initializer) {
        line += ` = ${printExpr(member.initializer)}`;
      }
      return line + ";";
    }
    case "ClassMethod": {
      const methodVis =
        member.visibility === "private" ? "private " : "";
      const st = member.isStatic ? "static " : "";
      const abs = member.isAbstract ? "abstract " : "";
      const tps = printTypeParams(member.typeParams);
      const params = member.params.map(printParam).join(", ");
      const header = `${pad}${methodVis}${st}${abs}${member.name.name}${tps}(${params}): ${printType(member.returnType)}`;
      if (member.isAbstract || member.body === null) {
        return `${header};`;
      }
      return `${header} ${printBlock(member.body, indent)}`;
    }
    case "ConstructorDeclaration": {
      const vis =
        member.visibility === "private" ? "private " : "";
      const params = member.params.map(printParam).join(", ");
      return `${pad}${vis}constructor(${params}) ${printBlock(member.body, indent)}`;
    }
  }
}

function printInterface(decl: {
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
  }[];
  indexSignature: {
    keyName: { name: string };
    keyType: TypeAnnotation;
    valueType: TypeAnnotation;
  } | null;
}): string {
  const exp = decl.exported ? "export " : "";
  const tps = printTypeParams(decl.typeParams);
  let header = `${exp}interface ${decl.name.name}${tps}`;
  if (decl.bases.length > 0) {
    header += " extends " + decl.bases.map(printNamedType).join(", ");
  }
  const lines: string[] = [`${header} {`];
  for (const method of decl.methods) {
    const mtps = printTypeParams(method.typeParams);
    const params = method.params.map(printParam).join(", ");
    lines.push(
      `${INDENT}${method.name.name}${mtps}(${params}): ${printType(method.returnType)};`,
    );
  }
  if (decl.indexSignature) {
    const ix = decl.indexSignature;
    lines.push(
      `${INDENT}[${ix.keyName.name}: ${printType(ix.keyType)}]: ${printType(ix.valueType)};`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function printBlock(statements: Statement[], indent: number): string {
  if (statements.length === 0) {
    return "{}";
  }
  const pad = INDENT.repeat(indent);
  const inner = INDENT.repeat(indent + 1);
  const lines: string[] = [];
  for (const s of statements) {
    const printed = printStatement(s, indent + 1);
    const stmtLines = printed.split("\n");
    for (let i = 0; i < stmtLines.length; i++) {
      lines.push(inner + stmtLines[i]!);
    }
  }
  return `{\n${lines.join("\n")}\n${pad}}`;
}

function printStatement(stmt: Statement, indent: number): string {
  switch (stmt.kind) {
    case "VariableDeclaration": {
      let out = `${stmt.mutability} ${printBinding(stmt.binding)}`;
      if (stmt.typeAnnotation) {
        out += `: ${printType(stmt.typeAnnotation)}`;
      }
      if (stmt.initializer) {
        out += ` = ${printExpr(stmt.initializer)}`;
      }
      return out + ";";
    }
    case "AssignmentStatement":
      return `${printAssignable(stmt.target)} ${stmt.operator} ${printExpr(stmt.value)};`;
    case "UpdateStatement":
      return `${stmt.name.name}${stmt.operator};`;
    case "ExpressionStatement":
      return `${printExpr(stmt.expression)};`;
    case "ReturnStatement":
      return stmt.value
        ? `return ${printExpr(stmt.value)};`
        : "return;";
    case "IfStatement":
      return printIf(stmt, indent);
    case "WhileStatement":
      return `while (${printExpr(stmt.condition)}) ${printBlock(stmt.body, indent)}`;
    case "ForStatement": {
      const init = stmt.initializer
        ? printForInit(stmt.initializer)
        : "";
      const cond = stmt.condition ? printExpr(stmt.condition) : "";
      const upd = stmt.update ? printForUpdate(stmt.update) : "";
      return `for (${init}; ${cond}; ${upd}) ${printBlock(stmt.body, indent)}`;
    }
    case "ForInStatement": {
      const bind =
        stmt.mutability === null
          ? stmt.name.name
          : `${stmt.mutability} ${stmt.name.name}`;
      return `for (${bind} in ${printExpr(stmt.iterable)}) ${printBlock(stmt.body, indent)}`;
    }
    case "SwitchStatement": {
      const pad = INDENT.repeat(indent);
      const inner = INDENT.repeat(indent + 1);
      const lines = [`switch (${printExpr(stmt.discriminant)}) {`];
      for (const c of stmt.cases) {
        if (c.isDefault) {
          lines.push(`${inner}default:`);
        } else {
          lines.push(`${inner}case ${printExpr(c.test!)}:`);
        }
        for (const s of c.body) {
          lines.push(
            `${INDENT.repeat(indent + 2)}${printStatement(s, indent + 2)}`,
          );
        }
      }
      lines.push(`${pad}}`);
      // First line already has no pad — caller adds pad for statement start.
      // For nested, we need the opening without duplicate. Return as multi-line
      // where first line is `switch (...) {`.
      return lines.join("\n");
    }
    case "BreakStatement":
      return "break;";
    case "ContinueStatement":
      return "continue;";
    case "ThrowStatement":
      return `throw ${printExpr(stmt.expression)};`;
    case "TryStatement": {
      let out = `try ${printBlock(stmt.tryBlock, indent)}`;
      if (stmt.catchClause) {
        out += ` catch (${stmt.catchClause.parameter.name}) ${printBlock(stmt.catchClause.body, indent)}`;
      }
      if (stmt.finallyBlock) {
        out += ` finally ${printBlock(stmt.finallyBlock, indent)}`;
      }
      return out;
    }
  }
}

function printIf(
  stmt: {
    condition: Expression;
    consequent: Statement[];
    alternate: { kind: "IfStatement"; condition: Expression; consequent: Statement[]; alternate: unknown } | Statement[] | null;
  },
  indent: number,
): string {
  let out = `if (${printExpr(stmt.condition)}) ${printBlock(stmt.consequent, indent)}`;
  if (stmt.alternate === null) {
    return out;
  }
  if (Array.isArray(stmt.alternate)) {
    return `${out} else ${printBlock(stmt.alternate, indent)}`;
  }
  // elseif — print as `elseif` if the language uses that keyword
  const alt = stmt.alternate as {
    kind: "IfStatement";
    condition: Expression;
    consequent: Statement[];
    alternate: typeof stmt.alternate;
  };
  return `${out} elseif (${printExpr(alt.condition)}) ${printIfBody(alt, indent)}`;
}

function printIfBody(
  stmt: {
    condition: Expression;
    consequent: Statement[];
    alternate: { kind: "IfStatement" } | Statement[] | null;
  },
  indent: number,
): string {
  // After elseif (cond), print the block and further alternates
  let out = printBlock(stmt.consequent, indent);
  if (stmt.alternate === null) {
    return out;
  }
  if (Array.isArray(stmt.alternate)) {
    return `${out} else ${printBlock(stmt.alternate, indent)}`;
  }
  const alt = stmt.alternate as {
    kind: "IfStatement";
    condition: Expression;
    consequent: Statement[];
    alternate: typeof stmt.alternate;
  };
  return `${out} elseif (${printExpr(alt.condition)}) ${printIfBody(alt, indent)}`;
}

function printForInit(
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
    let out = `${init.mutability} ${printBinding(init.binding!)}`;
    if (init.typeAnnotation) {
      out += `: ${printType(init.typeAnnotation)}`;
    }
    if (init.initializer) {
      out += ` = ${printExpr(init.initializer)}`;
    }
    return out;
  }
  return `${printAssignable(init.target!)} ${init.operator} ${printExpr(init.value!)}`;
}

function printForUpdate(
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
  return `${printAssignable(update.target!)} ${update.operator} ${printExpr(update.value!)}`;
}

function printBinding(binding: BindingPattern): string {
  if (binding.kind === "Identifier") {
    return binding.name;
  }
  return printArrayBinding(binding);
}

function printArrayBinding(binding: ArrayBindingPattern): string {
  const elems = binding.elements
    .map((e) => (e.name ? e.name.name : ""))
    .join(", ");
  return `[${elems}]`;
}

function printAssignable(target: Assignable): string {
  switch (target.kind) {
    case "Identifier":
      return target.name;
    case "IndexExpression":
    case "MemberExpression":
      return printExpr(target);
  }
}

function printExpr(expr: Expression): string {
  switch (expr.kind) {
    case "Identifier":
      return expr.name;
    case "StringLiteral":
      return escapeStringLiteral(expr.value);
    case "TemplateLiteral": {
      let out = "`";
      for (let i = 0; i < expr.quasis.length; i += 1) {
        out += escapeTemplateQuasi(expr.quasis[i] ?? "");
        if (i < expr.expressions.length) {
          out += "${" + printExpr(expr.expressions[i]!) + "}";
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
      return printBinary(expr.left, expr.operator, expr.right);
    case "UnaryExpression": {
      const operand = printExprWithParen(expr.operand, unaryPrecedence);
      return `${expr.operator}${operand}`;
    }
    case "NonNullExpression":
      return `${printExpr(expr.expression)}!`;
    case "NullCoalescingExpression":
      return `${printExprWithParen(expr.left, nullCoalescePrecedence)} ?? ${printExprWithParen(expr.right, nullCoalescePrecedence + 0.1)}`;
    case "TypeofExpression":
      return `typeof ${printExpr(expr.operand)}`;
    case "IsExpression":
      return `${printExpr(expr.value)} is ${printType(expr.typeAnnotation)}`;
    case "IndexExpression": {
      if (expr.optional) {
        return `${printExpr(expr.object)}?.[${printExpr(expr.index)}]`;
      }
      return `${printExpr(expr.object)}[${printExpr(expr.index)}]`;
    }
    case "MemberExpression": {
      const op = expr.optional ? "?." : ".";
      return `${printExpr(expr.object)}${op}${expr.property.name}`;
    }
    case "ArrayLiteral":
      return `[${expr.elements.map(printExpr).join(", ")}]`;
    case "StructLiteral": {
      const ns = expr.namespace ? `${expr.namespace.name}.` : "";
      const targs =
        expr.typeArgs.length > 0
          ? `<${expr.typeArgs.map(printType).join(", ")}>`
          : "";
      const fields = expr.fields
        .map((f) => `${f.name.name}: ${printExpr(f.value)}`)
        .join(", ");
      return `${ns}${expr.name.name}${targs} { ${fields} }`;
    }
    case "NewExpression": {
      const ns = expr.namespace ? `${expr.namespace.name}.` : "";
      const targs =
        expr.typeArgs.length > 0
          ? `<${expr.typeArgs.map(printType).join(", ")}>`
          : "";
      const args = expr.args.map(printArg).join(", ");
      return `new ${ns}${expr.className.name}${targs}(${args})`;
    }
    case "CallExpression": {
      // optional calls are encoded as optional MemberExpression callees (`obj?.m()`).
      const targs =
        expr.typeArgs.length > 0
          ? `<${expr.typeArgs.map(printType).join(", ")}>`
          : "";
      const args = expr.args.map(printArg).join(", ");
      return `${printExpr(expr.callee)}${targs}(${args})`;
    }
    case "LambdaExpression": {
      const params = expr.params
        .map((p) =>
          p.typeAnnotation
            ? `${p.name.name}: ${printType(p.typeAnnotation)}`
            : p.name.name,
        )
        .join(", ");
      const ret = expr.returnType
        ? `: ${printType(expr.returnType)}`
        : "";
      return `(${params})${ret} => ${printLambdaBody(expr.body)}`;
    }
  }
}

function printArg(arg: CallArgument): string {
  if (arg.kind === "NamedArgument") {
    return `${arg.name.name}: ${printExpr(arg.value)}`;
  }
  return printExpr(arg);
}

function printLambdaBody(body: LambdaBody): string {
  if (body.kind === "expression") {
    return printExpr(body.expression);
  }
  return printBlock(body.statements, 0);
}

function printType(type: TypeAnnotation): string {
  switch (type.kind) {
    case "PrimitiveType":
      return type.name;
    case "ArrayType":
      return `${printType(type.element)}[]`;
    case "TupleType":
      return `[${type.elements.map(printType).join(", ")}]`;
    case "NamedType":
      return printNamedType(type);
    case "UnionType":
      return type.types.map(printType).join(" | ");
    case "IntersectionType":
      return type.types.map(printType).join(" & ");
    case "ObjectType": {
      const parts: string[] = [];
      for (const f of type.fields) {
        const ro = f.readonly ? "readonly " : "";
        parts.push(`${ro}${f.name.name}: ${printType(f.typeAnnotation)}`);
      }
      if (type.indexSignature) {
        const ix = type.indexSignature;
        parts.push(
          `[${ix.keyName.name}: ${printType(ix.keyType)}]: ${printType(ix.valueType)}`,
        );
      }
      return `{ ${parts.join("; ")} }`;
    }
    case "LiteralType":
      return type.literalKind === "string"
        ? escapeStringLiteral(String(type.value))
        : String(type.value);
    case "KeyofType":
      return `keyof ${printType(type.type)}`;
    case "TypeofType":
      return `typeof ${printExpr(type.expression)}`;
    case "ConditionalType":
      return `${printType(type.checkType)} extends ${printType(type.extendsType)} ? ${printType(type.trueType)} : ${printType(type.falseType)}`;
    case "MappedType": {
      const ro = type.readonly ? "readonly " : "";
      return `{ ${ro}[${type.typeParam.name} in ${printType(type.constraint)}]: ${printType(type.type)} }`;
    }
    case "IndexedAccessType":
      return `${printType(type.objectType)}[${printType(type.indexType)}]`;
    case "FunctionType":
      return `(${type.params.map(printType).join(", ")}) => ${printType(type.returnType)}`;
  }
}

function printNamedType(type: {
  namespace: string | null;
  name: string;
  typeArgs: TypeAnnotation[];
}): string {
  const ns = type.namespace ? `${type.namespace}.` : "";
  const targs =
    type.typeArgs.length > 0
      ? `<${type.typeArgs.map(printType).join(", ")}>`
      : "";
  return `${ns}${type.name}${targs}`;
}

/** Higher number = binds tighter. Mirrors parser precedence. */
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

function printBinary(
  left: Expression,
  operator: string,
  right: Expression,
): string {
  const prec = binaryPrecedence(operator);
  // Left-assoc: parenthesize left if lower precedence; right if lower-or-equal.
  return `${printExprWithParen(left, prec)} ${operator} ${printExprWithParen(right, prec + 0.1)}`;
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

function printExprWithParen(expr: Expression, minPrecedence: number): string {
  const text = printExpr(expr);
  if (exprPrecedence(expr) < minPrecedence) {
    return `(${text})`;
  }
  return text;
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
