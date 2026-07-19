import type {
  AssignmentStatement,
  BinaryExpression,
  CallExpression,
  EnumDeclaration,
  Expression,
  ForInStatement,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  MemberExpression,
  Parameter,
  Program,
  ReturnStatement,
  Statement,
  StructDeclaration,
  StructLiteral,
  TypeAnnotation,
  UnaryExpression,
  UpdateStatement,
  VariableDeclaration,
  WhileStatement,
} from "../ast/nodes.js";
import {
  annotationToValueType,
  isArrayType,
  isEnumType,
  isStructType,
  type EnumValueType,
  type StructValueType,
  type ValueType,
} from "../typecheck.js";

interface LocalBinding {
  readonly ptr: string;
  readonly type: ValueType;
}

interface EmittedValue {
  readonly llvm: string;
  readonly type: ValueType;
}

interface FunctionSig {
  readonly name: string;
  readonly params: ValueType[];
  readonly returnType: ValueType | "void";
}

interface LoopContext {
  readonly continueLabel: string;
  readonly breakLabel: string;
}

interface StructFieldInfo {
  readonly name: string;
  readonly type: ValueType;
}

interface StructInfo {
  readonly name: string;
  readonly fields: StructFieldInfo[];
}

interface EnumInfo {
  readonly name: string;
  readonly variants: ReadonlyMap<string, number>;
}

const COMPARISON_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);
const LOGICAL_OPS = new Set(["&&", "||"]);

/** Array header: { i64 length, i64 capacity, ptr data } — 24 bytes. */
const ARRAY_HEADER_SIZE = 24;

/**
 * Lowers a validated, type-checked AST to LLVM IR text.
 */
export class LlvmCodegen {
  private stringCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private readonly stringGlobals = new Map<string, { name: string; length: number }>();
  private locals = new Map<string, LocalBinding>();
  private functions = new Map<string, FunctionSig>();
  private structs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private needsPrintf = false;
  private needsStringRuntime = false;
  private needsArrayRuntime = false;
  private needsAbort = false;
  private needsSprintf = false;
  private readonly functionBodies: string[] = [];
  private readonly loopStack: LoopContext[] = [];

  emit(program: Program): string {
    this.stringCounter = 0;
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.stringGlobals.clear();
    this.locals = new Map();
    this.functions.clear();
    this.structs.clear();
    this.enums.clear();
    this.needsPrintf = false;
    this.needsStringRuntime = false;
    this.needsArrayRuntime = false;
    this.needsAbort = false;
    this.needsSprintf = false;
    this.functionBodies.length = 0;
    this.loopStack.length = 0;

    for (const decl of program.body) {
      if (decl.kind === "EnumDeclaration") {
        this.registerEnum(decl);
      }
    }

    for (const decl of program.body) {
      if (decl.kind === "StructDeclaration") {
        this.registerStruct(decl);
      }
    }

    for (const decl of program.body) {
      if (decl.kind !== "FunctionDeclaration") {
        continue;
      }
      const fn = decl;
      const params = fn.params.map((p) => {
        const t = this.resolveAnnotation(p.typeAnnotation);
        if (!t) {
          throw new Error(`Codegen: invalid parameter type for '${p.name.name}'`);
        }
        return t;
      });
      const returnType =
        fn.returnType.kind === "PrimitiveType" && fn.returnType.name === "void"
          ? ("void" as const)
          : this.resolveAnnotation(fn.returnType);
      if (returnType === null) {
        throw new Error(`Codegen: invalid return type for '${fn.name.name}'`);
      }
      this.functions.set(fn.name.name, {
        name: fn.name.name,
        params,
        returnType,
      });
    }

    for (const decl of program.body) {
      if (decl.kind === "FunctionDeclaration") {
        this.emitFunction(decl);
      }
    }

    const structTypeLines = this.emitStructTypeDefs();
    const globalLines = this.emitStringGlobals();
    const declares: string[] = [];
    if (this.needsPrintf) {
      declares.push("declare i32 @printf(ptr noundef, ...) nounwind");
    }
    if (this.needsStringRuntime || this.needsArrayRuntime) {
      declares.push("declare ptr @malloc(i64 noundef) nounwind");
    }
    if (this.needsStringRuntime) {
      declares.push("declare i64 @strlen(ptr noundef) nounwind");
      declares.push("declare ptr @strcpy(ptr noundef, ptr noundef) nounwind");
      declares.push("declare ptr @strcat(ptr noundef, ptr noundef) nounwind");
    }
    if (this.needsArrayRuntime) {
      declares.push("declare ptr @realloc(ptr noundef, i64 noundef) nounwind");
    }
    if (this.needsSprintf) {
      declares.push("declare i32 @sprintf(ptr noundef, ptr noundef, ...) nounwind");
    }
    if (this.needsAbort) {
      declares.push("declare void @abort() noreturn nounwind");
    }

    return [
      "; ModuleID = 'typescript-native'",
      'source_filename = "typescript-native"',
      "",
      ...structTypeLines,
      structTypeLines.length > 0 ? "" : null,
      ...globalLines,
      globalLines.length > 0 ? "" : null,
      ...declares,
      declares.length > 0 ? "" : null,
      ...this.functionBodies,
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private registerEnum(decl: EnumDeclaration): void {
    const variants = new Map<string, number>();
    for (let i = 0; i < decl.variants.length; i += 1) {
      variants.set(decl.variants[i]!.name.name, i);
    }
    this.enums.set(decl.name.name, {
      name: decl.name.name,
      variants,
    });
  }

  private registerStruct(decl: StructDeclaration): void {
    const fields = decl.fields.map((field) => {
      const type = this.resolveAnnotation(field.typeAnnotation);
      if (!type) {
        throw new Error(`Codegen: invalid field type in struct '${decl.name.name}'`);
      }
      return { name: field.name.name, type };
    });
    this.structs.set(decl.name.name, {
      name: decl.name.name,
      fields,
    });
  }

  private namedKinds(): Map<string, "struct" | "enum"> {
    const named = new Map<string, "struct" | "enum">();
    for (const name of this.structs.keys()) {
      named.set(name, "struct");
    }
    for (const name of this.enums.keys()) {
      named.set(name, "enum");
    }
    return named;
  }

  private resolveAnnotation(ann: TypeAnnotation): ValueType | null {
    return annotationToValueType(ann, this.namedKinds());
  }

  private emitStructTypeDefs(): string[] {
    const lines: string[] = [];
    for (const info of this.structs.values()) {
      const fieldTypes = info.fields.map((f) => toLlvmType(f.type)).join(", ");
      lines.push(`%${info.name} = type { ${fieldTypes} }`);
    }
    return lines;
  }

  private emitFunction(fn: FunctionDeclaration): void {
    this.locals = new Map();
    this.tempCounter = 0;
    this.loopStack.length = 0;
    const lines: string[] = [];

    const isMain = fn.name.name === "main";
    const header = isMain ? "define i32 @main() {" : this.emitFunctionHeader(fn);

    lines.push(header);
    lines.push("entry:");

    if (!isMain) {
      for (let i = 0; i < fn.params.length; i += 1) {
        this.emitParameter(fn.params[i]!, i, lines);
      }
    }

    let terminated = false;
    for (const stmt of fn.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(stmt, lines);
    }

    if (!terminated) {
      const isVoid =
        fn.returnType.kind === "PrimitiveType" && fn.returnType.name === "void";
      if (isMain || isVoid) {
        lines.push(isMain ? "  ret i32 0" : "  ret void");
      } else {
        throw new Error(`Codegen: non-void function '${fn.name.name}' missing return`);
      }
    }

    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
  }

  private emitFunctionHeader(fn: FunctionDeclaration): string {
    const sig = this.functions.get(fn.name.name)!;
    const ret = sig.returnType === "void" ? "void" : toLlvmType(sig.returnType);
    const params = sig.params.map((t, i) => `${toLlvmType(t)} %arg${i}`).join(", ");
    return `define ${ret} @${fn.name.name}(${params}) {`;
  }

  private emitParameter(param: Parameter, index: number, lines: string[]): void {
    const type = this.resolveAnnotation(param.typeAnnotation);
    if (!type) {
      throw new Error(`Codegen: invalid parameter type`);
    }
    const llvmType = toLlvmType(type);
    const ptr = `%v.${param.name.name}`;
    lines.push(`  ${ptr} = alloca ${llvmType}`);
    lines.push(`  store ${llvmType} %arg${index}, ptr ${ptr}`);
    this.locals.set(param.name.name, { ptr, type });
  }

  /** Returns true if the statement terminates the block (return/break/continue). */
  private emitStatement(stmt: Statement, lines: string[]): boolean {
    switch (stmt.kind) {
      case "VariableDeclaration":
        this.emitVariableDeclaration(stmt, lines);
        return false;
      case "AssignmentStatement":
        this.emitAssignment(stmt, lines);
        return false;
      case "UpdateStatement":
        this.emitUpdate(stmt, lines);
        return false;
      case "ExpressionStatement":
        if (stmt.expression.kind === "CallExpression") {
          this.emitCallStatement(stmt.expression, lines);
        }
        return false;
      case "ReturnStatement":
        this.emitReturn(stmt, lines);
        return true;
      case "IfStatement":
        return this.emitIfStatement(stmt, lines);
      case "WhileStatement":
        return this.emitWhileStatement(stmt, lines);
      case "ForStatement":
        return this.emitForStatement(stmt, lines);
      case "ForInStatement":
        return this.emitForInStatement(stmt, lines);
      case "BreakStatement": {
        const loop = this.currentLoop();
        lines.push(`  br label %${loop.breakLabel}`);
        return true;
      }
      case "ContinueStatement": {
        const loop = this.currentLoop();
        lines.push(`  br label %${loop.continueLabel}`);
        return true;
      }
    }
  }

  private currentLoop(): LoopContext {
    const loop = this.loopStack[this.loopStack.length - 1];
    if (!loop) {
      throw new Error("Codegen: break/continue outside loop");
    }
    return loop;
  }

  private emitWhileStatement(stmt: WhileStatement, lines: string[]): boolean {
    const id = this.labelCounter;
    this.labelCounter += 1;
    const condLabel = `while.cond.${id}`;
    const bodyLabel = `while.body.${id}`;
    const exitLabel = `while.exit.${id}`;

    lines.push(`  br label %${condLabel}`);

    lines.push(`${condLabel}:`);
    const cond = this.emitExpression(stmt.condition, lines);
    lines.push(`  br i1 ${cond.llvm}, label %${bodyLabel}, label %${exitLabel}`);

    lines.push(`${bodyLabel}:`);
    this.loopStack.push({ continueLabel: condLabel, breakLabel: exitLabel });
    let terminated = false;
    for (const s of stmt.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    this.loopStack.pop();
    if (!terminated) {
      lines.push(`  br label %${condLabel}`);
    }

    lines.push(`${exitLabel}:`);
    return false;
  }

  private emitForStatement(stmt: ForStatement, lines: string[]): boolean {
    const id = this.labelCounter;
    this.labelCounter += 1;
    const condLabel = `for.cond.${id}`;
    const bodyLabel = `for.body.${id}`;
    const latchLabel = `for.latch.${id}`;
    const exitLabel = `for.exit.${id}`;

    if (stmt.initializer) {
      this.emitStatement(stmt.initializer, lines);
    }

    lines.push(`  br label %${condLabel}`);

    lines.push(`${condLabel}:`);
    if (stmt.condition) {
      const cond = this.emitExpression(stmt.condition, lines);
      lines.push(`  br i1 ${cond.llvm}, label %${bodyLabel}, label %${exitLabel}`);
    } else {
      lines.push(`  br label %${bodyLabel}`);
    }

    lines.push(`${bodyLabel}:`);
    this.loopStack.push({ continueLabel: latchLabel, breakLabel: exitLabel });
    let terminated = false;
    for (const s of stmt.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    this.loopStack.pop();
    if (!terminated) {
      lines.push(`  br label %${latchLabel}`);
    }

    lines.push(`${latchLabel}:`);
    if (stmt.update) {
      this.emitStatement(stmt.update, lines);
    }
    lines.push(`  br label %${condLabel}`);

    lines.push(`${exitLabel}:`);
    return false;
  }

  private emitForInStatement(stmt: ForInStatement, lines: string[]): boolean {
    const id = this.labelCounter;
    this.labelCounter += 1;
    const condLabel = `forin.cond.${id}`;
    const bodyLabel = `forin.body.${id}`;
    const latchLabel = `forin.latch.${id}`;
    const exitLabel = `forin.exit.${id}`;

    const iterable = this.emitExpression(stmt.iterable, lines);
    if (!isArrayType(iterable.type)) {
      throw new Error("Codegen: for-in over non-array");
    }

    const idxPtr = `%forin.idx.${id}`;
    lines.push(`  ${idxPtr} = alloca i32`);
    lines.push(`  store i32 0, ptr ${idxPtr}`);

    const elemType = iterable.type.element;
    const elemLlvm = toLlvmType(elemType);
    const elemPtr = `%v.${stmt.name.name}`;
    lines.push(`  ${elemPtr} = alloca ${elemLlvm}`);
    this.locals.set(stmt.name.name, { ptr: elemPtr, type: elemType });

    const length = this.emitArrayLength(iterable.llvm, lines);

    lines.push(`  br label %${condLabel}`);

    lines.push(`${condLabel}:`);
    const idxLoaded = this.nextTemp();
    lines.push(`  ${idxLoaded} = load i32, ptr ${idxPtr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp slt i32 ${idxLoaded}, ${length}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${exitLabel}`);

    lines.push(`${bodyLabel}:`);
    const idxForLoad = this.nextTemp();
    lines.push(`  ${idxForLoad} = load i32, ptr ${idxPtr}`);
    const element = this.emitArrayIndexLoad(iterable.llvm, idxForLoad, elemType, lines);
    lines.push(`  store ${elemLlvm} ${element.llvm}, ptr ${elemPtr}`);

    this.loopStack.push({ continueLabel: latchLabel, breakLabel: exitLabel });
    let terminated = false;
    for (const s of stmt.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    this.loopStack.pop();
    if (!terminated) {
      lines.push(`  br label %${latchLabel}`);
    }

    lines.push(`${latchLabel}:`);
    const idxInc = this.nextTemp();
    const idxCur = this.nextTemp();
    lines.push(`  ${idxCur} = load i32, ptr ${idxPtr}`);
    lines.push(`  ${idxInc} = add i32 ${idxCur}, 1`);
    lines.push(`  store i32 ${idxInc}, ptr ${idxPtr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${exitLabel}:`);
    this.locals.delete(stmt.name.name);
    return false;
  }

  private emitIfStatement(stmt: IfStatement, lines: string[]): boolean {
    const id = this.labelCounter;
    this.labelCounter += 1;
    const thenLabel = `then.${id}`;
    const elseLabel = `else.${id}`;
    const mergeLabel = `merge.${id}`;

    const cond = this.emitExpression(stmt.condition, lines);
    const hasElse = stmt.alternate !== null;
    lines.push(
      `  br i1 ${cond.llvm}, label %${thenLabel}, label %${hasElse ? elseLabel : mergeLabel}`,
    );

    lines.push(`${thenLabel}:`);
    let thenTerminated = false;
    for (const s of stmt.consequent) {
      if (thenTerminated) {
        break;
      }
      thenTerminated = this.emitStatement(s, lines);
    }
    if (!thenTerminated) {
      lines.push(`  br label %${mergeLabel}`);
    }

    let elseTerminated = false;
    if (hasElse) {
      lines.push(`${elseLabel}:`);
      if (Array.isArray(stmt.alternate)) {
        for (const s of stmt.alternate) {
          if (elseTerminated) {
            break;
          }
          elseTerminated = this.emitStatement(s, lines);
        }
      } else if (stmt.alternate) {
        elseTerminated = this.emitIfStatement(stmt.alternate, lines);
      }
      if (!elseTerminated) {
        lines.push(`  br label %${mergeLabel}`);
      }
    }

    const bothTerminated = thenTerminated && elseTerminated && hasElse;
    if (!bothTerminated) {
      lines.push(`${mergeLabel}:`);
    }
    return bothTerminated;
  }

  private emitVariableDeclaration(stmt: VariableDeclaration, lines: string[]): void {
    const type = this.resolveDeclType(stmt);
    const llvmType = toLlvmType(type);
    const ptr = `%v.${stmt.name.name}`;
    lines.push(`  ${ptr} = alloca ${llvmType}`);
    this.locals.set(stmt.name.name, { ptr, type });

    const init = this.emitExpression(stmt.initializer, lines, type);
    lines.push(`  store ${llvmType} ${init.llvm}, ptr ${ptr}`);
  }

  private emitAssignment(stmt: AssignmentStatement, lines: string[]): void {
    if (stmt.target.kind === "Identifier") {
      const local = this.locals.get(stmt.target.name);
      if (!local) {
        throw new Error(`Codegen: unknown variable '${stmt.target.name}'`);
      }
      const llvmType = toLlvmType(local.type);

      if (stmt.operator === "=") {
        const value = this.emitExpression(stmt.value, lines, local.type);
        lines.push(`  store ${llvmType} ${value.llvm}, ptr ${local.ptr}`);
        return;
      }

      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${llvmType}, ptr ${local.ptr}`);
      const rhs = this.emitExpression(stmt.value, lines, local.type);
      const result = this.nextTemp();
      const isFloat = local.type === "f32" || local.type === "f64";
      const opcode =
        stmt.operator === "+="
          ? isFloat
            ? "fadd"
            : "add"
          : isFloat
            ? "fsub"
            : "sub";
      lines.push(`  ${result} = ${opcode} ${llvmType} ${loaded}, ${rhs.llvm}`);
      lines.push(`  store ${llvmType} ${result}, ptr ${local.ptr}`);
      return;
    }

    if (stmt.target.kind === "MemberExpression") {
      const fieldPtr = this.emitMemberFieldPtr(stmt.target, lines);
      const fieldType = this.inferExpressionType(stmt.target);
      const elemLlvm = toLlvmType(fieldType);

      if (stmt.operator === "=") {
        const value = this.emitExpression(stmt.value, lines, fieldType);
        lines.push(`  store ${elemLlvm} ${value.llvm}, ptr ${fieldPtr}`);
        return;
      }

      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${elemLlvm}, ptr ${fieldPtr}`);
      const rhs = this.emitExpression(stmt.value, lines, fieldType);
      const result = this.nextTemp();
      const isFloat = fieldType === "f32" || fieldType === "f64";
      const opcode =
        stmt.operator === "+="
          ? isFloat
            ? "fadd"
            : "add"
          : isFloat
            ? "fsub"
            : "sub";
      lines.push(`  ${result} = ${opcode} ${elemLlvm} ${loaded}, ${rhs.llvm}`);
      lines.push(`  store ${elemLlvm} ${result}, ptr ${fieldPtr}`);
      return;
    }

    // Index assignment
    const object = this.emitExpression(stmt.target.object, lines);
    if (!isArrayType(object.type)) {
      throw new Error("Codegen: index assign on non-array");
    }
    const index = this.emitExpression(stmt.target.index, lines);
    const indexI32 = this.asI32Index(index, lines);
    const elemType = object.type.element;
    const elemLlvm = toLlvmType(elemType);
    const elemPtr = this.emitArrayElementPtr(object.llvm, indexI32, elemType, lines);

    if (stmt.operator === "=") {
      const value = this.emitExpression(stmt.value, lines, elemType);
      lines.push(`  store ${elemLlvm} ${value.llvm}, ptr ${elemPtr}`);
      return;
    }

    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${elemLlvm}, ptr ${elemPtr}`);
    const rhs = this.emitExpression(stmt.value, lines, elemType);
    const result = this.nextTemp();
    const isFloat = elemType === "f32" || elemType === "f64";
    const opcode =
      stmt.operator === "+="
        ? isFloat
          ? "fadd"
          : "add"
        : isFloat
          ? "fsub"
          : "sub";
    lines.push(`  ${result} = ${opcode} ${elemLlvm} ${loaded}, ${rhs.llvm}`);
    lines.push(`  store ${elemLlvm} ${result}, ptr ${elemPtr}`);
  }

  private emitUpdate(stmt: UpdateStatement, lines: string[]): void {
    const local = this.locals.get(stmt.name.name);
    if (!local) {
      throw new Error(`Codegen: unknown variable '${stmt.name.name}'`);
    }
    const llvmType = toLlvmType(local.type);
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${llvmType}, ptr ${local.ptr}`);
    const result = this.nextTemp();
    const isFloat = local.type === "f32" || local.type === "f64";
    const one = typedOne(local.type);
    if (stmt.operator === "++") {
      const opcode = isFloat ? "fadd" : "add";
      lines.push(`  ${result} = ${opcode} ${llvmType} ${loaded}, ${one}`);
    } else {
      const opcode = isFloat ? "fsub" : "sub";
      lines.push(`  ${result} = ${opcode} ${llvmType} ${loaded}, ${one}`);
    }
    lines.push(`  store ${llvmType} ${result}, ptr ${local.ptr}`);
  }

  private emitReturn(stmt: ReturnStatement, lines: string[]): void {
    if (stmt.value === null) {
      lines.push("  ret void");
      return;
    }
    const value = this.emitExpression(stmt.value, lines);
    lines.push(`  ret ${toLlvmType(value.type)} ${value.llvm}`);
  }

  private emitCallStatement(call: CallExpression, lines: string[]): void {
    if (call.callee.kind === "MemberExpression") {
      this.emitMethodCall(call, lines, true);
      return;
    }
    if (call.callee.name === "print") {
      this.emitPrintCall(call, lines);
      return;
    }
    this.emitUserCall(call, lines, true);
  }

  private resolveDeclType(stmt: VariableDeclaration): ValueType {
    if (stmt.typeAnnotation) {
      const annotated = this.resolveAnnotation(stmt.typeAnnotation);
      if (annotated) {
        return annotated;
      }
    }
    return this.inferExpressionType(stmt.initializer);
  }

  private inferExpressionType(expr: Expression): ValueType {
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
      case "ArrayLiteral": {
        if (expr.elements.length === 0) {
          throw new Error("Codegen: empty array without annotation");
        }
        return { kind: "array", element: this.inferExpressionType(expr.elements[0]!) };
      }
      case "StructLiteral":
        return { kind: "struct", name: expr.name.name };
      case "IndexExpression": {
        const objectType = this.inferExpressionType(expr.object);
        if (!isArrayType(objectType)) {
          throw new Error("Codegen: index into non-array");
        }
        return objectType.element;
      }
      case "MemberExpression": {
        if (
          expr.object.kind === "Identifier" &&
          this.enums.has(expr.object.name) &&
          !this.locals.has(expr.object.name)
        ) {
          return { kind: "enum", name: expr.object.name };
        }
        const objectType = this.inferExpressionType(expr.object);
        if (isStructType(objectType)) {
          const def = this.structs.get(objectType.name);
          if (!def) {
            throw new Error(`Codegen: unknown struct '${objectType.name}'`);
          }
          const field = def.fields.find((f) => f.name === expr.property.name);
          if (!field) {
            throw new Error(`Codegen: unknown field '${expr.property.name}'`);
          }
          return field.type;
        }
        if (expr.property.name === "length") {
          return "i32";
        }
        throw new Error(`Codegen: unknown property '${expr.property.name}'`);
      }
      case "Identifier": {
        const local = this.locals.get(expr.name);
        if (!local) {
          throw new Error(`Codegen: unknown variable '${expr.name}'`);
        }
        return local.type;
      }
      case "UnaryExpression":
        if (expr.operator === "!") {
          return "bool";
        }
        return this.inferExpressionType(expr.operand);
      case "BinaryExpression": {
        if (COMPARISON_OPS.has(expr.operator) || LOGICAL_OPS.has(expr.operator)) {
          return "bool";
        }
        if (expr.operator === "+") {
          const left = this.inferExpressionType(expr.left);
          if (left === "string") {
            return "string";
          }
          return left;
        }
        return this.inferExpressionType(expr.left);
      }
      case "CallExpression": {
        if (expr.callee.kind === "MemberExpression") {
          const method = expr.callee.property.name;
          const objectType = this.inferExpressionType(expr.callee.object);
          if (!isArrayType(objectType)) {
            throw new Error("Codegen: method on non-array");
          }
          if (method === "pop") {
            return objectType.element;
          }
          if (method === "includes") {
            return "bool";
          }
          if (method === "indexOf") {
            return "i32";
          }
          throw new Error(`Codegen: unexpected method '${method}' in inference`);
        }
        const sig = this.functions.get(expr.callee.name);
        if (!sig || sig.returnType === "void") {
          throw new Error(`Codegen: unexpected call in type inference '${expr.callee.name}'`);
        }
        return sig.returnType;
      }
    }
  }

  private emitExpression(expr: Expression, lines: string[], expected?: ValueType): EmittedValue {
    switch (expr.kind) {
      case "IntegerLiteral": {
        const type: ValueType = expected === "i64" ? "i64" : "i32";
        return { llvm: String(expr.value), type };
      }
      case "FloatLiteral": {
        const type: ValueType = expected === "f32" ? "f32" : "f64";
        return { llvm: formatFloat(expr.value, type), type };
      }
      case "BooleanLiteral":
        return { llvm: expr.value ? "true" : "false", type: "bool" };
      case "CharLiteral": {
        const code = expr.value.codePointAt(0) ?? 0;
        return { llvm: String(code), type: "char" };
      }
      case "StringLiteral": {
        const global = this.internString(expr.value);
        const tmp = this.nextTemp();
        lines.push(
          `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
        );
        return { llvm: tmp, type: "string" };
      }
      case "ArrayLiteral":
        return this.emitArrayLiteral(expr.elements, lines, expected);
      case "StructLiteral":
        return this.emitStructLiteral(expr, lines);
      case "IndexExpression": {
        const object = this.emitExpression(expr.object, lines);
        if (!isArrayType(object.type)) {
          throw new Error("Codegen: index into non-array");
        }
        const index = this.emitExpression(expr.index, lines);
        const indexI32 = this.asI32Index(index, lines);
        return this.emitArrayIndexLoad(object.llvm, indexI32, object.type.element, lines);
      }
      case "MemberExpression": {
        if (
          expr.object.kind === "Identifier" &&
          this.enums.has(expr.object.name) &&
          !this.locals.has(expr.object.name)
        ) {
          const def = this.enums.get(expr.object.name)!;
          const discriminant = def.variants.get(expr.property.name);
          if (discriminant === undefined) {
            throw new Error(`Codegen: unknown variant '${expr.property.name}'`);
          }
          const type: EnumValueType = { kind: "enum", name: def.name };
          return { llvm: String(discriminant), type };
        }
        const objectType = this.inferExpressionType(expr.object);
        if (isStructType(objectType)) {
          return this.emitStructFieldLoad(expr, lines);
        }
        if (expr.property.name !== "length") {
          throw new Error(`Codegen: unknown property '${expr.property.name}'`);
        }
        const object = this.emitExpression(expr.object, lines);
        if (!isArrayType(object.type)) {
          throw new Error("Codegen: .length on non-array");
        }
        const length = this.emitArrayLength(object.llvm, lines);
        return { llvm: length, type: "i32" };
      }
      case "Identifier": {
        const local = this.locals.get(expr.name);
        if (!local) {
          throw new Error(`Codegen: unknown variable '${expr.name}'`);
        }
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ${toLlvmType(local.type)}, ptr ${local.ptr}`);
        return { llvm: tmp, type: local.type };
      }
      case "UnaryExpression":
        return this.emitUnary(expr, lines);
      case "BinaryExpression":
        return this.emitBinary(expr, lines);
      case "CallExpression":
        if (expr.callee.kind === "MemberExpression") {
          return this.emitMethodCall(expr, lines, false);
        }
        return this.emitUserCall(expr, lines, false);
    }
  }

  private emitStructLiteral(expr: StructLiteral, lines: string[]): EmittedValue {
    const def = this.structs.get(expr.name.name);
    if (!def) {
      throw new Error(`Codegen: unknown struct '${expr.name.name}'`);
    }
    const structType: StructValueType = { kind: "struct", name: def.name };
    const llvmType = toLlvmType(structType);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${llvmType}`);

    const inits = new Map(expr.fields.map((f) => [f.name.name, f.value]));
    for (let i = 0; i < def.fields.length; i += 1) {
      const field = def.fields[i]!;
      const initExpr = inits.get(field.name);
      if (!initExpr) {
        throw new Error(`Codegen: missing field '${field.name}' in struct literal`);
      }
      const value = this.emitExpression(initExpr, lines, field.type);
      const fieldPtr = this.emitStructFieldPtr(tmp, def.name, i, lines);
      lines.push(`  store ${toLlvmType(field.type)} ${value.llvm}, ptr ${fieldPtr}`);
    }

    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${llvmType}, ptr ${tmp}`);
    return { llvm: loaded, type: structType };
  }

  private emitStructFieldLoad(expr: MemberExpression, lines: string[]): EmittedValue {
    const fieldPtr = this.emitMemberFieldPtr(expr, lines);
    const fieldType = this.inferExpressionType(expr);
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${toLlvmType(fieldType)}, ptr ${fieldPtr}`);
    return { llvm: loaded, type: fieldType };
  }

  /** Address of the field referenced by a MemberExpression (supports nested a.b.c). */
  private emitMemberFieldPtr(expr: MemberExpression, lines: string[]): string {
    const objectType = this.inferExpressionType(expr.object);
    if (!isStructType(objectType)) {
      throw new Error("Codegen: member field on non-struct");
    }
    const structPtr = this.emitStructAddress(expr.object, objectType, lines);
    const def = this.structs.get(objectType.name);
    if (!def) {
      throw new Error(`Codegen: unknown struct '${objectType.name}'`);
    }
    const fieldIndex = def.fields.findIndex((f) => f.name === expr.property.name);
    if (fieldIndex < 0) {
      throw new Error(`Codegen: unknown field '${expr.property.name}'`);
    }
    return this.emitStructFieldPtr(structPtr, objectType.name, fieldIndex, lines);
  }

  /** Pointer to a struct value in memory (local alloca, nested field, or temp). */
  private emitStructAddress(
    expr: Expression,
    expected: StructValueType,
    lines: string[],
  ): string {
    if (expr.kind === "Identifier") {
      const local = this.locals.get(expr.name);
      if (!local || !isStructType(local.type)) {
        throw new Error(`Codegen: expected struct local '${expr.name}'`);
      }
      return local.ptr;
    }

    if (expr.kind === "MemberExpression") {
      const objectType = this.inferExpressionType(expr.object);
      if (!isStructType(objectType)) {
        throw new Error("Codegen: nested member on non-struct");
      }
      const parentPtr = this.emitStructAddress(expr.object, objectType, lines);
      const def = this.structs.get(objectType.name);
      if (!def) {
        throw new Error(`Codegen: unknown struct '${objectType.name}'`);
      }
      const fieldIndex = def.fields.findIndex((f) => f.name === expr.property.name);
      if (fieldIndex < 0) {
        throw new Error(`Codegen: unknown field '${expr.property.name}'`);
      }
      const fieldType = def.fields[fieldIndex]!.type;
      if (!isStructType(fieldType) || fieldType.name !== expected.name) {
        throw new Error("Codegen: nested field is not the expected struct");
      }
      return this.emitStructFieldPtr(parentPtr, objectType.name, fieldIndex, lines);
    }

    const value = this.emitExpression(expr, lines, expected);
    if (!isStructType(value.type)) {
      throw new Error("Codegen: expected struct value");
    }
    const tmp = this.nextTemp();
    const llvmType = toLlvmType(value.type);
    lines.push(`  ${tmp} = alloca ${llvmType}`);
    lines.push(`  store ${llvmType} ${value.llvm}, ptr ${tmp}`);
    return tmp;
  }

  private emitStructFieldPtr(
    structPtr: string,
    structName: string,
    fieldIndex: number,
    lines: string[],
  ): string {
    const fieldPtr = this.nextTemp();
    lines.push(
      `  ${fieldPtr} = getelementptr inbounds %${structName}, ptr ${structPtr}, i32 0, i32 ${fieldIndex}`,
    );
    return fieldPtr;
  }

  private emitArrayLiteral(
    elements: Expression[],
    lines: string[],
    expected?: ValueType,
  ): EmittedValue {
    this.needsArrayRuntime = true;

    let elementType: ValueType;
    if (expected && isArrayType(expected)) {
      elementType = expected.element;
    } else if (elements.length > 0) {
      elementType = this.inferExpressionType(elements[0]!);
      // Prefer expected element width from first literal if annotated later
      if (expected && isArrayType(expected)) {
        elementType = expected.element;
      }
    } else if (expected && isArrayType(expected)) {
      elementType = expected.element;
    } else {
      throw new Error("Codegen: cannot infer empty array type");
    }

    const length = elements.length;
    const capacity = Math.max(length, 4);
    const header = this.nextTemp();
    lines.push(`  ${header} = call ptr @malloc(i64 noundef ${ARRAY_HEADER_SIZE})`);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr inbounds i8, ptr ${header}, i64 0`);
    lines.push(`  store i64 ${length}, ptr ${lenPtr}`);

    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr inbounds i8, ptr ${header}, i64 8`);
    lines.push(`  store i64 ${capacity}, ptr ${capPtr}`);

    const elemSize = elementByteSize(elementType, this.structs);
    const dataBytes = capacity * elemSize;
    const data = this.nextTemp();
    lines.push(`  ${data} = call ptr @malloc(i64 noundef ${dataBytes})`);

    const dataField = this.nextTemp();
    lines.push(`  ${dataField} = getelementptr inbounds i8, ptr ${header}, i64 16`);
    lines.push(`  store ptr ${data}, ptr ${dataField}`);

    const elemLlvm = toLlvmType(elementType);
    for (let i = 0; i < elements.length; i += 1) {
      const value = this.emitExpression(elements[i]!, lines, elementType);
      const slot = this.nextTemp();
      lines.push(
        `  ${slot} = getelementptr inbounds ${elemLlvm}, ptr ${data}, i64 ${i}`,
      );
      lines.push(`  store ${elemLlvm} ${value.llvm}, ptr ${slot}`);
    }

    return { llvm: header, type: { kind: "array", element: elementType } };
  }

  private emitArrayLength(header: string, lines: string[]): string {
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr inbounds i8, ptr ${header}, i64 0`);
    const len64 = this.nextTemp();
    lines.push(`  ${len64} = load i64, ptr ${lenPtr}`);
    const len32 = this.nextTemp();
    lines.push(`  ${len32} = trunc i64 ${len64} to i32`);
    return len32;
  }

  private emitArrayElementPtr(
    header: string,
    indexI32: string,
    elementType: ValueType,
    lines: string[],
  ): string {
    const dataField = this.nextTemp();
    lines.push(`  ${dataField} = getelementptr inbounds i8, ptr ${header}, i64 16`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataField}`);
    const index64 = this.nextTemp();
    lines.push(`  ${index64} = sext i32 ${indexI32} to i64`);
    const slot = this.nextTemp();
    const elemLlvm = toLlvmType(elementType);
    lines.push(
      `  ${slot} = getelementptr inbounds ${elemLlvm}, ptr ${data}, i64 ${index64}`,
    );
    return slot;
  }

  private emitArrayIndexLoad(
    header: string,
    indexI32: string,
    elementType: ValueType,
    lines: string[],
  ): EmittedValue {
    const slot = this.emitArrayElementPtr(header, indexI32, elementType, lines);
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${toLlvmType(elementType)}, ptr ${slot}`);
    return { llvm: loaded, type: elementType };
  }

  private asI32Index(index: EmittedValue, lines: string[]): string {
    if (index.type === "i32") {
      return index.llvm;
    }
    if (index.type === "i64") {
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = trunc i64 ${index.llvm} to i32`);
      return tmp;
    }
    throw new Error(`Codegen: invalid index type '${index.type}'`);
  }

  private emitMethodCall(
    call: CallExpression,
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    if (call.callee.kind !== "MemberExpression") {
      throw new Error("Codegen: expected method call");
    }

    const object = this.emitExpression(call.callee.object, lines);
    if (!isArrayType(object.type)) {
      throw new Error("Codegen: method on non-array");
    }

    const method = call.callee.property.name;
    const elementType = object.type.element;

    switch (method) {
      case "push":
        this.emitArrayPush(object.llvm, call.args[0]!, elementType, lines);
        if (!asStatement) {
          throw new Error("Codegen: push used as value");
        }
        return { llvm: "void", type: "i32" };
      case "pop":
        return this.emitArrayPop(object.llvm, elementType, lines);
      case "includes":
        return this.emitArrayIncludes(object.llvm, call.args[0]!, elementType, lines);
      case "indexOf":
        return this.emitArrayIndexOf(object.llvm, call.args[0]!, elementType, lines);
      default:
        throw new Error(`Codegen: unknown method '${method}'`);
    }
  }

  private emitArrayPush(
    header: string,
    arg: Expression,
    elementType: ValueType,
    lines: string[],
  ): void {
    this.needsArrayRuntime = true;
    const id = this.labelCounter;
    this.labelCounter += 1;
    const growLabel = `arr.grow.${id}`;
    const storeLabel = `arr.store.${id}`;

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr inbounds i8, ptr ${header}, i64 0`);
    const length = this.nextTemp();
    lines.push(`  ${length} = load i64, ptr ${lenPtr}`);

    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr inbounds i8, ptr ${header}, i64 8`);
    const capacity = this.nextTemp();
    lines.push(`  ${capacity} = load i64, ptr ${capPtr}`);

    const needGrow = this.nextTemp();
    lines.push(`  ${needGrow} = icmp eq i64 ${length}, ${capacity}`);
    lines.push(`  br i1 ${needGrow}, label %${growLabel}, label %${storeLabel}`);

    lines.push(`${growLabel}:`);
    const newCap = this.nextTemp();
    // capacity == 0 → 4, else capacity * 2
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${capacity}, 0`);
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${capacity}, 2`);
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 4, i64 ${doubled}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);

    const dataField = this.nextTemp();
    lines.push(`  ${dataField} = getelementptr inbounds i8, ptr ${header}, i64 16`);
    const oldData = this.nextTemp();
    lines.push(`  ${oldData} = load ptr, ptr ${dataField}`);
    const elemSize = elementByteSize(elementType, this.structs);
    const bytes = this.nextTemp();
    lines.push(`  ${bytes} = mul i64 ${newCap}, ${elemSize}`);
    const newData = this.nextTemp();
    lines.push(`  ${newData} = call ptr @realloc(ptr noundef ${oldData}, i64 noundef ${bytes})`);
    lines.push(`  store ptr ${newData}, ptr ${dataField}`);
    lines.push(`  br label %${storeLabel}`);

    lines.push(`${storeLabel}:`);
    const dataField2 = this.nextTemp();
    lines.push(`  ${dataField2} = getelementptr inbounds i8, ptr ${header}, i64 16`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataField2}`);
    const len2 = this.nextTemp();
    lines.push(`  ${len2} = load i64, ptr ${lenPtr}`);
    const slot = this.nextTemp();
    const elemLlvm = toLlvmType(elementType);
    lines.push(
      `  ${slot} = getelementptr inbounds ${elemLlvm}, ptr ${data}, i64 ${len2}`,
    );
    const value = this.emitExpression(arg, lines, elementType);
    lines.push(`  store ${elemLlvm} ${value.llvm}, ptr ${slot}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${len2}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
  }

  private emitArrayPop(header: string, elementType: ValueType, lines: string[]): EmittedValue {
    this.needsAbort = true;
    const id = this.labelCounter;
    this.labelCounter += 1;
    const emptyLabel = `arr.pop.empty.${id}`;
    const okLabel = `arr.pop.ok.${id}`;

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr inbounds i8, ptr ${header}, i64 0`);
    const length = this.nextTemp();
    lines.push(`  ${length} = load i64, ptr ${lenPtr}`);
    const isEmpty = this.nextTemp();
    lines.push(`  ${isEmpty} = icmp eq i64 ${length}, 0`);
    lines.push(`  br i1 ${isEmpty}, label %${emptyLabel}, label %${okLabel}`);

    lines.push(`${emptyLabel}:`);
    lines.push(`  call void @abort()`);
    lines.push(`  unreachable`);

    lines.push(`${okLabel}:`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = sub i64 ${length}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    const dataField = this.nextTemp();
    lines.push(`  ${dataField} = getelementptr inbounds i8, ptr ${header}, i64 16`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataField}`);
    const slot = this.nextTemp();
    const elemLlvm = toLlvmType(elementType);
    lines.push(
      `  ${slot} = getelementptr inbounds ${elemLlvm}, ptr ${data}, i64 ${newLen}`,
    );
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${elemLlvm}, ptr ${slot}`);
    return { llvm: loaded, type: elementType };
  }

  private emitArrayIncludes(
    header: string,
    arg: Expression,
    elementType: ValueType,
    lines: string[],
  ): EmittedValue {
    const index = this.emitArrayIndexOf(header, arg, elementType, lines);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp sge i32 ${index.llvm}, 0`);
    return { llvm: cmp, type: "bool" };
  }

  private emitArrayIndexOf(
    header: string,
    arg: Expression,
    elementType: ValueType,
    lines: string[],
  ): EmittedValue {
    const id = this.labelCounter;
    this.labelCounter += 1;
    const condLabel = `arr.idx.cond.${id}`;
    const bodyLabel = `arr.idx.body.${id}`;
    const foundLabel = `arr.idx.found.${id}`;
    const latchLabel = `arr.idx.latch.${id}`;
    const exitLabel = `arr.idx.exit.${id}`;

    const needle = this.emitExpression(arg, lines, elementType);
    const length = this.emitArrayLength(header, lines);

    const idxPtr = `%arr.scan.idx.${id}`;
    const resultPtr = `%arr.scan.res.${id}`;
    lines.push(`  ${idxPtr} = alloca i32`);
    lines.push(`  ${resultPtr} = alloca i32`);
    lines.push(`  store i32 0, ptr ${idxPtr}`);
    lines.push(`  store i32 -1, ptr ${resultPtr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${condLabel}:`);
    const idx = this.nextTemp();
    lines.push(`  ${idx} = load i32, ptr ${idxPtr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp slt i32 ${idx}, ${length}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${exitLabel}`);

    lines.push(`${bodyLabel}:`);
    const elem = this.emitArrayIndexLoad(header, idx, elementType, lines);
    const eq = this.nextTemp();
    const llvmType = toLlvmType(elementType);
    const isFloat = elementType === "f32" || elementType === "f64";
    const pred = isFloat ? "oeq" : "eq";
    const cmpOp = isFloat ? "fcmp" : "icmp";
    lines.push(
      `  ${eq} = ${cmpOp} ${pred} ${llvmType} ${elem.llvm}, ${needle.llvm}`,
    );
    lines.push(`  br i1 ${eq}, label %${foundLabel}, label %${latchLabel}`);

    lines.push(`${foundLabel}:`);
    lines.push(`  store i32 ${idx}, ptr ${resultPtr}`);
    lines.push(`  br label %${exitLabel}`);

    lines.push(`${latchLabel}:`);
    const next = this.nextTemp();
    lines.push(`  ${next} = add i32 ${idx}, 1`);
    lines.push(`  store i32 ${next}, ptr ${idxPtr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${exitLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load i32, ptr ${resultPtr}`);
    return { llvm: result, type: "i32" };
  }

  private emitUnary(expr: UnaryExpression, lines: string[]): EmittedValue {
    const operand = this.emitExpression(expr.operand, lines);
    const tmp = this.nextTemp();
    if (expr.operator === "!") {
      lines.push(`  ${tmp} = xor i1 ${operand.llvm}, true`);
      return { llvm: tmp, type: "bool" };
    }
    const llvmType = toLlvmType(operand.type);
    if (operand.type === "f32" || operand.type === "f64") {
      lines.push(`  ${tmp} = fneg ${llvmType} ${operand.llvm}`);
    } else {
      lines.push(`  ${tmp} = sub ${llvmType} 0, ${operand.llvm}`);
    }
    return { llvm: tmp, type: operand.type };
  }

  private emitBinary(expr: BinaryExpression, lines: string[]): EmittedValue {
    if (expr.operator === "+") {
      const leftType = this.inferExpressionType(expr.left);
      if (leftType === "string") {
        return this.emitStringConcat(expr, lines);
      }
    }

    const left = this.emitExpression(expr.left, lines);
    const right = this.emitExpression(expr.right, lines, left.type);
    const llvmType = toLlvmType(left.type);
    const tmp = this.nextTemp();

    if (expr.operator === "&&") {
      lines.push(`  ${tmp} = and i1 ${left.llvm}, ${right.llvm}`);
      return { llvm: tmp, type: "bool" };
    }
    if (expr.operator === "||") {
      lines.push(`  ${tmp} = or i1 ${left.llvm}, ${right.llvm}`);
      return { llvm: tmp, type: "bool" };
    }

    if (COMPARISON_OPS.has(expr.operator)) {
      const pred = comparisonPredicate(expr.operator, left.type);
      const isFloat = left.type === "f32" || left.type === "f64";
      const cmp = isFloat ? "fcmp" : "icmp";
      lines.push(`  ${tmp} = ${cmp} ${pred} ${llvmType} ${left.llvm}, ${right.llvm}`);
      return { llvm: tmp, type: "bool" };
    }

    const isFloat = left.type === "f32" || left.type === "f64";
    let opcode: string;
    switch (expr.operator) {
      case "+":
        opcode = isFloat ? "fadd" : "add";
        break;
      case "-":
        opcode = isFloat ? "fsub" : "sub";
        break;
      case "*":
        opcode = isFloat ? "fmul" : "mul";
        break;
      case "/":
        opcode = isFloat ? "fdiv" : "sdiv";
        break;
      case "%":
        opcode = isFloat ? "frem" : "srem";
        break;
      default:
        throw new Error(`Codegen: unexpected arithmetic operator '${expr.operator}'`);
    }

    lines.push(`  ${tmp} = ${opcode} ${llvmType} ${left.llvm}, ${right.llvm}`);
    return { llvm: tmp, type: left.type };
  }

  private emitStringConcat(expr: BinaryExpression, lines: string[]): EmittedValue {
    if (expr.left.kind === "StringLiteral" && expr.right.kind === "StringLiteral") {
      const folded = expr.left.value + expr.right.value;
      const global = this.internString(folded);
      const tmp = this.nextTemp();
      lines.push(
        `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
      );
      return { llvm: tmp, type: "string" };
    }

    this.needsStringRuntime = true;
    const left = this.emitExpression(expr.left, lines);
    const right = this.emitExpression(expr.right, lines);

    const leftLen = this.nextTemp();
    const rightLen = this.nextTemp();
    const total = this.nextTemp();
    const buf = this.nextTemp();

    lines.push(`  ${leftLen} = call i64 @strlen(ptr noundef ${left.llvm})`);
    lines.push(`  ${rightLen} = call i64 @strlen(ptr noundef ${right.llvm})`);
    lines.push(`  ${total} = add i64 ${leftLen}, ${rightLen}`);
    const totalPlus = this.nextTemp();
    lines.push(`  ${totalPlus} = add i64 ${total}, 1`);
    lines.push(`  ${buf} = call ptr @malloc(i64 noundef ${totalPlus})`);
    lines.push(`  call ptr @strcpy(ptr noundef ${buf}, ptr noundef ${left.llvm})`);
    lines.push(`  call ptr @strcat(ptr noundef ${buf}, ptr noundef ${right.llvm})`);

    return { llvm: buf, type: "string" };
  }

  private emitUserCall(
    call: CallExpression,
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    if (call.callee.kind !== "Identifier") {
      throw new Error("Codegen: expected identifier callee");
    }
    const sig = this.functions.get(call.callee.name);
    if (!sig) {
      throw new Error(`Codegen: unknown function '${call.callee.name}'`);
    }

    const args: EmittedValue[] = [];
    for (let i = 0; i < call.args.length; i += 1) {
      args.push(this.emitExpression(call.args[i]!, lines, sig.params[i]));
    }

    const argList = args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`).join(", ");
    const argSuffix = argList ? argList : "";

    if (sig.returnType === "void") {
      lines.push(`  call void @${sig.name}(${argSuffix})`);
      if (!asStatement) {
        throw new Error(`Codegen: void call '${sig.name}' used as value`);
      }
      return { llvm: "void", type: "i32" };
    }

    const tmp = this.nextTemp();
    const retTy = toLlvmType(sig.returnType);
    lines.push(`  ${tmp} = call ${retTy} @${sig.name}(${argSuffix})`);
    return { llvm: tmp, type: sig.returnType };
  }

  private emitPrintCall(call: CallExpression, lines: string[]): void {
    this.needsPrintf = true;

    const emittedArgs: EmittedValue[] = [];
    const formatParts: string[] = [];

    for (const arg of call.args) {
      const value = this.emitExpression(arg, lines);
      if (value.type === "bool") {
        const boolStr = this.emitBoolToString(value.llvm, lines);
        emittedArgs.push({ llvm: boolStr, type: "string" });
        formatParts.push("%s");
      } else if (isArrayType(value.type)) {
        const arrayStr = this.emitArrayToString(value.llvm, value.type.element, lines);
        emittedArgs.push({ llvm: arrayStr, type: "string" });
        formatParts.push("%s");
      } else {
        emittedArgs.push(value);
        formatParts.push(printfSpecifier(value.type));
      }
    }

    const format = `${formatParts.join(" ")}\n`;
    const formatGlobal = this.internString(format);
    const formatPtr = this.nextTemp();
    lines.push(
      `  ${formatPtr} = getelementptr inbounds [${formatGlobal.length} x i8], ptr @${formatGlobal.name}, i64 0, i64 0`,
    );

    const argList = emittedArgs
      .map((arg) => {
        if (arg.type === "f32") {
          const widened = this.nextTemp();
          lines.push(`  ${widened} = fpext float ${arg.llvm} to double`);
          return `double ${widened}`;
        }
        return `${printfArgType(arg.type)} ${arg.llvm}`;
      })
      .join(", ");

    lines.push(
      `  call i32 (ptr, ...) @printf(ptr noundef ${formatPtr}${argList ? `, ${argList}` : ""})`,
    );
  }

  /** Build a heap string like `[1, 2, 3]` (recursive for nested arrays). */
  private emitArrayToString(header: string, elementType: ValueType, lines: string[]): string {
    this.needsStringRuntime = true;
    this.needsArrayRuntime = true;

    const id = this.labelCounter;
    this.labelCounter += 1;
    const condLabel = `arr.str.cond.${id}`;
    const bodyLabel = `arr.str.body.${id}`;
    const latchLabel = `arr.str.latch.${id}`;
    const exitLabel = `arr.str.exit.${id}`;

    const bufPtr = `%arr.str.buf.${id}`;
    const capPtr = `%arr.str.cap.${id}`;
    const lenPtr = `%arr.str.len.${id}`;
    const idxPtr = `%arr.str.idx.${id}`;

    lines.push(`  ${bufPtr} = alloca ptr`);
    lines.push(`  ${capPtr} = alloca i64`);
    lines.push(`  ${lenPtr} = alloca i64`);
    lines.push(`  ${idxPtr} = alloca i32`);

    const initial = this.nextTemp();
    lines.push(`  ${initial} = call ptr @malloc(i64 noundef 64)`);
    lines.push(`  store i8 0, ptr ${initial}`);
    lines.push(`  store ptr ${initial}, ptr ${bufPtr}`);
    lines.push(`  store i64 64, ptr ${capPtr}`);
    lines.push(`  store i64 0, ptr ${lenPtr}`);
    lines.push(`  store i32 0, ptr ${idxPtr}`);

    this.emitAppendLiteral(bufPtr, capPtr, lenPtr, "[", lines);

    const length = this.emitArrayLength(header, lines);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${condLabel}:`);
    const idx = this.nextTemp();
    lines.push(`  ${idx} = load i32, ptr ${idxPtr}`);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp slt i32 ${idx}, ${length}`);
    lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${exitLabel}`);

    lines.push(`${bodyLabel}:`);
    const sepLabel = `arr.str.sep.${id}`;
    const elemLabel = `arr.str.elem.${id}`;
    const isFirst = this.nextTemp();
    lines.push(`  ${isFirst} = icmp eq i32 ${idx}, 0`);
    lines.push(`  br i1 ${isFirst}, label %${elemLabel}, label %${sepLabel}`);

    lines.push(`${sepLabel}:`);
    this.emitAppendLiteral(bufPtr, capPtr, lenPtr, ", ", lines);
    lines.push(`  br label %${elemLabel}`);

    lines.push(`${elemLabel}:`);
    const elem = this.emitArrayIndexLoad(header, idx, elementType, lines);
    const elemStr = this.emitValueToString(elem, lines);
    this.emitAppendString(bufPtr, capPtr, lenPtr, elemStr, lines);
    lines.push(`  br label %${latchLabel}`);

    lines.push(`${latchLabel}:`);
    const next = this.nextTemp();
    lines.push(`  ${next} = add i32 ${idx}, 1`);
    lines.push(`  store i32 ${next}, ptr ${idxPtr}`);
    lines.push(`  br label %${condLabel}`);

    lines.push(`${exitLabel}:`);
    this.emitAppendLiteral(bufPtr, capPtr, lenPtr, "]", lines);

    const result = this.nextTemp();
    lines.push(`  ${result} = load ptr, ptr ${bufPtr}`);
    return result;
  }

  private emitValueToString(value: EmittedValue, lines: string[]): string {
    if (isArrayType(value.type)) {
      return this.emitArrayToString(value.llvm, value.type.element, lines);
    }
    if (value.type === "bool") {
      return this.emitBoolToString(value.llvm, lines);
    }
    if (value.type === "string") {
      return value.llvm;
    }

    this.needsSprintf = true;
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca [64 x i8]`);
    const tmpPtr = this.nextTemp();
    lines.push(
      `  ${tmpPtr} = getelementptr inbounds [64 x i8], ptr ${tmp}, i64 0, i64 0`,
    );

    if (value.type === "i32") {
      const fmt = this.internString("%d");
      const fmtPtr = this.nextTemp();
      lines.push(
        `  ${fmtPtr} = getelementptr inbounds [${fmt.length} x i8], ptr @${fmt.name}, i64 0, i64 0`,
      );
      lines.push(
        `  call i32 (ptr, ptr, ...) @sprintf(ptr noundef ${tmpPtr}, ptr noundef ${fmtPtr}, i32 ${value.llvm})`,
      );
    } else if (value.type === "i64") {
      const fmt = this.internString("%lld");
      const fmtPtr = this.nextTemp();
      lines.push(
        `  ${fmtPtr} = getelementptr inbounds [${fmt.length} x i8], ptr @${fmt.name}, i64 0, i64 0`,
      );
      lines.push(
        `  call i32 (ptr, ptr, ...) @sprintf(ptr noundef ${tmpPtr}, ptr noundef ${fmtPtr}, i64 ${value.llvm})`,
      );
    } else if (value.type === "f32") {
      const fmt = this.internString("%g");
      const fmtPtr = this.nextTemp();
      lines.push(
        `  ${fmtPtr} = getelementptr inbounds [${fmt.length} x i8], ptr @${fmt.name}, i64 0, i64 0`,
      );
      const widened = this.nextTemp();
      lines.push(`  ${widened} = fpext float ${value.llvm} to double`);
      lines.push(
        `  call i32 (ptr, ptr, ...) @sprintf(ptr noundef ${tmpPtr}, ptr noundef ${fmtPtr}, double ${widened})`,
      );
    } else if (value.type === "f64") {
      const fmt = this.internString("%g");
      const fmtPtr = this.nextTemp();
      lines.push(
        `  ${fmtPtr} = getelementptr inbounds [${fmt.length} x i8], ptr @${fmt.name}, i64 0, i64 0`,
      );
      lines.push(
        `  call i32 (ptr, ptr, ...) @sprintf(ptr noundef ${tmpPtr}, ptr noundef ${fmtPtr}, double ${value.llvm})`,
      );
    } else if (value.type === "char") {
      const fmt = this.internString("%c");
      const fmtPtr = this.nextTemp();
      lines.push(
        `  ${fmtPtr} = getelementptr inbounds [${fmt.length} x i8], ptr @${fmt.name}, i64 0, i64 0`,
      );
      lines.push(
        `  call i32 (ptr, ptr, ...) @sprintf(ptr noundef ${tmpPtr}, ptr noundef ${fmtPtr}, i8 ${value.llvm})`,
      );
    } else if (isEnumType(value.type)) {
      const fmt = this.internString("%d");
      const fmtPtr = this.nextTemp();
      lines.push(
        `  ${fmtPtr} = getelementptr inbounds [${fmt.length} x i8], ptr @${fmt.name}, i64 0, i64 0`,
      );
      lines.push(
        `  call i32 (ptr, ptr, ...) @sprintf(ptr noundef ${tmpPtr}, ptr noundef ${fmtPtr}, i32 ${value.llvm})`,
      );
    } else {
      throw new Error(`Codegen: cannot stringify type for array print`);
    }

    return tmpPtr;
  }

  private emitAppendLiteral(
    bufPtr: string,
    capPtr: string,
    lenPtr: string,
    literal: string,
    lines: string[],
  ): void {
    const global = this.internString(literal);
    const ptr = this.nextTemp();
    lines.push(
      `  ${ptr} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
    );
    this.emitAppendString(bufPtr, capPtr, lenPtr, ptr, lines);
  }

  private emitAppendString(
    bufPtr: string,
    capPtr: string,
    lenPtr: string,
    suffix: string,
    lines: string[],
  ): void {
    this.needsStringRuntime = true;
    this.needsArrayRuntime = true;

    const id = this.labelCounter;
    this.labelCounter += 1;
    const growLabel = `arr.append.grow.${id}`;
    const joinLabel = `arr.append.join.${id}`;

    const suffixLen = this.nextTemp();
    lines.push(`  ${suffixLen} = call i64 @strlen(ptr noundef ${suffix})`);
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const needed = this.nextTemp();
    lines.push(`  ${needed} = add i64 ${curLen}, ${suffixLen}`);
    const neededPlus = this.nextTemp();
    lines.push(`  ${neededPlus} = add i64 ${needed}, 1`);
    const capacity = this.nextTemp();
    lines.push(`  ${capacity} = load i64, ptr ${capPtr}`);
    const fits = this.nextTemp();
    lines.push(`  ${fits} = icmp ule i64 ${neededPlus}, ${capacity}`);
    lines.push(`  br i1 ${fits}, label %${joinLabel}, label %${growLabel}`);

    lines.push(`${growLabel}:`);
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${capacity}, 2`);
    const newCap = this.nextTemp();
    const needMore = this.nextTemp();
    lines.push(`  ${needMore} = icmp ugt i64 ${neededPlus}, ${doubled}`);
    lines.push(`  ${newCap} = select i1 ${needMore}, i64 ${neededPlus}, i64 ${doubled}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${bufPtr}`);
    const grown = this.nextTemp();
    lines.push(`  ${grown} = call ptr @realloc(ptr noundef ${oldBuf}, i64 noundef ${newCap})`);
    lines.push(`  store ptr ${grown}, ptr ${bufPtr}`);
    lines.push(`  br label %${joinLabel}`);

    lines.push(`${joinLabel}:`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = load ptr, ptr ${bufPtr}`);
    lines.push(`  call ptr @strcat(ptr noundef ${buf}, ptr noundef ${suffix})`);
    lines.push(`  store i64 ${needed}, ptr ${lenPtr}`);
  }

  private emitBoolToString(boolValue: string, lines: string[]): string {
    const trueGlobal = this.internString("true");
    const falseGlobal = this.internString("false");
    const truePtr = this.nextTemp();
    const falsePtr = this.nextTemp();
    const selected = this.nextTemp();

    lines.push(
      `  ${truePtr} = getelementptr inbounds [${trueGlobal.length} x i8], ptr @${trueGlobal.name}, i64 0, i64 0`,
    );
    lines.push(
      `  ${falsePtr} = getelementptr inbounds [${falseGlobal.length} x i8], ptr @${falseGlobal.name}, i64 0, i64 0`,
    );
    lines.push(`  ${selected} = select i1 ${boolValue}, ptr ${truePtr}, ptr ${falsePtr}`);
    return selected;
  }

  private nextTemp(): string {
    const name = `%t${this.tempCounter}`;
    this.tempCounter += 1;
    return name;
  }

  private internString(value: string): { name: string; length: number } {
    const existing = this.stringGlobals.get(value);
    if (existing) {
      return existing;
    }

    const name = `.str.${this.stringCounter}`;
    this.stringCounter += 1;
    const length = Buffer.byteLength(value, "utf8") + 1;
    const entry = { name, length };
    this.stringGlobals.set(value, entry);
    return entry;
  }

  private emitStringGlobals(): string[] {
    const lines: string[] = [];
    for (const [value, { name, length }] of this.stringGlobals) {
      const encoded = encodeLlvmString(value);
      lines.push(
        `@${name} = private unnamed_addr constant [${length} x i8] c"${encoded}\\00", align 1`,
      );
    }
    return lines;
  }
}

function comparisonPredicate(operator: string, type: ValueType): string {
  const isFloat = type === "f32" || type === "f64";
  switch (operator) {
    case "==":
      return isFloat ? "oeq" : "eq";
    case "!=":
      return isFloat ? "one" : "ne";
    case "<":
      return isFloat ? "olt" : "slt";
    case "<=":
      return isFloat ? "ole" : "sle";
    case ">":
      return isFloat ? "ogt" : "sgt";
    case ">=":
      return isFloat ? "oge" : "sge";
    default:
      throw new Error(`Codegen: unexpected comparison '${operator}'`);
  }
}

function toLlvmType(type: ValueType | "void"): string {
  if (type === "void") {
    return "void";
  }
  if (typeof type === "object") {
    if (type.kind === "struct") {
      return `%${type.name}`;
    }
    if (type.kind === "enum") {
      return "i32";
    }
    return "ptr";
  }
  switch (type) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "float";
    case "f64":
      return "double";
    case "bool":
      return "i1";
    case "char":
      return "i8";
    case "string":
      return "ptr";
  }
}

function elementByteSize(type: ValueType, structs?: Map<string, StructInfo>): number {
  if (typeof type === "object") {
    if (type.kind === "struct") {
      return structByteSize(type.name, structs);
    }
    if (type.kind === "enum") {
      return 4;
    }
    return 8; // ptr
  }
  switch (type) {
    case "i32":
      return 4;
    case "i64":
      return 8;
    case "f32":
      return 4;
    case "f64":
      return 8;
    case "bool":
      return 1;
    case "char":
      return 1;
    case "string":
      return 8;
  }
}

function alignUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

function fieldAlign(type: ValueType): number {
  if (typeof type === "object") {
    if (type.kind === "struct") {
      return 8;
    }
    if (type.kind === "enum") {
      return 4;
    }
    return 8;
  }
  switch (type) {
    case "i32":
    case "f32":
      return 4;
    case "i64":
    case "f64":
    case "string":
      return 8;
    case "bool":
    case "char":
      return 1;
  }
}

function structByteSize(name: string, structs?: Map<string, StructInfo>): number {
  const def = structs?.get(name);
  if (!def) {
    return 64;
  }
  let offset = 0;
  let maxAlign = 1;
  for (const field of def.fields) {
    const align = fieldAlign(field.type);
    maxAlign = Math.max(maxAlign, align);
    offset = alignUp(offset, align);
    offset += elementByteSize(field.type, structs);
  }
  return alignUp(offset, maxAlign);
}

function typedOne(type: ValueType): string {
  if (typeof type === "object") {
    throw new Error(`Codegen: cannot increment ${type.kind} type`);
  }
  switch (type) {
    case "i32":
      return "1";
    case "i64":
      return "1";
    case "f32":
      return "1.000000e+00";
    case "f64":
      return "1.000000e+00";
    default:
      throw new Error(`Codegen: cannot increment type '${type}'`);
  }
}

function printfSpecifier(type: ValueType): string {
  if (typeof type === "object") {
    if (type.kind === "enum") {
      return "%d";
    }
    throw new Error(`Codegen: cannot print ${type.kind}`);
  }
  switch (type) {
    case "i32":
      return "%d";
    case "i64":
      return "%lld";
    case "f32":
    case "f64":
      return "%g";
    case "bool":
      return "%s";
    case "char":
      return "%c";
    case "string":
      return "%s";
  }
}

function printfArgType(type: ValueType): string {
  if (typeof type === "object") {
    if (type.kind === "enum") {
      return "i32";
    }
    throw new Error(`Codegen: cannot print ${type.kind}`);
  }
  switch (type) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
    case "f64":
      return "double";
    case "bool":
      return "i1";
    case "char":
      return "i8";
    case "string":
      return "ptr";
  }
}

function formatFloat(value: number, _type: ValueType): string {
  if (Number.isInteger(value)) {
    return `${value}.0`;
  }
  return String(value);
}

/** Escape a UTF-8 string for an LLVM `c"..."` constant (without the trailing NUL). */
export function encodeLlvmString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c || byte < 0x20 || byte > 0x7e) {
      out += `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}
