import type {
  AssignmentStatement,
  BinaryExpression,
  CallExpression,
  ClassDeclaration,
  ClassMethod,
  ConstructorDeclaration,
  EnumDeclaration,
  Expression,
  ForInStatement,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  InterfaceDeclaration,
  MemberExpression,
  NewExpression,
  Parameter,
  Program,
  ReturnStatement,
  Statement,
  StructDeclaration,
  StructLiteral,
  StructMethod,
  TypeAnnotation,
  UnaryExpression,
  UpdateStatement,
  VariableDeclaration,
  WhileStatement,
} from "../ast/nodes.js";
import { mangleSymbol } from "../modules/mangle.js";
import type { ResolvedModule } from "../modules/resolve.js";
import {
  isArrayType,
  isClassType,
  isEnumType,
  isInterfaceType,
  isStructType,
  typesEqual,
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
  readonly mangledName: string;
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

interface StructMethodInfo {
  readonly name: string;
  readonly mangledName: string;
  readonly params: ValueType[];
  readonly returnType: ValueType | "void";
  readonly decl: StructMethod;
}

interface StructInfo {
  readonly name: string;
  readonly localName: string;
  readonly fields: StructFieldInfo[];
  readonly methods: StructMethodInfo[];
}

interface EnumInfo {
  readonly name: string;
  readonly localName: string;
  readonly variants: ReadonlyMap<string, number>;
}

interface ClassFieldInfo {
  readonly name: string;
  readonly type: ValueType;
  readonly fieldIndex: number;
  readonly isStatic: boolean;
  readonly staticGlobal: string | null;
}

interface ClassMethodInfo {
  readonly name: string;
  readonly mangledName: string;
  readonly params: ValueType[];
  readonly returnType: ValueType | "void";
  readonly isStatic: boolean;
  readonly isAbstract: boolean;
  readonly vtableSlot: number;
  readonly decl: ClassMethod | null;
}

interface ClassInfo {
  readonly name: string;
  readonly localName: string;
  readonly isAbstract: boolean;
  readonly superclass: string | null;
  /** Mangled names of interfaces directly listed in `implements`. */
  readonly implementedInterfaces: string[];
  readonly fields: ClassFieldInfo[];
  readonly staticFields: ClassFieldInfo[];
  readonly instanceMethods: ClassMethodInfo[];
  readonly staticMethods: ClassMethodInfo[];
  readonly constructorParams: ValueType[];
  readonly constructorMangledName: string;
  readonly constructorDecl: ConstructorDeclaration | null;
  readonly vtableGlobalName: string;
  readonly decl: ClassDeclaration;
}

interface InterfaceMethodInfo {
  readonly name: string;
  readonly params: ValueType[];
  readonly returnType: ValueType | "void";
  readonly itableSlot: number;
}

interface InterfaceInfo {
  readonly name: string;
  readonly localName: string;
  readonly bases: string[];
  readonly methods: InterfaceMethodInfo[];
  readonly baseItableOffsets: ReadonlyMap<string, number>;
  readonly decl: InterfaceDeclaration;
}

interface NamespaceInfo {
  readonly functions: ReadonlyMap<string, FunctionSig>;
  readonly structs: ReadonlyMap<string, StructInfo>;
  readonly enums: ReadonlyMap<string, EnumInfo>;
  readonly classes: ReadonlyMap<string, ClassInfo>;
  readonly interfaces: ReadonlyMap<string, InterfaceInfo>;
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
  /** All functions keyed by mangled LLVM name. */
  private functions = new Map<string, FunctionSig>();
  /** Current module: local name → mangled function. */
  private localFunctions = new Map<string, FunctionSig>();
  private structs = new Map<string, StructInfo>();
  private localStructs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private localEnums = new Map<string, EnumInfo>();
  private classes = new Map<string, ClassInfo>();
  private localClasses = new Map<string, ClassInfo>();
  private interfaces = new Map<string, InterfaceInfo>();
  private localInterfaces = new Map<string, InterfaceInfo>();
  private namespaces = new Map<string, NamespaceInfo>();
  private needsPrintf = false;
  private needsStringRuntime = false;
  private needsArrayRuntime = false;
  private needsClassRuntime = false;
  private needsAbort = false;
  private needsSprintf = false;
  private readonly functionBodies: string[] = [];
  private readonly globalDefs: string[] = [];
  private readonly loopStack: LoopContext[] = [];
  /** When emitting a method/constructor, the `this` pointer SSA value. */
  private thisPtr: string | null = null;
  private thisType: ValueType | null = null;
  /** Return type of the function/method currently being emitted. */
  private currentReturnType: ValueType | "void" | null = null;

  emit(program: Program): string {
    return this.emitModules([
      {
        path: "<source>",
        source: "",
        ast: program,
        moduleId: "",
        isEntry: true,
        imports: [],
      },
    ]);
  }

  emitModules(modules: readonly ResolvedModule[]): string {
    this.stringCounter = 0;
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.stringGlobals.clear();
    this.locals = new Map();
    this.functions.clear();
    this.localFunctions.clear();
    this.structs.clear();
    this.localStructs.clear();
    this.enums.clear();
    this.localEnums.clear();
    this.classes.clear();
    this.localClasses.clear();
    this.interfaces.clear();
    this.localInterfaces.clear();
    this.namespaces.clear();
    this.needsPrintf = false;
    this.needsStringRuntime = false;
    this.needsArrayRuntime = false;
    this.needsClassRuntime = false;
    this.needsAbort = false;
    this.needsSprintf = false;
    this.functionBodies.length = 0;
    this.globalDefs.length = 0;
    this.loopStack.length = 0;
    this.thisPtr = null;
    this.thisType = null;

    const moduleSymbols = new Map<
      string,
      {
        functions: Map<string, FunctionSig>;
        structs: Map<string, StructInfo>;
        enums: Map<string, EnumInfo>;
        classes: Map<string, ClassInfo>;
        interfaces: Map<string, InterfaceInfo>;
      }
    >();

    // Register all types and function signatures first.
    for (const mod of modules) {
      const localEnums = new Map<string, EnumInfo>();
      const localStructs = new Map<string, StructInfo>();
      const localClasses = new Map<string, ClassInfo>();
      const localInterfaces = new Map<string, InterfaceInfo>();
      const localFns = new Map<string, FunctionSig>();

      for (const decl of mod.ast.body) {
        if (decl.kind === "EnumDeclaration") {
          const info = this.registerEnum(decl, mod.moduleId);
          localEnums.set(decl.name.name, info);
        }
      }

      for (const decl of mod.ast.body) {
        if (decl.kind === "StructDeclaration") {
          if (decl.typeParams.length > 0) {
            continue;
          }
          const info = this.registerStruct(decl, mod.moduleId);
          localStructs.set(decl.name.name, info);
        }
      }

      for (const decl of mod.ast.body) {
        if (decl.kind === "InterfaceDeclaration") {
          if (decl.typeParams.length > 0) {
            continue;
          }
          const info = this.registerInterfaceStub(decl, mod.moduleId);
          localInterfaces.set(decl.name.name, info);
          this.interfaces.set(info.name, info);
        }
      }

      for (const decl of mod.ast.body) {
        if (decl.kind === "ClassDeclaration") {
          if (decl.typeParams.length > 0) {
            continue;
          }
          const info = this.registerClassStub(decl, mod.moduleId);
          localClasses.set(decl.name.name, info);
          this.classes.set(info.name, info);
        }
      }

      // Resolve interface methods / extends (within module).
      for (const decl of mod.ast.body) {
        if (decl.kind !== "InterfaceDeclaration") {
          continue;
        }
        const info = this.buildInterfaceInfo(
          decl,
          mod.moduleId,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
        );
        localInterfaces.set(decl.name.name, info);
        this.interfaces.set(info.name, info);
      }

      // Resolve struct field/method types.
      for (const decl of mod.ast.body) {
        if (decl.kind !== "StructDeclaration") {
          continue;
        }
        const info = localStructs.get(decl.name.name)!;
        const fields = decl.fields.map((field) => {
          const type = this.resolveAnnotationInModule(
            field.typeAnnotation,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            new Map(),
          );
          if (!type) {
            throw new Error(`Codegen: invalid field type in struct '${decl.name.name}'`);
          }
          return { name: field.name.name, type };
        });
        const methods: StructMethodInfo[] = decl.methods.map((method) => {
          const params = method.params.map((p) => {
            const t = this.resolveAnnotationInModule(
              p.typeAnnotation,
              localStructs,
              localEnums,
              localClasses,
              localInterfaces,
              new Map(),
            );
            if (!t) {
              throw new Error(`Codegen: invalid method param in '${method.name.name}'`);
            }
            return t;
          });
          const returnType =
            method.returnType.kind === "PrimitiveType" && method.returnType.name === "void"
              ? ("void" as const)
              : this.resolveAnnotationInModule(
                  method.returnType,
                  localStructs,
                  localEnums,
                  localClasses,
                  localInterfaces,
                  new Map(),
                );
          if (returnType === null) {
            throw new Error(`Codegen: invalid method return in '${method.name.name}'`);
          }
          return {
            name: method.name.name,
            mangledName: mangleSymbol(mod.moduleId, `${decl.name.name}__${method.name.name}`),
            params,
            returnType,
            decl: method,
          };
        });
        const updated: StructInfo = {
          name: info.name,
          localName: info.localName,
          fields,
          methods,
        };
        localStructs.set(decl.name.name, updated);
        this.structs.set(updated.name, updated);
      }

      // Resolve class members (inheritance within module via localClasses).
      for (const decl of mod.ast.body) {
        if (decl.kind !== "ClassDeclaration") {
          continue;
        }
        const info = this.buildClassInfo(
          decl,
          mod.moduleId,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
        );
        localClasses.set(decl.name.name, info);
        this.classes.set(info.name, info);
      }

      for (const decl of mod.ast.body) {
        if (decl.kind !== "FunctionDeclaration") {
          continue;
        }
        if (decl.typeParams.length > 0) {
          continue;
        }
        const fn = decl;
        const params = fn.params.map((p) => {
          const t = this.resolveAnnotationInModule(
            p.typeAnnotation,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            new Map(),
          );
          if (!t) {
            throw new Error(`Codegen: invalid parameter type for '${p.name.name}'`);
          }
          return t;
        });
        const returnType =
          fn.returnType.kind === "PrimitiveType" && fn.returnType.name === "void"
            ? ("void" as const)
            : this.resolveAnnotationInModule(
                fn.returnType,
                localStructs,
                localEnums,
                localClasses,
                localInterfaces,
                new Map(),
              );
        if (returnType === null) {
          throw new Error(`Codegen: invalid return type for '${fn.name.name}'`);
        }
        const mangledName =
          fn.name.name === "main" ? "main" : mangleSymbol(mod.moduleId, fn.name.name);
        const sig: FunctionSig = {
          name: fn.name.name,
          mangledName,
          params,
          returnType,
        };
        localFns.set(fn.name.name, sig);
        this.functions.set(mangledName, sig);
      }

      moduleSymbols.set(mod.path, {
        functions: localFns,
        structs: localStructs,
        enums: localEnums,
        classes: localClasses,
        interfaces: localInterfaces,
      });
    }

    // Emit function/method bodies with per-module local/namespace context.
    for (const mod of modules) {
      const symbols = moduleSymbols.get(mod.path)!;
      this.localFunctions = symbols.functions;
      this.localStructs = symbols.structs;
      this.localEnums = symbols.enums;
      this.localClasses = symbols.classes;
      this.localInterfaces = symbols.interfaces;

      const namespaces = new Map<string, NamespaceInfo>();
      for (const binding of mod.imports) {
        const imported = moduleSymbols.get(binding.modulePath);
        if (!imported) {
          continue;
        }
        const exportedFns = new Map<string, FunctionSig>();
        const importedMod = modules.find((m) => m.path === binding.modulePath);
        if (!importedMod) {
          continue;
        }
        for (const [name, sig] of imported.functions) {
          const fnDecl = importedMod.ast.body.find(
            (d) => d.kind === "FunctionDeclaration" && d.name.name === name,
          );
          if (fnDecl && fnDecl.kind === "FunctionDeclaration" && fnDecl.exported) {
            exportedFns.set(name, sig);
          }
        }
        const exportedStructs = new Map<string, StructInfo>();
        for (const [name, info] of imported.structs) {
          const sDecl = importedMod.ast.body.find(
            (d) => d.kind === "StructDeclaration" && d.name.name === name,
          );
          if (sDecl && sDecl.kind === "StructDeclaration" && sDecl.exported) {
            exportedStructs.set(name, info);
          }
        }
        const exportedEnums = new Map<string, EnumInfo>();
        for (const [name, info] of imported.enums) {
          const eDecl = importedMod.ast.body.find(
            (d) => d.kind === "EnumDeclaration" && d.name.name === name,
          );
          if (eDecl && eDecl.kind === "EnumDeclaration" && eDecl.exported) {
            exportedEnums.set(name, info);
          }
        }
        const exportedClasses = new Map<string, ClassInfo>();
        for (const [name, info] of imported.classes) {
          const cDecl = importedMod.ast.body.find(
            (d) => d.kind === "ClassDeclaration" && d.name.name === name,
          );
          if (cDecl && cDecl.kind === "ClassDeclaration" && cDecl.exported) {
            exportedClasses.set(name, info);
          }
        }
        const exportedInterfaces = new Map<string, InterfaceInfo>();
        for (const [name, info] of imported.interfaces) {
          const iDecl = importedMod.ast.body.find(
            (d) => d.kind === "InterfaceDeclaration" && d.name.name === name,
          );
          if (iDecl && iDecl.kind === "InterfaceDeclaration" && iDecl.exported) {
            exportedInterfaces.set(name, info);
          }
        }
        namespaces.set(binding.alias, {
          functions: exportedFns,
          structs: exportedStructs,
          enums: exportedEnums,
          classes: exportedClasses,
          interfaces: exportedInterfaces,
        });
      }
      this.namespaces = namespaces;

      for (const decl of mod.ast.body) {
        if (decl.kind === "FunctionDeclaration") {
          this.emitFunction(decl);
        } else if (decl.kind === "StructDeclaration") {
          const info = this.localStructs.get(decl.name.name);
          if (info) {
            for (const method of info.methods) {
              this.emitStructMethod(info, method);
            }
          }
        } else if (decl.kind === "ClassDeclaration") {
          const info = this.localClasses.get(decl.name.name);
          if (info) {
            this.emitClassMembers(info);
          }
        }
      }
    }

    this.emitClassGlobals();

    const structTypeLines = this.emitStructTypeDefs();
    const interfaceTypeLines = this.emitInterfaceTypeDefs();
    const classTypeLines = this.emitClassTypeDefs();
    const typeLines = [...structTypeLines, ...interfaceTypeLines, ...classTypeLines];
    const globalLines = [...this.globalDefs, ...this.emitStringGlobals()];
    const declares: string[] = [];
    if (this.needsPrintf) {
      declares.push("declare i32 @printf(ptr noundef, ...) nounwind");
    }
    if (this.needsStringRuntime || this.needsArrayRuntime || this.needsClassRuntime) {
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
      ...typeLines,
      typeLines.length > 0 ? "" : null,
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

  private registerEnum(decl: EnumDeclaration, moduleId: string): EnumInfo {
    const variants = new Map<string, number>();
    for (let i = 0; i < decl.variants.length; i += 1) {
      variants.set(decl.variants[i]!.name.name, i);
    }
    const info: EnumInfo = {
      name: mangleSymbol(moduleId, decl.name.name),
      localName: decl.name.name,
      variants,
    };
    this.enums.set(info.name, info);
    return info;
  }

  private registerStruct(decl: StructDeclaration, moduleId: string): StructInfo {
    const info: StructInfo = {
      name: mangleSymbol(moduleId, decl.name.name),
      localName: decl.name.name,
      fields: [],
      methods: [],
    };
    this.structs.set(info.name, info);
    return info;
  }

  private registerClassStub(decl: ClassDeclaration, moduleId: string): ClassInfo {
    const mangled = mangleSymbol(moduleId, decl.name.name);
    return {
      name: mangled,
      localName: decl.name.name,
      isAbstract: decl.isAbstract,
      superclass: null,
      implementedInterfaces: [],
      fields: [],
      staticFields: [],
      instanceMethods: [],
      staticMethods: [],
      constructorParams: [],
      constructorMangledName: mangleSymbol(moduleId, `${decl.name.name}__constructor`),
      constructorDecl: null,
      vtableGlobalName: `${mangled}__vtable`,
      decl,
    };
  }

  private registerInterfaceStub(decl: InterfaceDeclaration, moduleId: string): InterfaceInfo {
    const mangled = mangleSymbol(moduleId, decl.name.name);
    return {
      name: mangled,
      localName: decl.name.name,
      bases: [],
      methods: [],
      baseItableOffsets: new Map([[mangled, 0]]),
      decl,
    };
  }

  private buildInterfaceInfo(
    decl: InterfaceDeclaration,
    moduleId: string,
    localStructs: Map<string, StructInfo>,
    localEnums: Map<string, EnumInfo>,
    localClasses: Map<string, ClassInfo>,
    localInterfaces: Map<string, InterfaceInfo>,
  ): InterfaceInfo {
    const mangled = mangleSymbol(moduleId, decl.name.name);
    const bases: string[] = [];
    const baseDefs: InterfaceInfo[] = [];
    for (const baseType of decl.bases) {
      if (baseType.namespace) {
        throw new Error("Codegen: cross-module interface extends not resolved yet");
      }
      const base = localInterfaces.get(baseType.name);
      if (!base) {
        throw new Error(`Codegen: unknown interface '${baseType.name}'`);
      }
      bases.push(base.name);
      baseDefs.push(base);
    }

    const methods: InterfaceMethodInfo[] = [];
    const baseItableOffsets = new Map<string, number>();
    baseItableOffsets.set(mangled, 0);
    const seenNames = new Set<string>();

    for (const base of baseDefs) {
      baseItableOffsets.set(base.name, methods.length);
      for (const [baseName, offset] of base.baseItableOffsets) {
        if (!baseItableOffsets.has(baseName)) {
          baseItableOffsets.set(baseName, methods.length + offset);
        }
      }
      for (const method of base.methods) {
        if (seenNames.has(method.name)) {
          continue;
        }
        seenNames.add(method.name);
        methods.push({
          name: method.name,
          params: method.params,
          returnType: method.returnType,
          itableSlot: methods.length,
        });
      }
    }

    for (const method of decl.methods) {
      if (seenNames.has(method.name.name)) {
        continue;
      }
      seenNames.add(method.name.name);
      const params = method.params.map((p) => {
        const t = this.resolveAnnotationInModule(
          p.typeAnnotation,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          new Map(),
        );
        if (!t) {
          throw new Error(`Codegen: invalid interface method param '${method.name.name}'`);
        }
        return t;
      });
      const returnType =
        method.returnType.kind === "PrimitiveType" && method.returnType.name === "void"
          ? ("void" as const)
          : this.resolveAnnotationInModule(
              method.returnType,
              localStructs,
              localEnums,
              localClasses,
              localInterfaces,
              new Map(),
            );
      if (returnType === null) {
        throw new Error(`Codegen: invalid interface method return '${method.name.name}'`);
      }
      methods.push({
        name: method.name.name,
        params,
        returnType,
        itableSlot: methods.length,
      });
    }

    return {
      name: mangled,
      localName: decl.name.name,
      bases,
      methods,
      baseItableOffsets,
      decl,
    };
  }

  private buildClassInfo(
    decl: ClassDeclaration,
    moduleId: string,
    localStructs: Map<string, StructInfo>,
    localEnums: Map<string, EnumInfo>,
    localClasses: Map<string, ClassInfo>,
    localInterfaces: Map<string, InterfaceInfo>,
  ): ClassInfo {
    const mangled = mangleSymbol(moduleId, decl.name.name);
    let superclass: ClassInfo | null = null;
    if (decl.superclass) {
      if (decl.superclass.namespace) {
        throw new Error("Codegen: cross-module superclass not resolved yet");
      }
      superclass = localClasses.get(decl.superclass.name) ?? null;
      if (!superclass) {
        throw new Error(`Codegen: unknown superclass '${decl.superclass.name}'`);
      }
    }

    const implementedInterfaces: string[] = [];
    for (const ifaceType of decl.implementsTypes) {
      if (ifaceType.namespace) {
        throw new Error("Codegen: cross-module implements not resolved yet");
      }
      const iface = localInterfaces.get(ifaceType.name);
      if (!iface) {
        throw new Error(`Codegen: unknown interface '${ifaceType.name}'`);
      }
      implementedInterfaces.push(iface.name);
    }

    const fields: ClassFieldInfo[] = superclass
      ? superclass.fields.map((f) => ({ ...f }))
      : [];
    const staticFields: ClassFieldInfo[] = [];
    let constructorDecl: ConstructorDeclaration | null = null;
    const ownMethods: ClassMethod[] = [];

    for (const member of decl.members) {
      if (member.kind === "ConstructorDeclaration") {
        constructorDecl = member;
        continue;
      }
      if (member.kind === "ClassField") {
        const type = this.resolveAnnotationInModule(
          member.typeAnnotation,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          new Map(),
        );
        if (!type) {
          throw new Error(`Codegen: invalid field type '${member.name.name}'`);
        }
        if (member.isStatic) {
          staticFields.push({
            name: member.name.name,
            type,
            fieldIndex: -1,
            isStatic: true,
            staticGlobal: mangleSymbol(moduleId, `${decl.name.name}__static_${member.name.name}`),
          });
        } else {
          fields.push({
            name: member.name.name,
            type,
            fieldIndex: fields.length + 1,
            isStatic: false,
            staticGlobal: null,
          });
        }
        continue;
      }
      ownMethods.push(member);
    }

    for (let i = 0; i < fields.length; i += 1) {
      fields[i] = { ...fields[i]!, fieldIndex: i + 1 };
    }

    const instanceMethods: ClassMethodInfo[] = superclass
      ? superclass.instanceMethods.map((m) => ({ ...m }))
      : [];
    const staticMethods: ClassMethodInfo[] = [];
    const slotByName = new Map(instanceMethods.map((m, i) => [m.name, i]));

    for (const method of ownMethods) {
      const params = method.params.map((p) => {
        const t = this.resolveAnnotationInModule(
          p.typeAnnotation,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          new Map(),
        );
        if (!t) {
          throw new Error(`Codegen: invalid method param '${method.name.name}'`);
        }
        return t;
      });
      const returnType =
        method.returnType.kind === "PrimitiveType" && method.returnType.name === "void"
          ? ("void" as const)
          : this.resolveAnnotationInModule(
              method.returnType,
              localStructs,
              localEnums,
              localClasses,
              localInterfaces,
              new Map(),
            );
      if (returnType === null) {
        throw new Error(`Codegen: invalid method return '${method.name.name}'`);
      }
      const mangledMethod = mangleSymbol(moduleId, `${decl.name.name}__${method.name.name}`);
      if (method.isStatic) {
        staticMethods.push({
          name: method.name.name,
          mangledName: mangledMethod,
          params,
          returnType,
          isStatic: true,
          isAbstract: false,
          vtableSlot: -1,
          decl: method,
        });
        continue;
      }
      const existing = slotByName.get(method.name.name);
      if (existing !== undefined) {
        instanceMethods[existing] = {
          name: method.name.name,
          mangledName: mangledMethod,
          params,
          returnType,
          isStatic: false,
          isAbstract: method.isAbstract,
          vtableSlot: existing,
          decl: method,
        };
      } else {
        const slot = instanceMethods.length;
        slotByName.set(method.name.name, slot);
        instanceMethods.push({
          name: method.name.name,
          mangledName: mangledMethod,
          params,
          returnType,
          isStatic: false,
          isAbstract: method.isAbstract,
          vtableSlot: slot,
          decl: method,
        });
      }
    }

    const constructorParams: ValueType[] = [];
    if (constructorDecl) {
      for (const p of constructorDecl.params) {
        const t = this.resolveAnnotationInModule(
          p.typeAnnotation,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          new Map(),
        );
        if (!t) {
          throw new Error("Codegen: invalid constructor param");
        }
        constructorParams.push(t);
      }
    }

    return {
      name: mangled,
      localName: decl.name.name,
      isAbstract: decl.isAbstract,
      superclass: superclass?.name ?? null,
      implementedInterfaces,
      fields,
      staticFields,
      instanceMethods,
      staticMethods,
      constructorParams,
      constructorMangledName: mangleSymbol(moduleId, `${decl.name.name}__constructor`),
      constructorDecl,
      vtableGlobalName: `${mangled}__vtable`,
      decl,
    };
  }

  private namedKinds(): Map<string, "struct" | "enum" | "class" | "interface"> {
    const named = new Map<string, "struct" | "enum" | "class" | "interface">();
    for (const info of this.localStructs.values()) {
      named.set(info.localName, "struct");
      named.set(info.name, "struct");
    }
    for (const info of this.localEnums.values()) {
      named.set(info.localName, "enum");
      named.set(info.name, "enum");
    }
    for (const info of this.localClasses.values()) {
      named.set(info.localName, "class");
      named.set(info.name, "class");
    }
    for (const info of this.localInterfaces.values()) {
      named.set(info.localName, "interface");
      named.set(info.name, "interface");
    }
    for (const [alias, ns] of this.namespaces) {
      for (const [name, info] of ns.structs) {
        named.set(`${alias}.${name}`, "struct");
        named.set(info.name, "struct");
      }
      for (const [name, info] of ns.enums) {
        named.set(`${alias}.${name}`, "enum");
        named.set(info.name, "enum");
      }
      for (const [name, info] of ns.classes) {
        named.set(`${alias}.${name}`, "class");
        named.set(info.name, "class");
      }
      for (const [name, info] of ns.interfaces) {
        named.set(`${alias}.${name}`, "interface");
        named.set(info.name, "interface");
      }
    }
    return named;
  }

  private resolveAnnotation(ann: TypeAnnotation): ValueType | null {
    return this.resolveAnnotationInModule(
      ann,
      this.localStructs,
      this.localEnums,
      this.localClasses,
      this.localInterfaces,
      this.namespaces,
    );
  }

  private resolveAnnotationInModule(
    ann: TypeAnnotation,
    localStructs: Map<string, StructInfo>,
    localEnums: Map<string, EnumInfo>,
    localClasses: Map<string, ClassInfo>,
    localInterfaces: Map<string, InterfaceInfo>,
    namespaces: Map<string, NamespaceInfo>,
  ): ValueType | null {
    if (ann.kind === "PrimitiveType") {
      if (ann.name === "void") {
        return null;
      }
      return ann.name;
    }
    if (ann.kind === "NamedType") {
      if (ann.typeArgs.length > 0) {
        throw new Error(
          `Codegen: unexpected type arguments on '${ann.name}' (monomorphize should have removed them)`,
        );
      }
      if (ann.namespace) {
        const ns = namespaces.get(ann.namespace);
        if (!ns) {
          return null;
        }
        const enumInfo = ns.enums.get(ann.name);
        if (enumInfo) {
          return { kind: "enum", name: enumInfo.name };
        }
        const structInfo = ns.structs.get(ann.name);
        if (structInfo) {
          return { kind: "struct", name: structInfo.name };
        }
        const classInfo = ns.classes.get(ann.name);
        if (classInfo) {
          return { kind: "class", name: classInfo.name };
        }
        const ifaceInfo = ns.interfaces.get(ann.name);
        if (ifaceInfo) {
          return { kind: "interface", name: ifaceInfo.name };
        }
        return null;
      }
      const enumInfo = localEnums.get(ann.name);
      if (enumInfo) {
        return { kind: "enum", name: enumInfo.name };
      }
      const structInfo = localStructs.get(ann.name);
      if (structInfo) {
        return { kind: "struct", name: structInfo.name };
      }
      const classInfo = localClasses.get(ann.name);
      if (classInfo) {
        return { kind: "class", name: classInfo.name };
      }
      const ifaceInfo = localInterfaces.get(ann.name);
      if (ifaceInfo) {
        return { kind: "interface", name: ifaceInfo.name };
      }
      return null;
    }
    const element = this.resolveAnnotationInModule(
      ann.element,
      localStructs,
      localEnums,
      localClasses,
      localInterfaces,
      namespaces,
    );
    if (element === null) {
      return null;
    }
    return { kind: "array", element };
  }

  private emitStructTypeDefs(): string[] {
    const lines: string[] = [];
    for (const info of this.structs.values()) {
      const fieldTypes = info.fields.map((f) => toLlvmType(f.type)).join(", ");
      lines.push(`%${info.name} = type { ${fieldTypes} }`);
    }
    return lines;
  }

  private emitInterfaceTypeDefs(): string[] {
    const lines: string[] = [];
    for (const info of this.interfaces.values()) {
      lines.push(`%${info.name} = type { ptr, ptr }`);
      if (info.methods.length > 0) {
        const slots = info.methods.map(() => "ptr").join(", ");
        lines.push(`%${info.name}__itable_type = type { ${slots} }`);
      } else {
        lines.push(`%${info.name}__itable_type = type { }`);
      }
    }
    return lines;
  }

  private emitClassTypeDefs(): string[] {
    const lines: string[] = [];
    for (const info of this.classes.values()) {
      const fieldTypes = ["ptr", ...info.fields.map((f) => toLlvmType(f.type))].join(", ");
      lines.push(`%${info.name} = type { ${fieldTypes} }`);
      if (info.instanceMethods.length > 0) {
        const slots = info.instanceMethods.map(() => "ptr").join(", ");
        lines.push(`%${info.name}__vtable_type = type { ${slots} }`);
      } else {
        lines.push(`%${info.name}__vtable_type = type { }`);
      }
    }
    return lines;
  }

  private emitClassGlobals(): void {
    for (const info of this.classes.values()) {
      for (const field of info.staticFields) {
        if (!field.staticGlobal) {
          continue;
        }
        const llvmTy = toLlvmType(field.type);
        const zero = zeroInitializer(field.type);
        this.globalDefs.push(`@${field.staticGlobal} = global ${llvmTy} ${zero}`);
      }
      if (info.instanceMethods.length === 0) {
        this.globalDefs.push(
          `@${info.vtableGlobalName} = global %${info.name}__vtable_type zeroinitializer`,
        );
      } else {
        const ptrs = info.instanceMethods
          .map((m) =>
            m.isAbstract ? "ptr null" : `ptr @${m.mangledName}`,
          )
          .join(", ");
        this.globalDefs.push(
          `@${info.vtableGlobalName} = global %${info.name}__vtable_type { ${ptrs} }`,
        );
      }

      // Emit itables for every interface this class (or a superclass) satisfies.
      for (const ifaceName of this.interfacesSatisfiedByClass(info)) {
        const iface = this.interfaces.get(ifaceName);
        if (!iface) {
          continue;
        }
        const itableGlobal = itableGlobalName(info.name, iface.name);
        if (iface.methods.length === 0) {
          this.globalDefs.push(
            `@${itableGlobal} = global %${iface.name}__itable_type zeroinitializer`,
          );
          continue;
        }
        const ptrs = iface.methods
          .map((req) => {
            const method = info.instanceMethods.find((m) => m.name === req.name);
            if (!method || method.isAbstract) {
              return "ptr null";
            }
            return `ptr @${method.mangledName}`;
          })
          .join(", ");
        this.globalDefs.push(
          `@${itableGlobal} = global %${iface.name}__itable_type { ${ptrs} }`,
        );
      }
    }
  }

  /** Mangled interface names satisfied by this class via implements (incl. transitive bases + superclass). */
  private interfacesSatisfiedByClass(info: ClassInfo): string[] {
    const result = new Set<string>();
    let current: ClassInfo | undefined = info;
    while (current) {
      for (const ifaceName of current.implementedInterfaces) {
        const iface = this.interfaces.get(ifaceName);
        if (!iface) {
          continue;
        }
        for (const name of iface.baseItableOffsets.keys()) {
          result.add(name);
        }
      }
      current = current.superclass ? this.classes.get(current.superclass) : undefined;
    }
    return [...result];
  }

  /** Pack/adjust a value when assigning into an interface-typed slot. */
  private coerceValue(
    value: EmittedValue,
    expected: ValueType,
    lines: string[],
  ): EmittedValue {
    if (typesEqual(value.type, expected)) {
      return value;
    }

    if (isClassType(value.type) && isInterfaceType(expected)) {
      const classInfo = this.classes.get(value.type.name);
      if (!classInfo) {
        throw new Error(`Codegen: unknown class '${value.type.name}'`);
      }
      const iface = this.interfaces.get(expected.name);
      if (!iface) {
        throw new Error(`Codegen: unknown interface '${expected.name}'`);
      }
      const itable = itableGlobalName(classInfo.name, iface.name);
      const undef = this.nextTemp();
      lines.push(`  ${undef} = insertvalue %${iface.name} undef, ptr ${value.llvm}, 0`);
      const fat = this.nextTemp();
      lines.push(`  ${fat} = insertvalue %${iface.name} ${undef}, ptr @${itable}, 1`);
      return { llvm: fat, type: expected };
    }

    if (isInterfaceType(value.type) && isInterfaceType(expected)) {
      const fromIface = this.interfaces.get(value.type.name);
      if (!fromIface) {
        throw new Error(`Codegen: unknown interface '${value.type.name}'`);
      }
      const offset = fromIface.baseItableOffsets.get(expected.name);
      if (offset === undefined) {
        throw new Error(
          `Codegen: cannot coerce interface '${value.type.name}' to '${expected.name}'`,
        );
      }
      if (offset === 0 && value.type.name === expected.name) {
        return value;
      }
      const data = this.nextTemp();
      lines.push(`  ${data} = extractvalue %${fromIface.name} ${value.llvm}, 0`);
      const itable = this.nextTemp();
      lines.push(`  ${itable} = extractvalue %${fromIface.name} ${value.llvm}, 1`);
      let adjustedItable = itable;
      if (offset !== 0) {
        const gep = this.nextTemp();
        lines.push(
          `  ${gep} = getelementptr inbounds %${fromIface.name}__itable_type, ptr ${itable}, i32 0, i32 ${offset}`,
        );
        adjustedItable = gep;
      }
      const undef = this.nextTemp();
      lines.push(`  ${undef} = insertvalue %${expected.name} undef, ptr ${data}, 0`);
      const fat = this.nextTemp();
      lines.push(
        `  ${fat} = insertvalue %${expected.name} ${undef}, ptr ${adjustedItable}, 1`,
      );
      return { llvm: fat, type: expected };
    }

    return value;
  }

  private emitStructMethod(struct: StructInfo, method: StructMethodInfo): void {
    this.locals = new Map();
    this.tempCounter = 0;
    this.loopStack.length = 0;
    this.thisPtr = "%this";
    this.thisType = { kind: "struct", name: struct.name };
    this.currentReturnType = method.returnType;

    const ret = method.returnType === "void" ? "void" : toLlvmType(method.returnType);
    const params = [
      `ptr %this`,
      ...method.params.map((t, i) => `${toLlvmType(t)} %arg${i}`),
    ].join(", ");
    const lines: string[] = [];
    lines.push(`define ${ret} @${method.mangledName}(${params}) {`);
    lines.push("entry:");

    for (let i = 0; i < method.decl.params.length; i += 1) {
      this.emitParameter(method.decl.params[i]!, i, lines);
    }

    let terminated = false;
    for (const stmt of method.decl.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(stmt, lines);
    }
    if (!terminated) {
      if (method.returnType === "void") {
        lines.push("  ret void");
      } else {
        throw new Error(`Codegen: method '${method.name}' missing return`);
      }
    }
    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
    this.thisPtr = null;
    this.thisType = null;
    this.currentReturnType = null;
  }

  private emitClassMembers(info: ClassInfo): void {
    this.emitClassConstructor(info);
    const declaredInstance = new Set(
      info.decl.members
        .filter((m): m is ClassMethod => m.kind === "ClassMethod" && !m.isStatic && !m.isAbstract)
        .map((m) => m.name.name),
    );
    for (const method of info.instanceMethods) {
      if (declaredInstance.has(method.name)) {
        this.emitClassMethod(info, method);
      }
    }
    for (const method of info.staticMethods) {
      this.emitClassMethod(info, method);
    }
  }

  private emitClassConstructor(info: ClassInfo): void {
    this.locals = new Map();
    this.tempCounter = 0;
    this.loopStack.length = 0;
    this.thisPtr = "%this";
    this.thisType = { kind: "class", name: info.name };
    this.currentReturnType = "void";

    const params = [
      `ptr %this`,
      ...info.constructorParams.map((t, i) => `${toLlvmType(t)} %arg${i}`),
    ].join(", ");
    const lines: string[] = [];
    lines.push(`define void @${info.constructorMangledName}(${params}) {`);
    lines.push("entry:");

    if (info.constructorDecl) {
      for (let i = 0; i < info.constructorDecl.params.length; i += 1) {
        this.emitParameter(info.constructorDecl.params[i]!, i, lines);
      }
      let terminated = false;
      for (const stmt of info.constructorDecl.body) {
        if (terminated) {
          break;
        }
        terminated = this.emitStatement(stmt, lines);
      }
      if (!terminated) {
        lines.push("  ret void");
      }
    } else {
      if (info.superclass) {
        const base = this.classes.get(info.superclass);
        if (base) {
          lines.push(`  call void @${base.constructorMangledName}(ptr %this)`);
        }
      }
      lines.push("  ret void");
    }

    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
    this.thisPtr = null;
    this.thisType = null;
    this.currentReturnType = null;
  }

  private emitClassMethod(info: ClassInfo, method: ClassMethodInfo): void {
    if (!method.decl || method.isAbstract || !method.decl.body) {
      return;
    }
    this.locals = new Map();
    this.tempCounter = 0;
    this.loopStack.length = 0;
    this.thisPtr = method.isStatic ? null : "%this";
    this.thisType = method.isStatic ? null : { kind: "class", name: info.name };
    this.currentReturnType = method.returnType;

    const ret = method.returnType === "void" ? "void" : toLlvmType(method.returnType);
    const paramParts = method.isStatic
      ? method.params.map((t, i) => `${toLlvmType(t)} %arg${i}`)
      : [`ptr %this`, ...method.params.map((t, i) => `${toLlvmType(t)} %arg${i}`)];
    const lines: string[] = [];
    lines.push(`define ${ret} @${method.mangledName}(${paramParts.join(", ")}) {`);
    lines.push("entry:");

    for (let i = 0; i < method.decl.params.length; i += 1) {
      this.emitParameter(method.decl.params[i]!, i, lines);
    }

    let terminated = false;
    for (const stmt of method.decl.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(stmt, lines);
    }
    if (!terminated) {
      if (method.returnType === "void") {
        lines.push("  ret void");
      } else {
        throw new Error(`Codegen: method '${method.name}' missing return`);
      }
    }
    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
    this.thisPtr = null;
    this.thisType = null;
    this.currentReturnType = null;
  }

  private emitNewExpression(expr: NewExpression, lines: string[]): EmittedValue {
    this.needsClassRuntime = true;
    const classInfo = expr.namespace
      ? this.namespaces.get(expr.namespace.name)?.classes.get(expr.className.name)
      : this.localClasses.get(expr.className.name);
    if (!classInfo) {
      throw new Error(`Codegen: unknown class '${expr.className.name}'`);
    }
    const size = classObjectByteSize(classInfo, this.structs);
    const obj = this.nextTemp();
    lines.push(`  ${obj} = call ptr @malloc(i64 noundef ${size})`);
    const vtPtr = this.nextTemp();
    lines.push(
      `  ${vtPtr} = getelementptr inbounds %${classInfo.name}, ptr ${obj}, i32 0, i32 0`,
    );
    lines.push(`  store ptr @${classInfo.vtableGlobalName}, ptr ${vtPtr}`);

    const args: EmittedValue[] = [];
    for (let i = 0; i < expr.args.length; i += 1) {
      args.push(this.emitExpression(expr.args[i]!, lines, classInfo.constructorParams[i]));
    }
    const argList = [
      `ptr ${obj}`,
      ...args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
    ].join(", ");
    lines.push(`  call void @${classInfo.constructorMangledName}(${argList})`);
    return { llvm: obj, type: { kind: "class", name: classInfo.name } };
  }

  private emitFunction(fn: FunctionDeclaration): void {
    this.locals = new Map();
    this.tempCounter = 0;
    this.loopStack.length = 0;
    const sig = this.localFunctions.get(fn.name.name);
    this.currentReturnType = sig?.returnType ?? "void";
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
    this.currentReturnType = null;
  }

  private emitFunctionHeader(fn: FunctionDeclaration): string {
    const sig = this.localFunctions.get(fn.name.name)!;
    const ret = sig.returnType === "void" ? "void" : toLlvmType(sig.returnType);
    const params = sig.params.map((t, i) => `${toLlvmType(t)} %arg${i}`).join(", ");
    return `define ${ret} @${sig.mangledName}(${params}) {`;
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
    const expected =
      this.currentReturnType && this.currentReturnType !== "void"
        ? this.currentReturnType
        : undefined;
    const value = this.emitExpression(stmt.value, lines, expected);
    lines.push(`  ret ${toLlvmType(value.type)} ${value.llvm}`);
  }

  private emitCallStatement(call: CallExpression, lines: string[]): void {
    if (call.callee.kind === "SuperExpression") {
      this.emitSuperCall(call, lines);
      return;
    }
    if (call.callee.kind === "MemberExpression") {
      if (this.isNamespaceCallee(call)) {
        this.emitNamespaceCall(call, lines, true);
        return;
      }
      this.emitMethodCall(call, lines, true);
      return;
    }
    if (call.callee.name === "print") {
      this.emitPrintCall(call, lines);
      return;
    }
    this.emitUserCall(call, lines, true);
  }

  private emitSuperCall(call: CallExpression, lines: string[]): void {
    if (!this.thisType || !isClassType(this.thisType)) {
      throw new Error("Codegen: super outside class constructor");
    }
    const info = this.classes.get(this.thisType.name);
    if (!info?.superclass) {
      throw new Error("Codegen: super without superclass");
    }
    const base = this.classes.get(info.superclass);
    if (!base) {
      throw new Error("Codegen: missing superclass info");
    }
    const args: EmittedValue[] = [];
    for (let i = 0; i < call.args.length; i += 1) {
      args.push(this.emitExpression(call.args[i]!, lines, base.constructorParams[i]));
    }
    const argList = [
      `ptr ${this.thisPtr}`,
      ...args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
    ].join(", ");
    lines.push(`  call void @${base.constructorMangledName}(${argList})`);
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
      case "StructLiteral": {
        const def = this.lookupStruct(expr.namespace?.name ?? null, expr.name.name);
        if (!def) {
          throw new Error(`Codegen: unknown struct '${expr.name.name}'`);
        }
        return { kind: "struct", name: def.name };
      }
      case "NewExpression": {
        const info = expr.namespace
          ? this.namespaces.get(expr.namespace.name)?.classes.get(expr.className.name)
          : this.localClasses.get(expr.className.name);
        if (!info) {
          throw new Error(`Codegen: unknown class '${expr.className.name}'`);
        }
        return { kind: "class", name: info.name };
      }
      case "ThisExpression": {
        if (!this.thisType) {
          throw new Error("Codegen: this outside method");
        }
        return this.thisType;
      }
      case "SuperExpression":
        throw new Error("Codegen: super used as value");
      case "IndexExpression": {
        const objectType = this.inferExpressionType(expr.object);
        if (!isArrayType(objectType)) {
          throw new Error("Codegen: index into non-array");
        }
        return objectType.element;
      }
      case "MemberExpression": {
        // ns.Enum.Variant
        if (
          expr.object.kind === "MemberExpression" &&
          expr.object.object.kind === "Identifier" &&
          this.namespaces.has(expr.object.object.name) &&
          !this.locals.has(expr.object.object.name)
        ) {
          const ns = this.namespaces.get(expr.object.object.name)!;
          const def = ns.enums.get(expr.object.property.name);
          if (def) {
            return { kind: "enum", name: def.name };
          }
        }
        if (
          expr.object.kind === "Identifier" &&
          this.localEnums.has(expr.object.name) &&
          !this.locals.has(expr.object.name)
        ) {
          return { kind: "enum", name: this.localEnums.get(expr.object.name)!.name };
        }
        if (expr.object.kind === "Identifier" && !this.locals.has(expr.object.name)) {
          const classInfo = this.localClasses.get(expr.object.name);
          if (classInfo) {
            const field = classInfo.staticFields.find((f) => f.name === expr.property.name);
            if (field) {
              return field.type;
            }
          }
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
        if (isClassType(objectType)) {
          const def = this.classes.get(objectType.name);
          if (!def) {
            throw new Error(`Codegen: unknown class '${objectType.name}'`);
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
        if (expr.callee.kind === "SuperExpression") {
          throw new Error("Codegen: super call in type inference");
        }
        if (expr.callee.kind === "MemberExpression") {
          if (this.isNamespaceCallee(expr)) {
            const ns = this.namespaces.get(
              (expr.callee.object as { kind: "Identifier"; name: string }).name,
            )!;
            const sig = ns.functions.get(expr.callee.property.name);
            if (!sig || sig.returnType === "void") {
              throw new Error(
                `Codegen: unexpected namespace call in type inference '${expr.callee.property.name}'`,
              );
            }
            return sig.returnType;
          }
          if (
            expr.callee.object.kind === "Identifier" &&
            !this.locals.has(expr.callee.object.name)
          ) {
            const classInfo = this.localClasses.get(expr.callee.object.name);
            const methodName = expr.callee.property.name;
            const method = classInfo?.staticMethods.find((m) => m.name === methodName);
            if (method) {
              if (method.returnType === "void") {
                throw new Error("Codegen: void static method in inference");
              }
              return method.returnType;
            }
          }
          const method = expr.callee.property.name;
          const objectType = this.inferExpressionType(expr.callee.object);
          if (isStructType(objectType)) {
            const def = this.structs.get(objectType.name);
            const m = def?.methods.find((x) => x.name === method);
            if (!m || m.returnType === "void") {
              throw new Error("Codegen: unexpected struct method in inference");
            }
            return m.returnType;
          }
          if (isClassType(objectType)) {
            const def = this.classes.get(objectType.name);
            const m = def?.instanceMethods.find((x) => x.name === method);
            if (!m || m.returnType === "void") {
              throw new Error("Codegen: unexpected class method in inference");
            }
            return m.returnType;
          }
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
        const sig = this.localFunctions.get(expr.callee.name);
        if (!sig || sig.returnType === "void") {
          throw new Error(`Codegen: unexpected call in type inference '${expr.callee.name}'`);
        }
        return sig.returnType;
      }
    }
  }

  private emitExpression(expr: Expression, lines: string[], expected?: ValueType): EmittedValue {
    const value = this.emitExpressionRaw(expr, lines, expected);
    if (expected) {
      return this.coerceValue(value, expected, lines);
    }
    return value;
  }

  private emitExpressionRaw(expr: Expression, lines: string[], expected?: ValueType): EmittedValue {
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
      case "NewExpression":
        return this.emitNewExpression(expr, lines);
      case "ThisExpression": {
        if (!this.thisPtr || !this.thisType) {
          throw new Error("Codegen: this outside method");
        }
        if (isStructType(this.thisType)) {
          const loaded = this.nextTemp();
          lines.push(`  ${loaded} = load %${this.thisType.name}, ptr ${this.thisPtr}`);
          return { llvm: loaded, type: this.thisType };
        }
        return { llvm: this.thisPtr, type: this.thisType };
      }
      case "SuperExpression":
        throw new Error("Codegen: super used as value");
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
          expr.object.kind === "MemberExpression" &&
          expr.object.object.kind === "Identifier" &&
          this.namespaces.has(expr.object.object.name) &&
          !this.locals.has(expr.object.object.name)
        ) {
          const ns = this.namespaces.get(expr.object.object.name)!;
          const def = ns.enums.get(expr.object.property.name);
          if (def) {
            const discriminant = def.variants.get(expr.property.name);
            if (discriminant === undefined) {
              throw new Error(`Codegen: unknown variant '${expr.property.name}'`);
            }
            const type: EnumValueType = { kind: "enum", name: def.name };
            return { llvm: String(discriminant), type };
          }
        }
        if (
          expr.object.kind === "Identifier" &&
          this.localEnums.has(expr.object.name) &&
          !this.locals.has(expr.object.name)
        ) {
          const def = this.localEnums.get(expr.object.name)!;
          const discriminant = def.variants.get(expr.property.name);
          if (discriminant === undefined) {
            throw new Error(`Codegen: unknown variant '${expr.property.name}'`);
          }
          const type: EnumValueType = { kind: "enum", name: def.name };
          return { llvm: String(discriminant), type };
        }
        if (expr.object.kind === "Identifier" && !this.locals.has(expr.object.name)) {
          const classInfo = this.localClasses.get(expr.object.name);
          if (classInfo) {
            const field = classInfo.staticFields.find((f) => f.name === expr.property.name);
            if (field?.staticGlobal) {
              const loaded = this.nextTemp();
              lines.push(
                `  ${loaded} = load ${toLlvmType(field.type)}, ptr @${field.staticGlobal}`,
              );
              return { llvm: loaded, type: field.type };
            }
          }
        }
        const objectType = this.inferExpressionType(expr.object);
        if (isStructType(objectType)) {
          return this.emitStructFieldLoad(expr, lines);
        }
        if (isClassType(objectType)) {
          return this.emitClassFieldLoad(expr, lines);
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
        if (expr.callee.kind === "SuperExpression") {
          this.emitSuperCall(expr, lines);
          return { llvm: "void", type: "i32" };
        }
        if (expr.callee.kind === "MemberExpression") {
          if (this.isNamespaceCallee(expr)) {
            return this.emitNamespaceCall(expr, lines, false);
          }
          return this.emitMethodCall(expr, lines, false);
        }
        return this.emitUserCall(expr, lines, false);
    }
  }

  private lookupStruct(namespace: string | null, name: string): StructInfo | undefined {
    if (namespace) {
      return this.namespaces.get(namespace)?.structs.get(name);
    }
    return this.localStructs.get(name);
  }

  private isNamespaceCallee(call: CallExpression): boolean {
    return (
      call.callee.kind === "MemberExpression" &&
      call.callee.object.kind === "Identifier" &&
      this.namespaces.has(call.callee.object.name) &&
      !this.locals.has(call.callee.object.name)
    );
  }

  private emitNamespaceCall(
    call: CallExpression,
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    if (call.callee.kind !== "MemberExpression" || call.callee.object.kind !== "Identifier") {
      throw new Error("Codegen: expected namespace call");
    }
    const ns = this.namespaces.get(call.callee.object.name);
    if (!ns) {
      throw new Error(`Codegen: unknown namespace '${call.callee.object.name}'`);
    }
    const sig = ns.functions.get(call.callee.property.name);
    if (!sig) {
      throw new Error(
        `Codegen: unknown function '${call.callee.object.name}.${call.callee.property.name}'`,
      );
    }
    return this.emitCallWithSig(sig, call.args, lines, asStatement);
  }

  private emitStructLiteral(expr: StructLiteral, lines: string[]): EmittedValue {
    const def = this.lookupStruct(expr.namespace?.name ?? null, expr.name.name);
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
    // Static class field
    if (expr.object.kind === "Identifier" && !this.locals.has(expr.object.name)) {
      const classInfo = this.localClasses.get(expr.object.name);
      if (classInfo) {
        const field = classInfo.staticFields.find((f) => f.name === expr.property.name);
        if (field?.staticGlobal) {
          return `@${field.staticGlobal}`;
        }
      }
    }

    const objectType = this.inferExpressionType(expr.object);
    if (isStructType(objectType)) {
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
    if (isClassType(objectType)) {
      const obj = this.emitExpression(expr.object, lines);
      const def = this.classes.get(objectType.name);
      if (!def) {
        throw new Error(`Codegen: unknown class '${objectType.name}'`);
      }
      const field = def.fields.find((f) => f.name === expr.property.name);
      if (!field) {
        throw new Error(`Codegen: unknown field '${expr.property.name}'`);
      }
      const fieldPtr = this.nextTemp();
      lines.push(
        `  ${fieldPtr} = getelementptr inbounds %${def.name}, ptr ${obj.llvm}, i32 0, i32 ${field.fieldIndex}`,
      );
      return fieldPtr;
    }
    throw new Error("Codegen: member field on non-struct/class");
  }

  private emitClassFieldLoad(expr: MemberExpression, lines: string[]): EmittedValue {
    const fieldPtr = this.emitMemberFieldPtr(expr, lines);
    const fieldType = this.inferExpressionType(expr);
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${toLlvmType(fieldType)}, ptr ${fieldPtr}`);
    return { llvm: loaded, type: fieldType };
  }

  /** Pointer to a struct value in memory (local alloca, nested field, or temp). */
  private emitStructAddress(
    expr: Expression,
    expected: StructValueType,
    lines: string[],
  ): string {
    if (expr.kind === "ThisExpression") {
      if (!this.thisPtr || !this.thisType || !isStructType(this.thisType)) {
        throw new Error("Codegen: this is not a struct pointer");
      }
      return this.thisPtr;
    }

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
    const callee = call.callee;

    // Static method: ClassName.method(...)
    if (callee.object.kind === "Identifier" && !this.locals.has(callee.object.name)) {
      const classInfo = this.localClasses.get(callee.object.name);
      const method = classInfo?.staticMethods.find((m) => m.name === callee.property.name);
      if (method) {
        const args: EmittedValue[] = [];
        for (let i = 0; i < call.args.length; i += 1) {
          args.push(this.emitExpression(call.args[i]!, lines, method.params[i]));
        }
        const argList = args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`).join(", ");
        if (method.returnType === "void") {
          lines.push(`  call void @${method.mangledName}(${argList})`);
          if (!asStatement) {
            throw new Error("Codegen: void static method used as value");
          }
          return { llvm: "void", type: "i32" };
        }
        const tmp = this.nextTemp();
        const retTy = toLlvmType(method.returnType);
        lines.push(`  ${tmp} = call ${retTy} @${method.mangledName}(${argList})`);
        return { llvm: tmp, type: method.returnType };
      }
    }

    const objectType = this.inferExpressionType(callee.object);

    if (isStructType(objectType)) {
      const def = this.structs.get(objectType.name);
      const method = def?.methods.find((m) => m.name === callee.property.name);
      if (!def || !method) {
        throw new Error(`Codegen: unknown struct method '${callee.property.name}'`);
      }
      const thisAddr = this.emitStructAddress(callee.object, objectType, lines);
      const args: EmittedValue[] = [];
      for (let i = 0; i < call.args.length; i += 1) {
        args.push(this.emitExpression(call.args[i]!, lines, method.params[i]));
      }
      const argList = [
        `ptr ${thisAddr}`,
        ...args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
      ].join(", ");
      if (method.returnType === "void") {
        lines.push(`  call void @${method.mangledName}(${argList})`);
        if (!asStatement) {
          throw new Error("Codegen: void struct method used as value");
        }
        return { llvm: "void", type: "i32" };
      }
      const tmp = this.nextTemp();
      const retTy = toLlvmType(method.returnType);
      lines.push(`  ${tmp} = call ${retTy} @${method.mangledName}(${argList})`);
      return { llvm: tmp, type: method.returnType };
    }

    if (isClassType(objectType)) {
      const def = this.classes.get(objectType.name);
      const method = def?.instanceMethods.find((m) => m.name === callee.property.name);
      if (!def || !method) {
        throw new Error(`Codegen: unknown class method '${callee.property.name}'`);
      }
      const obj = this.emitExpression(callee.object, lines);
      const args: EmittedValue[] = [];
      for (let i = 0; i < call.args.length; i += 1) {
        args.push(this.emitExpression(call.args[i]!, lines, method.params[i]));
      }
      const argList = [
        `ptr ${obj.llvm}`,
        ...args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
      ].join(", ");

      // Concrete class with no subclasses: direct call. Otherwise vtable (inheritance).
      const mayHaveSubclasses = [...this.classes.values()].some(
        (c) => c.superclass === def.name,
      );
      const useDirectCall = !def.isAbstract && !mayHaveSubclasses;
      if (useDirectCall) {
        if (method.returnType === "void") {
          lines.push(`  call void @${method.mangledName}(${argList})`);
          if (!asStatement) {
            throw new Error("Codegen: void class method used as value");
          }
          return { llvm: "void", type: "i32" };
        }
        const tmp = this.nextTemp();
        const retTy = toLlvmType(method.returnType);
        lines.push(`  ${tmp} = call ${retTy} @${method.mangledName}(${argList})`);
        return { llvm: tmp, type: method.returnType };
      }

      // Virtual dispatch via vtable
      const vtField = this.nextTemp();
      lines.push(
        `  ${vtField} = getelementptr inbounds %${def.name}, ptr ${obj.llvm}, i32 0, i32 0`,
      );
      const vt = this.nextTemp();
      lines.push(`  ${vt} = load ptr, ptr ${vtField}`);
      const slotPtr = this.nextTemp();
      lines.push(
        `  ${slotPtr} = getelementptr inbounds %${def.name}__vtable_type, ptr ${vt}, i32 0, i32 ${method.vtableSlot}`,
      );
      const fnPtr = this.nextTemp();
      lines.push(`  ${fnPtr} = load ptr, ptr ${slotPtr}`);
      if (method.returnType === "void") {
        lines.push(`  call void ${fnPtr}(${argList})`);
        if (!asStatement) {
          throw new Error("Codegen: void class method used as value");
        }
        return { llvm: "void", type: "i32" };
      }
      const tmp = this.nextTemp();
      const retTy = toLlvmType(method.returnType);
      lines.push(`  ${tmp} = call ${retTy} ${fnPtr}(${argList})`);
      return { llvm: tmp, type: method.returnType };
    }

    if (isInterfaceType(objectType)) {
      const def = this.interfaces.get(objectType.name);
      const method = def?.methods.find((m) => m.name === callee.property.name);
      if (!def || !method) {
        throw new Error(`Codegen: unknown interface method '${callee.property.name}'`);
      }
      const obj = this.emitExpression(callee.object, lines);
      const args: EmittedValue[] = [];
      for (let i = 0; i < call.args.length; i += 1) {
        args.push(this.emitExpression(call.args[i]!, lines, method.params[i]));
      }
      const data = this.nextTemp();
      lines.push(`  ${data} = extractvalue %${def.name} ${obj.llvm}, 0`);
      const itable = this.nextTemp();
      lines.push(`  ${itable} = extractvalue %${def.name} ${obj.llvm}, 1`);
      const slotPtr = this.nextTemp();
      lines.push(
        `  ${slotPtr} = getelementptr inbounds %${def.name}__itable_type, ptr ${itable}, i32 0, i32 ${method.itableSlot}`,
      );
      const fnPtr = this.nextTemp();
      lines.push(`  ${fnPtr} = load ptr, ptr ${slotPtr}`);
      const argList = [
        `ptr ${data}`,
        ...args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
      ].join(", ");
      if (method.returnType === "void") {
        lines.push(`  call void ${fnPtr}(${argList})`);
        if (!asStatement) {
          throw new Error("Codegen: void interface method used as value");
        }
        return { llvm: "void", type: "i32" };
      }
      const tmp = this.nextTemp();
      const retTy = toLlvmType(method.returnType);
      lines.push(`  ${tmp} = call ${retTy} ${fnPtr}(${argList})`);
      return { llvm: tmp, type: method.returnType };
    }

    const object = this.emitExpression(callee.object, lines);
    if (!isArrayType(object.type)) {
      throw new Error("Codegen: method on non-array");
    }

    const method = callee.property.name;
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
    const sig = this.localFunctions.get(call.callee.name);
    if (!sig) {
      throw new Error(`Codegen: unknown function '${call.callee.name}'`);
    }
    return this.emitCallWithSig(sig, call.args, lines, asStatement);
  }

  private emitCallWithSig(
    sig: FunctionSig,
    args: Expression[],
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    const emittedArgs: EmittedValue[] = [];
    for (let i = 0; i < args.length; i += 1) {
      emittedArgs.push(this.emitExpression(args[i]!, lines, sig.params[i]));
    }

    const argList = emittedArgs.map((a) => `${toLlvmType(a.type)} ${a.llvm}`).join(", ");
    const argSuffix = argList ? argList : "";

    if (sig.returnType === "void") {
      lines.push(`  call void @${sig.mangledName}(${argSuffix})`);
      if (!asStatement) {
        throw new Error(`Codegen: void call '${sig.name}' used as value`);
      }
      return { llvm: "void", type: "i32" };
    }

    const tmp = this.nextTemp();
    const retTy = toLlvmType(sig.returnType);
    lines.push(`  ${tmp} = call ${retTy} @${sig.mangledName}(${argSuffix})`);
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
    if (type.kind === "struct" || type.kind === "interface") {
      return `%${type.name}`;
    }
    if (type.kind === "enum") {
      return "i32";
    }
    // class and array are pointers
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

function zeroInitializer(type: ValueType): string {
  if (typeof type === "object") {
    if (type.kind === "enum") {
      return "0";
    }
    if (type.kind === "struct" || type.kind === "interface") {
      return "zeroinitializer";
    }
    return "null";
  }
  switch (type) {
    case "i32":
    case "i64":
    case "char":
      return "0";
    case "f32":
    case "f64":
      return "0.0";
    case "bool":
      return "false";
    case "string":
      return "null";
  }
}

function classObjectByteSize(
  info: ClassInfo,
  structs: Map<string, StructInfo>,
): number {
  let size = 8; // vtable ptr
  for (const field of info.fields) {
    const align = fieldAlign(field.type);
    size = alignUp(size, align);
    size += elementByteSize(field.type, structs);
  }
  return alignUp(size, 8);
}

function elementByteSize(type: ValueType, structs?: Map<string, StructInfo>): number {
  if (typeof type === "object") {
    if (type.kind === "struct") {
      return structByteSize(type.name, structs);
    }
    if (type.kind === "interface") {
      return 16; // { ptr, ptr }
    }
    if (type.kind === "enum") {
      return 4;
    }
    // class / array ptr
    return 8;
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

function fieldAlign(type: ValueType): number {
  if (typeof type === "object") {
    if (type.kind === "interface") {
      return 8;
    }
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

function itableGlobalName(classMangled: string, ifaceMangled: string): string {
  return `${classMangled}__${ifaceMangled}__itable`;
}

function alignUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
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
