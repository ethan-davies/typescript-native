import type {
  AssignmentStatement,
  BinaryExpression,
  CallArgument,
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
  LambdaExpression,
  MemberExpression,
  ModuleVariableDeclaration,
  NewExpression,
  Parameter,
  Program,
  ReturnStatement,
  Statement,
  StructDeclaration,
  StructLiteral,
  StructMethod,
  SwitchStatement,
  TemplateLiteral,
  ThrowStatement,
  TryStatement,
  TypeAnnotation,
  TypeAliasDeclaration,
  UnaryExpression,
  UpdateStatement,
  VariableDeclaration,
  WhileStatement,
} from "../ast/nodes.js";
import type { TypecheckInstantiations } from "../generics/monomorphize.js";
import { mangleTypeAnnotation } from "../generics/mangle.js";
import { valueTypeToAnnotation } from "../generics/value-type.js";
import { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import { buildExportTables } from "../modules/exports.js";
import { mangleSymbol } from "../modules/mangle.js";
import type { ResolvedModule } from "../modules/resolve.js";
import {
  BUILTIN_ERROR_LOCAL_NAME,
  BUILTIN_ERROR_MANGLED,
  createBuiltinErrorClassDeclaration,
} from "../builtins/error.js";
import {
  isArrayType,
  isAssignable,
  isClassType,
  isEnumType,
  isInterfaceType,
  isStructType,
  isTupleType,
  typesEqual,
  typeToString,
  type EnumValueType,
  type FunctionValueType,
  type StructValueType,
  type TupleValueType,
  type ValueType,
} from "../typecheck.js";
import {
  flattenUnion,
  includesNull,
  isFunctionType,
  isLiteralType,
  isMapType,
  isObjectType,
  isUnionType,
  makeUnion,
  stripNull,
  typeofTagForType,
} from "../typecheck-advanced.js";
import { isReferenceCategory } from "../types/category.js";
import { substituteAnnotation } from "../generics/substitute.js";

/** Filled during emit so free `toLlvmType` can register synthetic tuple aggregates. */
let activeTupleRegistry: Map<string, readonly ValueType[]> | null = null;

/**
 * Reference types whose LLVM payload is a bare `ptr` (not `%__Callable`).
 * Driven by TypeCategory: class/array/map/string/null are single-ptr references;
 * function/closure references lower as `%__Callable` handles instead.
 */
function isSinglePtrReference(type: ValueType): boolean {
  if (!isReferenceCategory(type)) {
    return false;
  }
  return typeof type !== "object" || type.kind !== "function";
}

/** `T | null` where every non-null arm is a single ptr — lower as bare `ptr`. */
function isNullablePointerUnion(type: ValueType): boolean {
  if (!isUnionType(type)) {
    return false;
  }
  const arms = flattenUnion(type);
  if (!arms.some((a) => a === "null")) {
    return false;
  }
  const nonNull = arms.filter((a) => a !== "null");
  return (
    nonNull.length > 0 &&
    nonNull.every((a) => isSinglePtrReference(a as ValueType))
  );
}

/** Typecheck rewrites named/default args to a positional Expression[] before codegen. */
function asExpressions(args: readonly CallArgument[]): Expression[] {
  return args as Expression[];
}

/** Union tag constants matching typeofTagForType. */
const UNION_TAG = {
  string: 0,
  i32: 1,
  bool: 2,
  object: 3,
  null: 4,
  i64: 5,
  f32: 6,
  f64: 7,
  char: 8,
} as const;

interface LocalBinding {
  readonly ptr: string;
  readonly type: ValueType;
  /** When true, `ptr` is an alloca of a heap-box pointer (mutable capture). */
  readonly boxed: boolean;
}

interface LambdaCaptureLowering {
  readonly name: string;
  readonly mutable: boolean;
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
  readonly isExtern: boolean;
}

interface ModuleValueInfo {
  readonly name: string;
  readonly mangledName: string;
  readonly type: ValueType;
  readonly mutability: "let" | "const";
  readonly decl: ModuleVariableDeclaration;
  /** True when the global initializer was emitted as a compile-time constant. */
  readonly hasConstantInit: boolean;
}

interface NamespaceInfo {
  readonly functions: ReadonlyMap<string, FunctionSig>;
  readonly structs: ReadonlyMap<string, StructInfo>;
  readonly enums: ReadonlyMap<string, EnumInfo>;
  readonly classes: ReadonlyMap<string, ClassInfo>;
  readonly interfaces: ReadonlyMap<string, InterfaceInfo>;
  readonly values: ReadonlyMap<string, ModuleValueInfo>;
}

type ControlContext =
  | {
      readonly kind: "loop";
      readonly continueLabel: string;
      readonly breakLabel: string;
    }
  | { readonly kind: "switch"; readonly breakLabel: string }
  | {
      readonly kind: "try";
      readonly framePtr: string;
      readonly normalLeaveLabel: string;
      readonly afterLabel: string;
      readonly hasFinally: boolean;
      readonly finallyOnly: boolean;
    };

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
  /** Runtime type identity stored in ObjectHeader.type_id. */
  readonly typeId: number;
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

const COMPARISON_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);
const LOGICAL_OPS = new Set(["&&", "||"]);

/** Array header: { i64 length, i64 capacity, ptr data } — 24 bytes. */
const ARRAY_HEADER_SIZE = 24;

/** Shared header on every class instance: { type_id, vtable }. */
const OBJECT_HEADER_TYPE = "%ObjectHeader";

/** Must match SN_EH_FRAME_SIZE in packages/runtime/include/sn/runtime.h */
const SN_EH_FRAME_SIZE = 256;

/** Reserved builtin type_ids — must match SN_TYPEID_* in runtime.h */
const SN_TYPEID_STRING = 1;
const SN_TYPEID_ARRAY = 2;
const SN_TYPEID_MAP = 3;
const SN_TYPEID_CLOSURE = 4;
const SN_TYPEID_CLASS_BASE = 256;

const SN_KIND_CLASS = 1;
const SN_KIND_ENV = 6;
const SN_KIND_STRUCT = 7;
const SN_REF_VALUE = 0;
const SN_REF_PTR = 1;
const SN_REF_AGG = 2;

interface EnvTypeInfoPending {
  readonly globalName: string;
  readonly typeId: number;
  readonly llvmType: string;
  fields: TypeInfoFieldConst[];
  /** SN_KIND_ENV or SN_KIND_STRUCT */
  readonly kind: number;
}

/** Must match SnFieldInfo / SnTypeInfo in runtime.h */
const SN_FIELD_INFO_TYPE = "%SnFieldInfo";
const SN_TYPE_INFO_TYPE = "%SnTypeInfo";

/**
 * Lowers a validated, type-checked AST to LLVM IR text.
 */
export class LlvmCodegen {
  private stringCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private readonly stringGlobals = new Map<
    string,
    { name: string; length: number }
  >();
  private locals = new Map<string, LocalBinding>();
  /** All functions keyed by mangled LLVM name. */
  private functions = new Map<string, FunctionSig>();
  /** Current module: local name → mangled function. */
  private localFunctions = new Map<string, FunctionSig>();
  /** Current module: local name → module-level value. */
  private localValues = new Map<string, ModuleValueInfo>();
  /** All module values by mangled name. */
  private readonly allModuleValues = new Map<string, ModuleValueInfo>();
  /** Module init helpers that must run before main (mangled function names). */
  private readonly moduleInitFns: string[] = [];
  private structs = new Map<string, StructInfo>();
  private localStructs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private localEnums = new Map<string, EnumInfo>();
  private classes = new Map<string, ClassInfo>();
  private localClasses = new Map<string, ClassInfo>();
  private interfaces = new Map<string, InterfaceInfo>();
  private localInterfaces = new Map<string, InterfaceInfo>();
  private namespaces = new Map<string, NamespaceInfo>();
  /** Next monotonic type_id for class ObjectHeaders / env TypeInfo (starts at SN_TYPEID_CLASS_BASE). */
  private nextTypeId = SN_TYPEID_CLASS_BASE;
  private needsTypeInfo = false;
  private needsGc = false;
  /** Shadow-stack roots pushed in the current function (informational; epilogue uses restore). */
  private gcRootCount = 0;
  /** Alloca holding root_len at function entry (before this frame's pushes). */
  private gcEntryCheckpoint: string | null = null;
  /** Function-scoped slot holding the latest heap pointer across allocating calls. */
  private gcExprRoot: string | null = null;
  /** Closure environment TypeInfo records to emit alongside class TypeInfo. */
  private readonly pendingEnvTypeInfos: EnvTypeInfoPending[] = [];
  private needsSnAlloc = false;
  private needsSnString = false;
  private needsSnArray = false;
  private needsSnMap = false;
  private needsSnPrint = false;
  private needsSnFormat = false;
  private needsAbort = false;
  private needsUnionRuntime = false;
  private needsCallableRuntime = false;
  private needsStrcmp = false;
  private needsSnException = false;
  private needsIsInstance = false;
  /** Deferred return through a finally block. */
  private pendingReturn: {
    readonly llvm: string;
    readonly type: ValueType | "void";
  } | null = null;
  /** Deferred break/continue through a finally block. */
  private pendingBranch: string | null = null;
  /** Synthetic tuple LLVM type name → element types. */
  private readonly registeredTuples = new Map<string, readonly ValueType[]>();
  /** Local type alias expansions (local name → annotation). */
  private typeAliases = new Map<string, TypeAnnotation>();
  /** Generic type aliases (local name → declaration) for expanding `Alias<T>` in annotations. */
  private genericTypeAliases = new Map<string, TypeAliasDeclaration>();
  private readonly functionBodies: string[] = [];
  private readonly globalDefs: string[] = [];
  private readonly controlStack: ControlContext[] = [];
  /** When emitting a method/constructor, the `this` pointer SSA value. */
  private thisPtr: string | null = null;
  private thisType: ValueType | null = null;
  /** Return type of the function/method currently being emitted. */
  private currentReturnType: ValueType | "void" | null = null;
  private currentModuleId = "";
  private lambdaCaptures = new Map<
    number,
    readonly { readonly name: string; readonly mutable: boolean }[]
  >();
  private lambdaCounter = 0;
  private readonly emittedLambdas = new Set<number>();
  private readonly emittedTrampolines = new Set<string>();
  /** Mutable locals that must be heap-boxed in the current function. */
  private boxedNames = new Set<string>();
  /** When emitting a lambda body: env pointer SSA + capture layout. */
  private currentLambdaEnv: string | null = null;
  private currentLambdaEnvTypeName: string | null = null;
  private currentLambdaCaptureLayout: LambdaCaptureLowering[] = [];
  /** CallExpression span → mangled name for extension method calls. */
  private extensionCallRewrites = new Map<number, string>();
  /** Extern symbols that need `declare` in the module. */
  private readonly externDeclares = new Set<string>();
  private needsSnStrExtras = false;

  emit(program: Program): string {
    return this.emitModules([
      {
        path: "<source>",
        identity: "file://<source>",
        source: "",
        ast: program,
        moduleId: "",
        isEntry: true,
        imports: [],
        reexportSources: [],
      },
    ]);
  }

  emitModules(
    modules: readonly ResolvedModule[],
    instantiations?: TypecheckInstantiations,
  ): string {
    this.stringCounter = 0;
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.stringGlobals.clear();
    this.locals = new Map();
    this.functions.clear();
    this.lambdaCaptures = new Map(instantiations?.lambdaCaptures ?? []);
    this.extensionCallRewrites = new Map(
      instantiations?.extensionCallRewrites ?? [],
    );
    this.lambdaCounter = 0;
    this.emittedLambdas.clear();
    this.emittedTrampolines.clear();
    this.needsCallableRuntime = false;
    this.localFunctions.clear();
    this.localValues.clear();
    this.allModuleValues.clear();
    this.moduleInitFns.length = 0;
    this.structs.clear();
    this.localStructs.clear();
    this.enums.clear();
    this.localEnums.clear();
    this.classes.clear();
    this.localClasses.clear();
    this.interfaces.clear();
    this.localInterfaces.clear();
    this.namespaces.clear();
    this.nextTypeId = SN_TYPEID_CLASS_BASE;
    this.needsTypeInfo = false;
    this.needsGc = false;
    this.gcRootCount = 0;
    this.gcEntryCheckpoint = null;
    this.gcExprRoot = null;
    this.pendingEnvTypeInfos.length = 0;
    this.needsSnAlloc = false;
    this.needsSnString = false;
    this.needsSnStrExtras = false;
    this.needsSnArray = false;
    this.needsSnMap = false;
    this.needsSnPrint = false;
    this.needsSnFormat = false;
    this.needsAbort = false;
    this.needsUnionRuntime = false;
    this.needsStrcmp = false;
    this.needsSnException = false;
    this.needsIsInstance = false;
    this.externDeclares.clear();
    this.registeredTuples.clear();
    this.typeAliases = new Map();
    this.genericTypeAliases = new Map();
    this.functionBodies.length = 0;
    this.globalDefs.length = 0;
    this.controlStack.length = 0;
    this.thisPtr = null;
    this.thisType = null;

    activeTupleRegistry = this.registeredTuples;

    const moduleSymbols = new Map<
      string,
      {
        functions: Map<string, FunctionSig>;
        structs: Map<string, StructInfo>;
        enums: Map<string, EnumInfo>;
        classes: Map<string, ClassInfo>;
        interfaces: Map<string, InterfaceInfo>;
        values: Map<string, ModuleValueInfo>;
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
        if (decl.kind === "TypeAliasDeclaration") {
          if (decl.typeParams.length === 0) {
            this.typeAliases.set(decl.name.name, decl.type);
          } else {
            this.genericTypeAliases.set(decl.name.name, decl);
          }
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

      this.registerBuiltinErrorClass(
        mod.moduleId,
        localStructs,
        localEnums,
        localClasses,
        localInterfaces,
      );

      for (const decl of mod.ast.body) {
        if (decl.kind === "ClassDeclaration") {
          if (decl.typeParams.length > 0) {
            continue;
          }
          if (decl.name.name === BUILTIN_ERROR_LOCAL_NAME) {
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
            throw new Error(
              `Codegen: invalid field type in struct '${decl.name.name}'`,
            );
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
              throw new Error(
                `Codegen: invalid method param in '${method.name.name}'`,
              );
            }
            return t;
          });
          const returnType =
            method.returnType.kind === "PrimitiveType" &&
            method.returnType.name === "void"
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
            throw new Error(
              `Codegen: invalid method return in '${method.name.name}'`,
            );
          }
          return {
            name: method.name.name,
            mangledName: mangleSymbol(
              mod.moduleId,
              `${decl.name.name}__${method.name.name}`,
            ),
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
        if (decl.name.name === BUILTIN_ERROR_LOCAL_NAME) {
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
        // Register all externs (including generic) under their C symbol name.
        if (decl.isExtern) {
          let params: ValueType[] = [];
          let returnType: ValueType | "void" = "void";
          if (decl.typeParams.length === 0) {
            params = decl.params.map((p) => {
              const t = this.resolveAnnotationInModule(
                p.typeAnnotation,
                localStructs,
                localEnums,
                localClasses,
                localInterfaces,
                new Map(),
              );
              if (!t) {
                throw new Error(
                  `Codegen: invalid parameter type for '${p.name.name}'`,
                );
              }
              return t;
            });
            let resolvedReturn: ValueType | "void" | null =
              decl.returnType.kind === "PrimitiveType" &&
              decl.returnType.name === "void"
                ? ("void" as const)
                : this.resolveAnnotationInModule(
                    decl.returnType,
                    localStructs,
                    localEnums,
                    localClasses,
                    localInterfaces,
                    new Map(),
                  );
            if (resolvedReturn === null) {
              throw new Error(
                `Codegen: invalid return type for '${decl.name.name}'`,
              );
            }
            returnType = resolvedReturn;
          } else {
            // Generic extern: signature is ABI-specialized at the call site.
            returnType =
              decl.returnType.kind === "PrimitiveType" &&
              decl.returnType.name === "void"
                ? ("void" as const)
                : "i32";
          }
          const sig: FunctionSig = {
            name: decl.name.name,
            mangledName: decl.name.name,
            params,
            returnType,
            isExtern: true,
          };
          localFns.set(decl.name.name, sig);
          this.functions.set(decl.name.name, sig);
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
            throw new Error(
              `Codegen: invalid parameter type for '${p.name.name}'`,
            );
          }
          return t;
        });
        const returnType =
          fn.returnType.kind === "PrimitiveType" &&
          fn.returnType.name === "void"
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
          fn.name.name === "main"
            ? "main"
            : mangleSymbol(mod.moduleId, fn.name.name);
        const sig: FunctionSig = {
          name: fn.name.name,
          mangledName,
          params,
          returnType,
          isExtern: false,
        };
        localFns.set(fn.name.name, sig);
        this.functions.set(mangledName, sig);
      }

      const localValues = new Map<string, ModuleValueInfo>();
      for (const decl of mod.ast.body) {
        if (decl.kind !== "ModuleVariableDeclaration") {
          continue;
        }
        const type =
          decl.typeAnnotation !== null
            ? this.resolveAnnotationInModule(
                decl.typeAnnotation,
                localStructs,
                localEnums,
                localClasses,
                localInterfaces,
                new Map(),
              )
            : inferLiteralModuleType(decl.initializer);
        if (!type) {
          throw new Error(
            `Codegen: invalid module variable type for '${decl.name.name}'`,
          );
        }
        const mangledName = mangleSymbol(mod.moduleId, decl.name.name);
        const hasConstantInit = isConstantModuleInit(decl.initializer);
        const info: ModuleValueInfo = {
          name: decl.name.name,
          mangledName,
          type,
          mutability: decl.mutability,
          decl,
          hasConstantInit,
        };
        localValues.set(decl.name.name, info);
        this.allModuleValues.set(mangledName, info);
        this.emitModuleValueGlobal(info);
      }

      moduleSymbols.set(mod.path, {
        functions: localFns,
        structs: localStructs,
        enums: localEnums,
        classes: localClasses,
        interfaces: localInterfaces,
        values: localValues,
      });
    }

    // Emit deferred module value inits (non-constant initializers).
    // Prefer non-entry modules first so dependents see initialized values.
    const modsForInit = [
      ...modules.filter((m) => !m.isEntry),
      ...modules.filter((m) => m.isEntry),
    ];
    for (const mod of modsForInit) {
      const symbols = moduleSymbols.get(mod.path)!;
      const deferred = [...symbols.values.values()].filter(
        (v) => !v.hasConstantInit,
      );
      if (deferred.length === 0) {
        continue;
      }
      const initName = `__sn_init_${mod.moduleId || "main"}`;
      this.moduleInitFns.push(initName);
      const lines: string[] = [];
      lines.push(`define void @${initName}() {`);
      lines.push("entry:");
      this.localValues = new Map(symbols.values);
      this.localFunctions = new Map(symbols.functions);
      this.localStructs = new Map(symbols.structs);
      this.localEnums = new Map(symbols.enums);
      this.localClasses = new Map(symbols.classes);
      this.localInterfaces = new Map(symbols.interfaces);
      this.tempCounter = 0;
      for (const val of deferred) {
        const value = this.emitExpression(val.decl.initializer, lines, val.type);
        lines.push(
          `  store ${toLlvmType(val.type)} ${value.llvm}, ptr @${val.mangledName}`,
        );
      }
      lines.push("  ret void");
      lines.push("}");
      lines.push("");
      this.functionBodies.push(...lines);
    }

    // Emit function/method bodies with per-module local/namespace context.
    for (const mod of modules) {
      const symbols = moduleSymbols.get(mod.path)!;
      const localFunctions = new Map(symbols.functions);
      const localStructs = new Map(symbols.structs);
      const localEnums = new Map(symbols.enums);
      const localClasses = new Map(symbols.classes);
      const localInterfaces = new Map(symbols.interfaces);
      const localValues = new Map(symbols.values);
      this.currentModuleId = mod.moduleId;

      const namespaces = new Map<string, NamespaceInfo>();
      const exportTables = buildExportTables(
        modules.map((m) => ({
          path: m.path,
          ast: m.ast,
          reexportSources: m.reexportSources,
        })),
        new DiagnosticCollector(),
      );

      for (const binding of mod.imports) {
        const imported = moduleSymbols.get(binding.modulePath);
        if (!imported) {
          continue;
        }
        const importedTable = exportTables.get(binding.modulePath);
        if (!importedTable) {
          continue;
        }

        if (binding.kind === "namespace") {
          const exportedFns = new Map<string, FunctionSig>();
          const exportedStructs = new Map<string, StructInfo>();
          const exportedEnums = new Map<string, EnumInfo>();
          const exportedClasses = new Map<string, ClassInfo>();
          const exportedInterfaces = new Map<string, InterfaceInfo>();
          const exportedValues = new Map<string, ModuleValueInfo>();

          for (const [exportName, entry] of importedTable) {
            const origin = moduleSymbols.get(entry.sourceModulePath);
            if (!origin) {
              continue;
            }
            const fn = origin.functions.get(entry.originalName);
            if (fn) {
              exportedFns.set(exportName, fn);
              continue;
            }
            const st = origin.structs.get(entry.originalName);
            if (st) {
              exportedStructs.set(exportName, st);
              continue;
            }
            const en = origin.enums.get(entry.originalName);
            if (en) {
              exportedEnums.set(exportName, en);
              continue;
            }
            const cl = origin.classes.get(entry.originalName);
            if (cl) {
              exportedClasses.set(exportName, cl);
              continue;
            }
            const iface = origin.interfaces.get(entry.originalName);
            if (iface) {
              exportedInterfaces.set(exportName, iface);
              continue;
            }
            const val = origin.values.get(entry.originalName);
            if (val) {
              exportedValues.set(exportName, val);
            }
          }
          namespaces.set(binding.alias, {
            functions: exportedFns,
            structs: exportedStructs,
            enums: exportedEnums,
            classes: exportedClasses,
            interfaces: exportedInterfaces,
            values: exportedValues,
          });
          continue;
        }

        const entry = importedTable.get(binding.exportName);
        if (!entry) {
          continue;
        }
        const origin = moduleSymbols.get(entry.sourceModulePath);
        const originMod = modules.find((m) => m.path === entry.sourceModulePath);
        if (!origin || !originMod) {
          continue;
        }
        const localName = binding.localName;

        const fnSig = origin.functions.get(entry.originalName);
        if (fnSig) {
          localFunctions.set(localName, fnSig);
          continue;
        }
        const stInfo = origin.structs.get(entry.originalName);
        if (stInfo) {
          localStructs.set(localName, stInfo);
          continue;
        }
        const enInfo = origin.enums.get(entry.originalName);
        if (enInfo) {
          localEnums.set(localName, enInfo);
          continue;
        }
        const clInfo = origin.classes.get(entry.originalName);
        if (clInfo) {
          localClasses.set(localName, clInfo);
          continue;
        }
        const ifaceInfo = origin.interfaces.get(entry.originalName);
        if (ifaceInfo) {
          localInterfaces.set(localName, ifaceInfo);
          continue;
        }
        const valInfo = origin.values.get(entry.originalName);
        if (valInfo) {
          localValues.set(localName, valInfo);
          continue;
        }

        const tDecl = originMod.ast.body.find(
          (d) =>
            d.kind === "TypeAliasDeclaration" &&
            d.name.name === entry.originalName &&
            d.exported,
        );
        if (tDecl?.kind === "TypeAliasDeclaration") {
          if (tDecl.typeParams.length === 0) {
            this.typeAliases.set(localName, tDecl.type);
          } else {
            this.genericTypeAliases.set(localName, tDecl);
          }
        }
      }

      this.localFunctions = localFunctions;
      this.localStructs = localStructs;
      this.localEnums = localEnums;
      this.localClasses = localClasses;
      this.localInterfaces = localInterfaces;
      this.localValues = localValues;
      this.namespaces = namespaces;

      for (const decl of mod.ast.body) {
        if (decl.kind === "FunctionDeclaration") {
          if (decl.isExtern) {
            continue;
          }
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

    const builtinError = this.classes.get(BUILTIN_ERROR_MANGLED);
    if (builtinError) {
      this.emitClassMembers(builtinError);
    }

    this.emitClassGlobals();
    this.emitTypeInfoGlobals();

    const structTypeLines = this.emitStructTypeDefs();
    const tupleTypeLines = this.emitTupleTypeDefs();
    const interfaceTypeLines = this.emitInterfaceTypeDefs();
    const classTypeLines = this.emitClassTypeDefs();
    const objectHeaderLines =
      classTypeLines.length > 0
        ? [`${OBJECT_HEADER_TYPE} = type { i32, ptr }`]
        : [];
    const typeInfoTypeLines = this.needsTypeInfo
      ? [
          `${SN_FIELD_INFO_TYPE} = type { i32, i32, i32, i32 }`,
          `${SN_TYPE_INFO_TYPE} = type { i32, i32, i32, i32, ptr, i32, i32, i32, i32, i32, i32, i32 }`,
        ]
      : [];
    const unionTypeLines = this.needsUnionRuntime
      ? ["%__Union = type { i32, ptr }"]
      : [];
    const callableTypeLines = this.needsCallableRuntime
      ? ["%__Callable = type { ptr, ptr }"]
      : [];
    const typeLines = [
      ...objectHeaderLines,
      ...typeInfoTypeLines,
      ...structTypeLines,
      ...tupleTypeLines,
      ...interfaceTypeLines,
      ...classTypeLines,
      ...unionTypeLines,
      ...callableTypeLines,
    ];
    const globalLines = [...this.globalDefs, ...this.emitStringGlobals()];
    const declares = this.emitRuntimeDeclares();

    const ir = [
      "; ModuleID = 'sonite'",
      'source_filename = "sonite"',
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
    activeTupleRegistry = null;
    return ir;
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

  private registerStruct(
    decl: StructDeclaration,
    moduleId: string,
  ): StructInfo {
    const info: StructInfo = {
      name: mangleSymbol(moduleId, decl.name.name),
      localName: decl.name.name,
      fields: [],
      methods: [],
    };
    this.structs.set(info.name, info);
    return info;
  }

  private registerClassStub(
    decl: ClassDeclaration,
    moduleId: string,
  ): ClassInfo {
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
      constructorMangledName: mangleSymbol(
        moduleId,
        `${decl.name.name}__constructor`,
      ),
      constructorDecl: null,
      vtableGlobalName: `${mangled}__vtable`,
      typeId: 0,
      decl,
    };
  }

  /**
   * Resolve a class by local name (current module) or by local/mangled name across all modules.
   * Needed for monomorphized generics imported from another module (`new Stack__i32` after rewrite).
   */
  private lookupClass(
    name: string,
    namespace: string | null = null,
  ): ClassInfo | undefined {
    if (namespace) {
      return this.namespaces.get(namespace)?.classes.get(name);
    }
    const local = this.localClasses.get(name);
    if (local) {
      return local;
    }
    for (const info of this.classes.values()) {
      if (info.localName === name || info.name === name) {
        return info;
      }
    }
    return undefined;
  }

  private allocateTypeId(): number {
    const id = this.nextTypeId;
    this.nextTypeId += 1;
    return id;
  }

  /** GEP to ObjectHeader.type_id (index 0 of the nested header). */
  private emitObjectTypeIdPtr(
    className: string,
    objPtr: string,
    lines: string[],
  ): string {
    const ptr = this.nextTemp();
    lines.push(
      `  ${ptr} = getelementptr inbounds %${className}, ptr ${objPtr}, i32 0, i32 0, i32 0`,
    );
    return ptr;
  }

  /** GEP to ObjectHeader.vtable (index 1 of the nested header). */
  private emitObjectVtablePtr(
    className: string,
    objPtr: string,
    lines: string[],
  ): string {
    const ptr = this.nextTemp();
    lines.push(
      `  ${ptr} = getelementptr inbounds %${className}, ptr ${objPtr}, i32 0, i32 0, i32 1`,
    );
    return ptr;
  }

  /**
   * Load the vtable pointer from an object via the shared ObjectHeader layout
   * (works without knowing the concrete class LLVM type).
   */
  private emitLoadObjectVtable(objPtr: string, lines: string[]): string {
    const vtField = this.nextTemp();
    lines.push(
      `  ${vtField} = getelementptr inbounds ${OBJECT_HEADER_TYPE}, ptr ${objPtr}, i32 0, i32 1`,
    );
    const vt = this.nextTemp();
    lines.push(`  ${vt} = load ptr, ptr ${vtField}`);
    return vt;
  }

  private registerBuiltinErrorClass(
    moduleId: string,
    localStructs: Map<string, StructInfo>,
    localEnums: Map<string, EnumInfo>,
    localClasses: Map<string, ClassInfo>,
    localInterfaces: Map<string, InterfaceInfo>,
  ): void {
    const decl = createBuiltinErrorClassDeclaration();
    const info = this.buildClassInfo(
      decl,
      "",
      localStructs,
      localEnums,
      localClasses,
      localInterfaces,
    );
    localClasses.set(BUILTIN_ERROR_LOCAL_NAME, info);
    this.classes.set(BUILTIN_ERROR_MANGLED, info);
  }

  private registerInterfaceStub(
    decl: InterfaceDeclaration,
    moduleId: string,
  ): InterfaceInfo {
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
        throw new Error(
          "Codegen: cross-module interface extends not resolved yet",
        );
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
          throw new Error(
            `Codegen: invalid interface method param '${method.name.name}'`,
          );
        }
        return t;
      });
      const returnType =
        method.returnType.kind === "PrimitiveType" &&
        method.returnType.name === "void"
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
        throw new Error(
          `Codegen: invalid interface method return '${method.name.name}'`,
        );
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
        throw new Error(
          `Codegen: unknown superclass '${decl.superclass.name}'`,
        );
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
            staticGlobal: mangleSymbol(
              moduleId,
              `${decl.name.name}__static_${member.name.name}`,
            ),
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
      // Slot 0 is ObjectHeader; instance fields start at index 1.
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
          throw new Error(
            `Codegen: invalid method param '${method.name.name}'`,
          );
        }
        return t;
      });
      const returnType =
        method.returnType.kind === "PrimitiveType" &&
        method.returnType.name === "void"
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
      const mangledMethod = mangleSymbol(
        moduleId,
        `${decl.name.name}__${method.name.name}`,
      );
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
      constructorMangledName: mangleSymbol(
        moduleId,
        `${decl.name.name}__constructor`,
      ),
      constructorDecl,
      vtableGlobalName: `${mangled}__vtable`,
      typeId: this.allocateTypeId(),
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
    switch (ann.kind) {
      case "PrimitiveType":
        if (ann.name === "void") {
          return null;
        }
        return ann.name;
      case "ArrayType": {
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
      case "TupleType": {
        const elements: ValueType[] = [];
        for (const el of ann.elements) {
          const vt = this.resolveAnnotationInModule(
            el,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (vt === null) {
            return null;
          }
          elements.push(vt);
        }
        return { kind: "tuple", elements };
      }
      case "UnionType": {
        const arms: ValueType[] = [];
        for (const t of ann.types) {
          const vt = this.resolveAnnotationInModule(
            t,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (vt === null) {
            return null;
          }
          arms.push(vt);
        }
        if (arms.every((a) => isLiteralType(a) && a.literalKind === "string")) {
          return "string";
        }
        if (arms.every((a) => isLiteralType(a) && a.literalKind === "number")) {
          return "i32";
        }
        return { kind: "union", arms };
      }
      case "IntersectionType": {
        // Prefer first object/struct-like arm for lowering
        for (const t of ann.types) {
          const vt = this.resolveAnnotationInModule(
            t,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (
            vt &&
            typeof vt === "object" &&
            (vt.kind === "object" || vt.kind === "struct")
          ) {
            return vt;
          }
        }
        const arms: ValueType[] = [];
        for (const t of ann.types) {
          const vt = this.resolveAnnotationInModule(
            t,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (vt === null) {
            return null;
          }
          arms.push(vt);
        }
        return { kind: "intersection", arms };
      }
      case "LiteralType":
        return {
          kind: "literal",
          value: ann.value,
          literalKind: ann.literalKind,
        };
      case "ObjectType": {
        // Lower to named struct if registered, else treat as object with mangled name
        const fieldNames = ann.fields.map((f) => f.name.name).join("_");
        const name = `Obj__${fieldNames || "empty"}`;
        const existing = localStructs.get(name);
        if (existing) {
          return { kind: "struct", name: existing.name };
        }
        const fields = [];
        for (const f of ann.fields) {
          const ft = this.resolveAnnotationInModule(
            f.typeAnnotation,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (ft === null) {
            return null;
          }
          fields.push({ name: f.name.name, type: ft, readonly: f.readonly });
        }
        let indexType: ValueType | null = null;
        if (ann.indexSignature) {
          indexType = this.resolveAnnotationInModule(
            ann.indexSignature.valueType,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
        }
        if (fields.length === 0 && indexType) {
          return { kind: "map", valueType: indexType };
        }
        return { kind: "object", name, fields, indexType };
      }
      case "KeyofType":
      case "TypeofType":
      case "ConditionalType":
      case "MappedType":
      case "IndexedAccessType": {
        // Expand type-level operators using the same rules as typecheck where possible.
        if (ann.kind === "KeyofType") {
          const inner = this.resolveAnnotationInModule(
            ann.type,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (inner && isObjectType(inner)) {
            const arms = inner.fields.map((f) => ({
              kind: "literal" as const,
              value: f.name,
              literalKind: "string" as const,
            }));
            if (arms.length === 0) {
              return "string";
            }
            if (arms.length === 1) {
              return arms[0]!;
            }
            // Same lowering as string-literal UnionType annotations.
            return "string";
          }
          if (inner && isStructType(inner)) {
            const info = [...localStructs.values()].find(
              (s) => s.name === inner.name,
            );
            if (info) {
              const arms = info.fields.map((f) => ({
                kind: "literal" as const,
                value: f.name,
                literalKind: "string" as const,
              }));
              if (arms.length === 0) {
                return "string";
              }
              if (arms.length === 1) {
                return arms[0]!;
              }
              return "string";
            }
          }
          return "string";
        }
        if (ann.kind === "TypeofType") {
          if (
            ann.expression.kind === "CallExpression" &&
            ann.expression.callee.kind === "Identifier"
          ) {
            const sig = this.localFunctions.get(ann.expression.callee.name);
            if (sig && sig.returnType !== "void") {
              return sig.returnType;
            }
          }
          return "i32";
        }
        if (ann.kind === "ConditionalType") {
          const check = this.resolveAnnotationInModule(
            ann.checkType,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          const ext = this.resolveAnnotationInModule(
            ann.extendsType,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          const branch =
            check && ext && isAssignable(check, ext)
              ? ann.trueType
              : ann.falseType;
          return this.resolveAnnotationInModule(
            branch,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
        }
        if (ann.kind === "MappedType") {
          return {
            kind: "object",
            name: "Mapped",
            fields: [],
            indexType: null,
          };
        }
        // IndexedAccessType
        const obj = this.resolveAnnotationInModule(
          ann.objectType,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          namespaces,
        );
        const idx = this.resolveAnnotationInModule(
          ann.indexType,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          namespaces,
        );
        if (
          obj &&
          isObjectType(obj) &&
          idx &&
          isLiteralType(idx) &&
          idx.literalKind === "string"
        ) {
          const field = obj.fields.find((f) => f.name === String(idx.value));
          return (field?.type as ValueType) ?? null;
        }
        return null;
      }
      case "FunctionType": {
        const params: ValueType[] = [];
        for (const p of ann.params) {
          const vt = this.resolveAnnotationInModule(
            p,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
          if (vt === null) {
            return null;
          }
          params.push(vt);
        }
        if (
          ann.returnType.kind === "PrimitiveType" &&
          ann.returnType.name === "void"
        ) {
          return { kind: "function", params, returnType: "void" };
        }
        const returnType = this.resolveAnnotationInModule(
          ann.returnType,
          localStructs,
          localEnums,
          localClasses,
          localInterfaces,
          namespaces,
        );
        if (returnType === null) {
          return null;
        }
        return { kind: "function", params, returnType };
      }
      case "NamedType": {
        if (ann.typeArgs.length > 0) {
          const generic = this.genericTypeAliases.get(ann.name);
          if (generic && generic.typeParams.length === ann.typeArgs.length) {
            const subst = new Map(
              generic.typeParams.map((tp, i) => [
                tp.name.name,
                ann.typeArgs[i]!,
              ]),
            );
            return this.resolveAnnotationInModule(
              substituteAnnotation(generic.type, subst),
              localStructs,
              localEnums,
              localClasses,
              localInterfaces,
              namespaces,
            );
          }
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
            return this.interfaceToValueType(
              ifaceInfo,
              localStructs,
              localEnums,
              localClasses,
              localInterfaces,
              namespaces,
            );
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
          return this.interfaceToValueType(
            ifaceInfo,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
        }
        // Type alias
        const alias = this.typeAliases.get(ann.name);
        if (alias) {
          return this.resolveAnnotationInModule(
            alias,
            localStructs,
            localEnums,
            localClasses,
            localInterfaces,
            namespaces,
          );
        }
        return null;
      }
    }
  }

  /** Struct layout: each field lowered by its own TypeCategory (value inline, refs as ptr). */
  private emitStructTypeDefs(): string[] {
    const lines: string[] = [];
    for (const info of this.structs.values()) {
      const fieldTypes = info.fields.map((f) => toLlvmType(f.type)).join(", ");
      lines.push(`%${info.name} = type { ${fieldTypes} }`);
    }
    return lines;
  }

  private emitTupleTypeDefs(): string[] {
    const lines: string[] = [];
    for (const [name, elements] of this.registeredTuples) {
      const fieldTypes = elements.map((el) => toLlvmType(el)).join(", ");
      lines.push(`%${name} = type { ${fieldTypes} }`);
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
      const fieldTypes = [
        OBJECT_HEADER_TYPE,
        ...info.fields.map((f) => toLlvmType(f.type)),
      ].join(", ");
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

  private emitModuleValueGlobal(info: ModuleValueInfo): void {
    const llvmTy = toLlvmType(info.type);
    if (info.hasConstantInit) {
      const init = info.decl.initializer;
      if (init.kind === "StringLiteral") {
        const global = this.internString(init.value);
        this.globalDefs.push(
          `@${info.mangledName} = global ptr getelementptr inbounds ([${global.length} x i8], ptr @${global.name}, i64 0, i64 0)`,
        );
        return;
      }
      const constant = constantLlvmValue(init, info.type);
      this.globalDefs.push(
        `@${info.mangledName} = global ${llvmTy} ${constant}`,
      );
      return;
    }
    this.globalDefs.push(
      `@${info.mangledName} = global ${llvmTy} ${zeroInitializer(info.type)}`,
    );
  }

  private emitClassGlobals(): void {
    for (const info of this.classes.values()) {
      for (const field of info.staticFields) {
        if (!field.staticGlobal) {
          continue;
        }
        const llvmTy = toLlvmType(field.type);
        const zero = zeroInitializer(field.type);
        this.globalDefs.push(
          `@${field.staticGlobal} = global ${llvmTy} ${zero}`,
        );
      }
      if (info.instanceMethods.length === 0) {
        this.globalDefs.push(
          `@${info.vtableGlobalName} = global %${info.name}__vtable_type zeroinitializer`,
        );
      } else {
        const ptrs = info.instanceMethods
          .map((m) => (m.isAbstract ? "ptr null" : `ptr @${m.mangledName}`))
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
            const method = info.instanceMethods.find(
              (m) => m.name === req.name,
            );
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

  /**
   * Emit per-class TypeInfo constants and `@sn_init_typeinfo`, which registers
   * them with the runtime. Does not change object byte layouts.
   */
  private emitTypeInfoGlobals(): void {
    for (const info of this.classes.values()) {
      this.needsTypeInfo = true;
      const fields: TypeInfoFieldConst[] = [];
      for (const field of info.fields) {
        fields.push(
          ...this.collectTypeInfoFields(
            `%${info.name}`,
            [field.fieldIndex],
            field.type,
          ),
        );
      }

      const fieldsGlobal = `${info.name}__typeinfo_fields`;
      if (fields.length > 0) {
        const elems = fields
          .map(
            (f) =>
              `${SN_FIELD_INFO_TYPE} { i32 ${f.offsetExpr}, i32 ${f.sizeExpr}, i32 ${f.refClass}, i32 ${f.typeId} }`,
          )
          .join(", ");
        this.globalDefs.push(
          `@${fieldsGlobal} = private unnamed_addr constant [${fields.length} x ${SN_FIELD_INFO_TYPE}] [${elems}]`,
        );
      }

      const fieldsPtr =
        fields.length === 0 ? "ptr null" : `ptr @${fieldsGlobal}`;
      const sizeExpr = llvmSizeofI32Expr(`%${info.name}`);
      let parentTypeId = 0;
      if (info.superclass) {
        const parent = this.classes.get(info.superclass);
        parentTypeId = parent?.typeId ?? 0;
      }
      this.globalDefs.push(
        `@${info.name}__typeinfo = private unnamed_addr constant ${SN_TYPE_INFO_TYPE} { i32 ${info.typeId}, i32 ${SN_KIND_CLASS}, i32 ${sizeExpr}, i32 ${fields.length}, ${fieldsPtr}, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 ${parentTypeId} }`,
      );
    }

    for (const env of this.pendingEnvTypeInfos) {
      this.needsTypeInfo = true;
      const fieldsGlobal = `${env.globalName}__typeinfo_fields`;
      if (env.fields.length > 0) {
        const elems = env.fields
          .map(
            (f) =>
              `${SN_FIELD_INFO_TYPE} { i32 ${f.offsetExpr}, i32 ${f.sizeExpr}, i32 ${f.refClass}, i32 ${f.typeId} }`,
          )
          .join(", ");
        this.globalDefs.push(
          `@${fieldsGlobal} = private unnamed_addr constant [${env.fields.length} x ${SN_FIELD_INFO_TYPE}] [${elems}]`,
        );
      }
      const fieldsPtr =
        env.fields.length === 0 ? "ptr null" : `ptr @${fieldsGlobal}`;
      const sizeExpr = llvmSizeofI32Expr(env.llvmType);
      this.globalDefs.push(
        `@${env.globalName}__typeinfo = private unnamed_addr constant ${SN_TYPE_INFO_TYPE} { i32 ${env.typeId}, i32 ${env.kind}, i32 ${sizeExpr}, i32 ${env.fields.length}, ${fieldsPtr}, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0, i32 0 }`,
      );
    }

    const initLines: string[] = ["define void @sn_init_typeinfo() {", "entry:"];
    for (const info of this.classes.values()) {
      initLines.push(
        `  call void @sn_typeinfo_register(ptr noundef @${info.name}__typeinfo)`,
      );
    }
    for (const env of this.pendingEnvTypeInfos) {
      initLines.push(
        `  call void @sn_typeinfo_register(ptr noundef @${env.globalName}__typeinfo)`,
      );
    }
    for (const info of this.classes.values()) {
      for (const field of info.staticFields) {
        if (!field.staticGlobal || !isReferenceCategory(field.type)) {
          continue;
        }
        this.needsGc = true;
        initLines.push(
          `  call void @sn_gc_add_global_root(ptr noundef @${field.staticGlobal})`,
        );
      }
    }
    initLines.push("  ret void", "}", "");
    this.functionBodies.push(...initLines);
  }

  /** Whether a value type transitively contains heap references. */
  private typeContainsRefs(type: ValueType): boolean {
    if (isReferenceCategory(type)) {
      return true;
    }
    if (typeof type === "object" && type.kind === "struct") {
      const info = this.structs.get(type.name);
      if (!info) {
        return false;
      }
      return info.fields.some((f) => this.typeContainsRefs(f.type));
    }
    if (typeof type === "object" && type.kind === "tuple") {
      return type.elements.some((el) => this.typeContainsRefs(el));
    }
    if (typeof type === "object" && type.kind === "object") {
      return type.fields.some((f) =>
        this.typeContainsRefs(f.type as ValueType),
      );
    }
    return false;
  }

  private relatedTypeId(type: ValueType): number {
    if (type === "string") {
      return SN_TYPEID_STRING;
    }
    if (typeof type !== "object") {
      return 0;
    }
    switch (type.kind) {
      case "array":
        return SN_TYPEID_ARRAY;
      case "map":
        return SN_TYPEID_MAP;
      case "function":
        return SN_TYPEID_CLOSURE;
      case "class": {
        const info = this.classes.get(type.name);
        return info?.typeId ?? 0;
      }
      default:
        return 0;
    }
  }

  /**
   * Collect TypeInfo field entries for `type` at `indexPath` within `aggregateLlvm`.
   * Structs/tuples that contain refs become a single AGG entry with nested TypeInfo
   * (not flattened across struct boundaries).
   */
  private collectTypeInfoFields(
    aggregateLlvm: string,
    indexPath: number[],
    type: ValueType,
  ): TypeInfoFieldConst[] {
    if (typeof type === "object" && type.kind === "function") {
      this.needsCallableRuntime = true;
      return [
        {
          offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
          sizeExpr: llvmSizeofI32Expr("%__Callable"),
          refClass: SN_REF_AGG,
          typeId: SN_TYPEID_CLOSURE,
        },
      ];
    }

    if (isSinglePtrReference(type)) {
      return [
        {
          offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
          sizeExpr: llvmSizeofI32Expr("ptr"),
          refClass: SN_REF_PTR,
          typeId: this.relatedTypeId(type),
        },
      ];
    }

    if (typeof type === "object" && type.kind === "struct") {
      const info = this.structs.get(type.name);
      if (!info) {
        return [
          {
            offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
            sizeExpr: llvmSizeofI32Expr(`%${type.name}`),
            refClass: SN_REF_VALUE,
            typeId: 0,
          },
        ];
      }
      if (!this.typeContainsRefs(type)) {
        return [
          {
            offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
            sizeExpr: llvmSizeofI32Expr(`%${info.name}`),
            refClass: SN_REF_VALUE,
            typeId: 0,
          },
        ];
      }
      return [
        {
          offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
          sizeExpr: llvmSizeofI32Expr(`%${info.name}`),
          refClass: SN_REF_AGG,
          typeId: this.ensureAggregateTypeInfo(type),
        },
      ];
    }

    if (typeof type === "object" && type.kind === "tuple") {
      if (!this.typeContainsRefs(type)) {
        return [
          {
            offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
            sizeExpr: llvmSizeofI32Expr(toLlvmType(type)),
            refClass: SN_REF_VALUE,
            typeId: 0,
          },
        ];
      }
      return [
        {
          offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
          sizeExpr: llvmSizeofI32Expr(toLlvmType(type)),
          refClass: SN_REF_AGG,
          typeId: this.ensureAggregateTypeInfo(type),
        },
      ];
    }

    return [
      {
        offsetExpr: llvmOffsetOfExpr(aggregateLlvm, indexPath),
        sizeExpr: llvmSizeofI32Expr(toLlvmType(type)),
        refClass: SN_REF_VALUE,
        typeId: 0,
      },
    ];
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
      current = current.superclass
        ? this.classes.get(current.superclass)
        : undefined;
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
      lines.push(
        `  ${undef} = insertvalue %${iface.name} undef, ptr ${value.llvm}, 0`,
      );
      const fat = this.nextTemp();
      lines.push(
        `  ${fat} = insertvalue %${iface.name} ${undef}, ptr @${itable}, 1`,
      );
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
      lines.push(
        `  ${data} = extractvalue %${fromIface.name} ${value.llvm}, 0`,
      );
      const itable = this.nextTemp();
      lines.push(
        `  ${itable} = extractvalue %${fromIface.name} ${value.llvm}, 1`,
      );
      let adjustedItable = itable;
      if (offset !== 0) {
        const gep = this.nextTemp();
        lines.push(
          `  ${gep} = getelementptr inbounds %${fromIface.name}__itable_type, ptr ${itable}, i32 0, i32 ${offset}`,
        );
        adjustedItable = gep;
      }
      const undef = this.nextTemp();
      lines.push(
        `  ${undef} = insertvalue %${expected.name} undef, ptr ${data}, 0`,
      );
      const fat = this.nextTemp();
      lines.push(
        `  ${fat} = insertvalue %${expected.name} ${undef}, ptr ${adjustedItable}, 1`,
      );
      return { llvm: fat, type: expected };
    }

    // Box into union — but homogeneous literal unions lower as string/i32, not %__Union
    // Nullable pointer unions lower as bare ptr
    if (isUnionType(expected) && !isUnionType(value.type)) {
      if (isNullablePointerUnion(expected)) {
        if (value.type === "null") {
          return { llvm: "null", type: expected };
        }
        return { llvm: value.llvm, type: expected };
      }
      if (
        expected.arms.every(
          (a) => isLiteralType(a) && a.literalKind === "string",
        )
      ) {
        if (
          value.type === "string" ||
          (isLiteralType(value.type) && value.type.literalKind === "string")
        ) {
          return { llvm: value.llvm, type: expected };
        }
      }
      if (
        expected.arms.every(
          (a) => isLiteralType(a) && a.literalKind === "number",
        )
      ) {
        if (
          value.type === "i32" ||
          value.type === "i64" ||
          (isLiteralType(value.type) && value.type.literalKind === "number")
        ) {
          return { llvm: value.llvm, type: expected };
        }
      }
      if (value.type === "null") {
        return this.boxNullUnion(expected, lines);
      }
      return this.boxUnion(value, expected, lines);
    }

    // Unbox from union when expected is a concrete arm
    if (isUnionType(value.type) && !isUnionType(expected)) {
      if (isNullablePointerUnion(value.type)) {
        // Already a ptr; null check is the caller's job. Pass through for non-null expected.
        return { llvm: value.llvm, type: expected };
      }
      return this.unboxUnion(value, expected, lines);
    }

    // Literal → base
    if (isLiteralType(value.type)) {
      if (value.type.literalKind === "string" && expected === "string") {
        return { llvm: value.llvm, type: "string" };
      }
      if (
        value.type.literalKind === "number" &&
        (expected === "i32" || expected === "i64")
      ) {
        return { llvm: value.llvm, type: expected };
      }
    }

    return value;
  }

  private unionTagForType(type: ValueType): number {
    if (type === "null") {
      return UNION_TAG.null;
    }
    const tag = typeofTagForType(type);
    if (tag === "string") {
      return UNION_TAG.string;
    }
    if (tag === "i32") {
      return UNION_TAG.i32;
    }
    if (tag === "bool") {
      return UNION_TAG.bool;
    }
    if (tag === "i64") {
      return UNION_TAG.i64;
    }
    if (tag === "f32") {
      return UNION_TAG.f32;
    }
    if (tag === "f64") {
      return UNION_TAG.f64;
    }
    if (tag === "char") {
      return UNION_TAG.char;
    }
    if (tag === "null") {
      return UNION_TAG.null;
    }
    return UNION_TAG.object;
  }

  private boxNullUnion(expected: ValueType, lines: string[]): EmittedValue {
    this.needsUnionRuntime = true;
    const undef = this.nextTemp();
    lines.push(
      `  ${undef} = insertvalue %__Union undef, i32 ${UNION_TAG.null}, 0`,
    );
    const boxed = this.nextTemp();
    lines.push(`  ${boxed} = insertvalue %__Union ${undef}, ptr null, 1`);
    return { llvm: boxed, type: expected };
  }

  private boxUnion(
    value: EmittedValue,
    expected: ValueType,
    lines: string[],
  ): EmittedValue {
    this.needsUnionRuntime = true;
    const tag = this.unionTagForType(value.type);
    // Store payload on heap
    const payloadSize = 8;
    const raw = this.nextTemp();
    lines.push(`  ${raw} = call ptr @sn_alloc(i64 ${payloadSize})`);
    this.rootHeapPtr(raw, lines);
    this.needsGc = true;
    const boxTypeId = this.ensureBoxTypeInfo(value.type);
    lines.push(
      `  call void @sn_gc_set_type(ptr noundef ${raw}, i32 noundef ${boxTypeId})`,
    );
    if (
      value.type === "string" ||
      (typeof value.type === "object" &&
        (value.type.kind === "array" ||
          value.type.kind === "class" ||
          value.type.kind === "map"))
    ) {
      lines.push(`  store ptr ${value.llvm}, ptr ${raw}`);
    } else if (
      value.type === "i32" ||
      value.type === "bool" ||
      value.type === "char" ||
      (isLiteralType(value.type) && value.type.literalKind === "number")
    ) {
      const asI32 =
        value.type === "bool"
          ? (() => {
              const t = this.nextTemp();
              lines.push(`  ${t} = zext i1 ${value.llvm} to i32`);
              return t;
            })()
          : value.llvm;
      lines.push(`  store i32 ${asI32}, ptr ${raw}`);
    } else if (value.type === "i64") {
      lines.push(`  store i64 ${value.llvm}, ptr ${raw}`);
    } else if (value.type === "f64") {
      lines.push(`  store double ${value.llvm}, ptr ${raw}`);
    } else if (value.type === "f32") {
      lines.push(`  store float ${value.llvm}, ptr ${raw}`);
    } else {
      // Fallback: store as ptr-sized bitcast via alloca
      lines.push(`  store ptr ${value.llvm}, ptr ${raw}`);
    }
    const undef = this.nextTemp();
    lines.push(`  ${undef} = insertvalue %__Union undef, i32 ${tag}, 0`);
    const boxed = this.nextTemp();
    lines.push(`  ${boxed} = insertvalue %__Union ${undef}, ptr ${raw}, 1`);
    return { llvm: boxed, type: expected };
  }

  private unboxUnion(
    value: EmittedValue,
    expected: ValueType,
    lines: string[],
  ): EmittedValue {
    this.needsUnionRuntime = true;
    const payload = this.nextTemp();
    lines.push(`  ${payload} = extractvalue %__Union ${value.llvm}, 1`);
    if (
      expected === "string" ||
      (typeof expected === "object" &&
        (expected.kind === "array" ||
          expected.kind === "class" ||
          expected.kind === "map"))
    ) {
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ptr, ptr ${payload}`);
      return { llvm: loaded, type: expected };
    }
    if (
      expected === "i32" ||
      expected === "char" ||
      (isLiteralType(expected) && expected.literalKind === "number")
    ) {
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load i32, ptr ${payload}`);
      return { llvm: loaded, type: expected === "char" ? "char" : "i32" };
    }
    if (expected === "bool") {
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load i32, ptr ${payload}`);
      const asBool = this.nextTemp();
      lines.push(`  ${asBool} = icmp ne i32 ${loaded}, 0`);
      return { llvm: asBool, type: "bool" };
    }
    if (expected === "i64") {
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load i64, ptr ${payload}`);
      return { llvm: loaded, type: "i64" };
    }
    if (expected === "f64") {
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load double, ptr ${payload}`);
      return { llvm: loaded, type: "f64" };
    }
    if (expected === "f32") {
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load float, ptr ${payload}`);
      return { llvm: loaded, type: "f32" };
    }
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ptr, ptr ${payload}`);
    return { llvm: loaded, type: expected };
  }

  private pushGcRoot(slot: string, lines: string[]): void {
    this.ensureGcEntryCheckpoint(lines);
    this.needsGc = true;
    lines.push(`  call void @sn_gc_root_push(ptr noundef ${slot})`);
    this.gcRootCount += 1;
  }

  private ensureGcEntryCheckpoint(lines: string[]): void {
    if (this.gcEntryCheckpoint !== null) {
      return;
    }
    this.needsGc = true;
    this.gcEntryCheckpoint = "%gc.cp";
    lines.push(`  ${this.gcEntryCheckpoint} = alloca i32`);
    const cp = this.nextTemp();
    lines.push(`  ${cp} = call i32 @sn_gc_root_checkpoint()`);
    lines.push(`  store i32 ${cp}, ptr ${this.gcEntryCheckpoint}`);
  }

  private emitGcRootPop(lines: string[]): void {
    if (this.gcEntryCheckpoint === null) {
      return;
    }
    this.needsGc = true;
    const cp = this.nextTemp();
    lines.push(`  ${cp} = load i32, ptr ${this.gcEntryCheckpoint}`);
    lines.push(`  call void @sn_gc_root_restore(i32 noundef ${cp})`);
  }

  /** Emit `ret` after restoring this function's shadow-stack roots. */
  private emitFunctionRet(lines: string[], retInstruction: string): void {
    this.emitGcRootPop(lines);
    lines.push(retInstruction);
  }

  /** Keep a heap pointer alive across subsequent allocating calls in this function. */
  private rootHeapPtr(ptr: string, lines: string[]): void {
    // Use a fresh alloca per root so the slot always dominates its stores.
    // Reusing a single `%gc.expr` allocated inside a then-block breaks SSA dominance
    // when a later block also needs to root a pointer.
    this.needsGc = true;
    const slot = this.nextTemp();
    lines.push(`  ${slot} = alloca ptr`);
    lines.push(`  store ptr null, ptr ${slot}`);
    this.pushGcRoot(slot, lines);
    lines.push(`  store ptr ${ptr}, ptr ${slot}`);
  }

  /**
   * Register GC roots for a local/parameter alloca of `type`.
   * Single-ptr refs root the alloca; callables root the env field; aggregates
   * with refs root each PTR leaf (and callable env fields).
   */
  private registerRootsForStorage(
    storagePtr: string,
    type: ValueType,
    lines: string[],
  ): void {
    if (isSinglePtrReference(type) || type === "null") {
      this.pushGcRoot(storagePtr, lines);
      return;
    }
    if (isFunctionType(type)) {
      this.needsCallableRuntime = true;
      const envSlot = this.nextTemp();
      lines.push(
        `  ${envSlot} = getelementptr inbounds %__Callable, ptr ${storagePtr}, i32 0, i32 1`,
      );
      this.pushGcRoot(envSlot, lines);
      return;
    }
    if (!this.typeContainsRefs(type)) {
      return;
    }
    if (typeof type === "object" && type.kind === "struct") {
      const info = this.structs.get(type.name);
      if (!info) {
        return;
      }
      for (let i = 0; i < info.fields.length; i += 1) {
        this.registerRootsAtField(
          storagePtr,
          `%${info.name}`,
          [i],
          info.fields[i]!.type,
          lines,
        );
      }
      return;
    }
    if (typeof type === "object" && type.kind === "tuple") {
      const name = tupleTypeName(type.elements);
      for (let i = 0; i < type.elements.length; i += 1) {
        this.registerRootsAtField(
          storagePtr,
          `%${name}`,
          [i],
          type.elements[i]!,
          lines,
        );
      }
    }
  }

  private registerRootsAtField(
    basePtr: string,
    aggregateLlvm: string,
    indexPath: number[],
    type: ValueType,
    lines: string[],
  ): void {
    if (isSinglePtrReference(type) || type === "null") {
      const slot = this.nextTemp();
      const idxList = ["i32 0", ...indexPath.map((i) => `i32 ${i}`)].join(", ");
      lines.push(
        `  ${slot} = getelementptr inbounds ${aggregateLlvm}, ptr ${basePtr}, ${idxList}`,
      );
      this.pushGcRoot(slot, lines);
      return;
    }
    if (isFunctionType(type)) {
      this.needsCallableRuntime = true;
      const field = this.nextTemp();
      const idxList = ["i32 0", ...indexPath.map((i) => `i32 ${i}`)].join(", ");
      lines.push(
        `  ${field} = getelementptr inbounds ${aggregateLlvm}, ptr ${basePtr}, ${idxList}`,
      );
      const envSlot = this.nextTemp();
      lines.push(
        `  ${envSlot} = getelementptr inbounds %__Callable, ptr ${field}, i32 0, i32 1`,
      );
      this.pushGcRoot(envSlot, lines);
      return;
    }
    if (typeof type === "object" && type.kind === "struct") {
      const info = this.structs.get(type.name);
      if (!info || !this.typeContainsRefs(type)) {
        return;
      }
      for (let i = 0; i < info.fields.length; i += 1) {
        this.registerRootsAtField(
          basePtr,
          aggregateLlvm,
          [...indexPath, i],
          info.fields[i]!.type,
          lines,
        );
      }
      return;
    }
    if (typeof type === "object" && type.kind === "tuple") {
      if (!this.typeContainsRefs(type)) {
        return;
      }
      for (let i = 0; i < type.elements.length; i += 1) {
        this.registerRootsAtField(
          basePtr,
          aggregateLlvm,
          [...indexPath, i],
          type.elements[i]!,
          lines,
        );
      }
    }
  }

  /** Spill class `this` into a rooted alloca so it stays live across GC. */
  private rootClassThis(lines: string[]): void {
    if (!this.thisPtr || this.thisPtr !== "%this") {
      return;
    }
    if (!this.thisType || !isClassType(this.thisType)) {
      return;
    }
    const holder = "%v.this";
    lines.push(`  ${holder} = alloca ptr`);
    lines.push(`  store ptr %this, ptr ${holder}`);
    this.pushGcRoot(holder, lines);
  }

  private beginGcFunctionScope(): {
    rootCount: number;
    exprRoot: string | null;
    entryCheckpoint: string | null;
  } {
    const saved = {
      rootCount: this.gcRootCount,
      exprRoot: this.gcExprRoot,
      entryCheckpoint: this.gcEntryCheckpoint,
    };
    this.gcRootCount = 0;
    this.gcExprRoot = null;
    this.gcEntryCheckpoint = null;
    return saved;
  }

  private endGcFunctionScope(saved: {
    rootCount: number;
    exprRoot: string | null;
    entryCheckpoint: string | null;
  }): void {
    this.gcRootCount = saved.rootCount;
    this.gcExprRoot = saved.exprRoot;
    this.gcEntryCheckpoint = saved.entryCheckpoint;
  }

  private refClassForElement(elementType: ValueType): number {
    if (isSinglePtrReference(elementType) || elementType === "null") {
      return SN_REF_PTR;
    }
    if (isFunctionType(elementType) || this.typeContainsRefs(elementType)) {
      return SN_REF_AGG;
    }
    return SN_REF_VALUE;
  }

  private elementTypeIdForGc(elementType: ValueType, elemRef: number): number {
    if (elemRef === SN_REF_VALUE) {
      return 0;
    }
    if (elemRef === SN_REF_PTR) {
      return this.relatedTypeId(elementType);
    }
    if (isFunctionType(elementType)) {
      return SN_TYPEID_CLOSURE;
    }
    return this.ensureAggregateTypeInfo(elementType);
  }

  /**
   * Register TypeInfo for a value aggregate that contains refs (class AGG fields,
   * array AGG elements, typed boxes). Direct fields only — nested ref-structs are AGG.
   */
  private ensureAggregateTypeInfo(type: ValueType): number {
    if (typeof type === "object" && type.kind === "struct") {
      const globalName = `__agg_${type.name}`;
      const existing = this.pendingEnvTypeInfos.find(
        (e) => e.globalName === globalName,
      );
      if (existing) {
        return existing.typeId;
      }
      const info = this.structs.get(type.name);
      if (!info) {
        return 0;
      }
      const typeId = this.allocateTypeId();
      const pending: EnvTypeInfoPending = {
        globalName,
        typeId,
        llvmType: `%${info.name}`,
        fields: [],
        kind: SN_KIND_STRUCT,
      };
      /* Push before collecting fields so recursive aggregates reuse this type_id. */
      this.pendingEnvTypeInfos.push(pending);
      for (let i = 0; i < info.fields.length; i += 1) {
        pending.fields.push(
          ...this.collectTypeInfoFields(
            `%${info.name}`,
            [i],
            info.fields[i]!.type,
          ),
        );
      }
      this.needsTypeInfo = true;
      return typeId;
    }
    if (typeof type === "object" && type.kind === "tuple") {
      const name = tupleTypeName(type.elements);
      const globalName = `__agg_${name}`;
      const existing = this.pendingEnvTypeInfos.find(
        (e) => e.globalName === globalName,
      );
      if (existing) {
        return existing.typeId;
      }
      const typeId = this.allocateTypeId();
      const pending: EnvTypeInfoPending = {
        globalName,
        typeId,
        llvmType: `%${name}`,
        fields: [],
        kind: SN_KIND_STRUCT,
      };
      this.pendingEnvTypeInfos.push(pending);
      for (let i = 0; i < type.elements.length; i += 1) {
        pending.fields.push(
          ...this.collectTypeInfoFields(`%${name}`, [i], type.elements[i]!),
        );
      }
      this.needsTypeInfo = true;
      return typeId;
    }
    return 0;
  }

  /**
   * TypeInfo for a heap box that stores `type` inline (mutable captures, union payloads).
   * Returns 0 when the boxed value has no references (opaque leaf).
   */
  private ensureBoxTypeInfo(type: ValueType): number {
    if (!this.typeContainsRefs(type)) {
      return 0;
    }
    if (isSinglePtrReference(type) || type === "null") {
      const related = this.relatedTypeId(type);
      const globalName = `__box_ptr_${related}`;
      const existing = this.pendingEnvTypeInfos.find(
        (e) => e.globalName === globalName,
      );
      if (existing) {
        return existing.typeId;
      }
      const typeId = this.allocateTypeId();
      this.pendingEnvTypeInfos.push({
        globalName,
        typeId,
        llvmType: "ptr",
        fields: [
          {
            offsetExpr: "0",
            sizeExpr: llvmSizeofI32Expr("ptr"),
            refClass: SN_REF_PTR,
            typeId: related,
          },
        ],
        kind: SN_KIND_STRUCT,
      });
      this.needsTypeInfo = true;
      return typeId;
    }
    if (isFunctionType(type)) {
      this.needsCallableRuntime = true;
      return SN_TYPEID_CLOSURE;
    }
    return this.ensureAggregateTypeInfo(type);
  }

  private ensureEnvTypeInfo(
    envTypeName: string,
    captures: LambdaCaptureLowering[],
  ): number {
    const existing = this.pendingEnvTypeInfos.find(
      (e) => e.llvmType === `%${envTypeName}`,
    );
    if (existing) {
      return existing.typeId;
    }
    const typeId = this.allocateTypeId();
    const fields: TypeInfoFieldConst[] = [];
    for (let i = 0; i < captures.length; i += 1) {
      const cap = captures[i]!;
      if (cap.mutable) {
        fields.push({
          offsetExpr: llvmOffsetOfExpr(`%${envTypeName}`, [i]),
          sizeExpr: llvmSizeofI32Expr("ptr"),
          refClass: SN_REF_PTR,
          typeId: this.ensureBoxTypeInfo(cap.type),
        });
      } else {
        fields.push(
          ...this.collectTypeInfoFields(`%${envTypeName}`, [i], cap.type),
        );
      }
    }
    this.pendingEnvTypeInfos.push({
      globalName: envTypeName,
      typeId,
      llvmType: `%${envTypeName}`,
      fields,
      kind: SN_KIND_ENV,
    });
    this.needsTypeInfo = true;
    return typeId;
  }

  private emitRuntimeDeclares(): string[] {
    const declares: string[] = [];
    declares.push("declare void @sn_runtime_init(i32 noundef, ptr noundef) nounwind");
    if (this.needsTypeInfo) {
      declares.push("declare void @sn_typeinfo_register(ptr noundef) nounwind");
    }
    if (this.needsIsInstance) {
      declares.push(
        "declare i1 @sn_is_instance(ptr noundef, i32 noundef) nounwind",
      );
    }
    if (this.needsGc) {
      declares.push(
        "declare void @sn_gc_set_type(ptr noundef, i32 noundef) nounwind",
      );
      declares.push(
        "declare void @sn_gc_set_array_meta(ptr noundef, i32 noundef, i32 noundef, i64 noundef) nounwind",
      );
      declares.push(
        "declare void @sn_gc_set_map_meta(ptr noundef, i32 noundef, i32 noundef, i32 noundef, i32 noundef) nounwind",
      );
      declares.push("declare void @sn_gc_root_push(ptr noundef) nounwind");
      declares.push("declare i32 @sn_gc_root_checkpoint() nounwind");
      declares.push("declare void @sn_gc_root_restore(i32 noundef) nounwind");
      declares.push(
        "declare void @sn_gc_add_global_root(ptr noundef) nounwind",
      );
    }
    if (
      this.needsSnAlloc ||
      this.needsUnionRuntime ||
      this.needsCallableRuntime
    ) {
      declares.push("declare ptr @sn_alloc(i64 noundef) nounwind");
    }
    if (this.needsSnString) {
      declares.push("declare i32 @sn_str_len(ptr noundef) nounwind");
      declares.push(
        "declare ptr @sn_str_concat(ptr noundef, ptr noundef) nounwind",
      );
    }
    if (this.needsSnStrExtras) {
      declares.push(
        "declare i1 @sn_str_contains(ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare i1 @sn_str_starts_with(ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare i1 @sn_str_ends_with(ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_str_substring(ptr noundef, i32 noundef, i32 noundef) nounwind",
      );
      declares.push("declare ptr @sn_str_trim(ptr noundef) nounwind");
      declares.push("declare ptr @sn_str_to_upper(ptr noundef) nounwind");
      declares.push("declare ptr @sn_str_to_lower(ptr noundef) nounwind");
      declares.push(
        "declare ptr @sn_str_replace(ptr noundef, ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_str_split(ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare i32 @sn_str_index_of(ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare i8 @sn_str_char_at(ptr noundef, i32 noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_str_repeat(ptr noundef, i32 noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_str_pad_start(ptr noundef, i32 noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_str_pad_end(ptr noundef, i32 noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_str_join(ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare i32 @sn_str_last_index_of(ptr noundef, ptr noundef) nounwind",
      );
    }
    // Declares for other extern symbols used from SN.
    const hardcodedExterns = new Set([
      "sn_str_len",
      "sn_str_concat",
      "sn_str_contains",
      "sn_str_starts_with",
      "sn_str_ends_with",
      "sn_str_substring",
      "sn_str_trim",
      "sn_str_to_upper",
      "sn_str_to_lower",
      "sn_str_replace",
      "sn_str_split",
      "sn_str_index_of",
      "sn_str_char_at",
      "sn_str_repeat",
      "sn_str_pad_start",
      "sn_str_pad_end",
      "sn_str_join",
      "sn_str_last_index_of",
      "sn_array_new",
      "sn_array_push",
      "sn_array_pop",
      "sn_array_index_of",
      "sn_print_i32",
      "sn_print_i64",
      "sn_print_f32",
      "sn_print_f64",
      "sn_print_bool",
      "sn_print_char",
      "sn_print_str",
      "sn_print_space",
      "sn_print_newline",
    ]);
    for (const name of this.externDeclares) {
      if (hardcodedExterns.has(name)) {
        continue;
      }
      const sig = this.functions.get(name);
      if (!sig) {
        continue;
      }
      const ret =
        sig.returnType === "void" ? "void" : toLlvmType(sig.returnType);
      const params = sig.params
        .map((t) => `${toLlvmType(t)} noundef`)
        .join(", ");
      declares.push(`declare ${ret} @${name}(${params}) nounwind`);
    }
    if (this.needsStrcmp) {
      declares.push("declare i32 @strcmp(ptr noundef, ptr noundef) nounwind");
    }
    if (this.needsSnArray) {
      declares.push(
        "declare ptr @sn_array_new(i64 noundef, i64 noundef, i64 noundef) nounwind",
      );
      declares.push(
        "declare void @sn_array_push(ptr noundef, ptr noundef, i64 noundef) nounwind",
      );
      declares.push(
        "declare void @sn_array_pop(ptr noundef, ptr noundef, i64 noundef) nounwind",
      );
      declares.push(
        "declare i32 @sn_array_index_of(ptr noundef, ptr noundef, i64 noundef, i32 noundef) nounwind",
      );
    }
    if (this.needsSnMap) {
      declares.push("declare ptr @sn_map_new() nounwind");
      declares.push(
        "declare void @sn_map_set(ptr noundef, ptr noundef, ptr noundef) nounwind",
      );
      declares.push(
        "declare ptr @sn_map_get(ptr noundef, ptr noundef) nounwind",
      );
    }
    if (this.needsSnException) {
      declares.push(
        "declare void @sn_eh_init_frame(ptr noundef, i32 noundef, ptr noundef, ptr noundef)",
      );
      declares.push("declare void @sn_eh_push(ptr noundef)");
      declares.push("declare void @sn_eh_pop(ptr noundef)");
      declares.push("declare ptr @sn_eh_jmp_buf(ptr noundef)");
      declares.push("declare i32 @setjmp(ptr noundef)");
      declares.push("declare void @sn_throw(ptr noundef)");
      declares.push("declare ptr @sn_eh_caught_exception()");
      declares.push("declare void @sn_eh_clear_exception()");
    }
    if (this.needsSnPrint) {
      declares.push("declare void @sn_print_i32(i32 noundef) nounwind");
      declares.push("declare void @sn_print_i64(i64 noundef) nounwind");
      declares.push("declare void @sn_print_f32(float noundef) nounwind");
      declares.push("declare void @sn_print_f64(double noundef) nounwind");
      declares.push("declare void @sn_print_bool(i1 noundef) nounwind");
      declares.push("declare void @sn_print_char(i8 noundef) nounwind");
      declares.push("declare void @sn_print_str(ptr noundef) nounwind");
      declares.push("declare void @sn_print_space() nounwind");
      declares.push("declare void @sn_print_newline() nounwind");
      declares.push("declare void @sn_eprint_i32(i32 noundef) nounwind");
      declares.push("declare void @sn_eprint_i64(i64 noundef) nounwind");
      declares.push("declare void @sn_eprint_f32(float noundef) nounwind");
      declares.push("declare void @sn_eprint_f64(double noundef) nounwind");
      declares.push("declare void @sn_eprint_bool(i1 noundef) nounwind");
      declares.push("declare void @sn_eprint_char(i8 noundef) nounwind");
      declares.push("declare void @sn_eprint_str(ptr noundef) nounwind");
      declares.push("declare void @sn_eprint_space() nounwind");
      declares.push("declare void @sn_eprint_newline() nounwind");
      declares.push("declare ptr @sn_read_line() nounwind");
    }
    if (this.needsSnFormat) {
      declares.push("declare ptr @sn_i32_to_string(i32 noundef) nounwind");
      declares.push("declare ptr @sn_i64_to_string(i64 noundef) nounwind");
      declares.push("declare ptr @sn_f32_to_string(float noundef) nounwind");
      declares.push("declare ptr @sn_f64_to_string(double noundef) nounwind");
      declares.push("declare ptr @sn_bool_to_string(i1 noundef) nounwind");
      declares.push("declare ptr @sn_char_to_string(i8 noundef) nounwind");
      declares.push(
        "declare ptr @sn_array_to_string(ptr noundef, i64 noundef, i32 noundef) nounwind",
      );
    }
    if (this.needsAbort) {
      declares.push("declare void @abort() noreturn nounwind");
    }
    return declares;
  }

  private snCmpKindForType(elementType: ValueType): number {
    if (elementType === "i32" || isEnumType(elementType)) {
      return 0;
    }
    if (elementType === "i64") {
      return 1;
    }
    if (elementType === "f32") {
      return 2;
    }
    if (elementType === "f64") {
      return 3;
    }
    if (elementType === "bool") {
      return 4;
    }
    if (elementType === "char") {
      return 5;
    }
    if (elementType === "string") {
      return 6;
    }
    return 7;
  }

  private snFmtKindForType(elementType: ValueType): number {
    return this.snCmpKindForType(elementType);
  }

  private emitStructMethod(struct: StructInfo, method: StructMethodInfo): void {
    this.locals = new Map();
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.controlStack.length = 0;
    const gcScope = this.beginGcFunctionScope();
    this.thisPtr = "%this";
    this.thisType = { kind: "struct", name: struct.name };
    this.currentReturnType = method.returnType;

    const ret =
      method.returnType === "void" ? "void" : toLlvmType(method.returnType);
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
        this.emitFunctionRet(lines, "  ret void");
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
    this.endGcFunctionScope(gcScope);
  }

  private emitClassMembers(info: ClassInfo): void {
    this.emitClassConstructor(info);
    const declaredInstance = new Set(
      info.decl.members
        .filter(
          (m): m is ClassMethod =>
            m.kind === "ClassMethod" && !m.isStatic && !m.isAbstract,
        )
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
    this.labelCounter = 0;
    this.controlStack.length = 0;
    const gcScope = this.beginGcFunctionScope();
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
    this.rootClassThis(lines);

    if (info.localName === BUILTIN_ERROR_LOCAL_NAME) {
      for (let i = 0; i < info.constructorDecl!.params.length; i += 1) {
        this.emitParameter(info.constructorDecl!.params[i]!, i, lines);
      }
      const msgField = this.nextTemp();
      lines.push(
        `  ${msgField} = getelementptr inbounds %${info.name}, ptr %this, i32 0, i32 1`,
      );
      lines.push(`  store ptr %arg0, ptr ${msgField}`);
      this.emitFunctionRet(lines, "  ret void");
      lines.push("}");
      lines.push("");
      this.functionBodies.push(...lines);
      this.thisPtr = null;
      this.thisType = null;
      this.currentReturnType = null;
      this.endGcFunctionScope(gcScope);
      return;
    }

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
        this.emitFunctionRet(lines, "  ret void");
      }
    } else {
      if (info.superclass) {
        const base = this.classes.get(info.superclass);
        if (base) {
          lines.push(`  call void @${base.constructorMangledName}(ptr %this)`);
        }
      }
      this.emitFunctionRet(lines, "  ret void");
    }

    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
    this.thisPtr = null;
    this.thisType = null;
    this.currentReturnType = null;
    this.endGcFunctionScope(gcScope);
  }

  private emitClassMethod(info: ClassInfo, method: ClassMethodInfo): void {
    if (!method.decl || method.isAbstract || !method.decl.body) {
      return;
    }
    this.locals = new Map();
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.controlStack.length = 0;
    const gcScope = this.beginGcFunctionScope();
    this.thisPtr = method.isStatic ? null : "%this";
    this.thisType = method.isStatic ? null : { kind: "class", name: info.name };
    this.currentReturnType = method.returnType;

    const ret =
      method.returnType === "void" ? "void" : toLlvmType(method.returnType);
    const paramParts = method.isStatic
      ? method.params.map((t, i) => `${toLlvmType(t)} %arg${i}`)
      : [
          `ptr %this`,
          ...method.params.map((t, i) => `${toLlvmType(t)} %arg${i}`),
        ];
    const lines: string[] = [];
    lines.push(
      `define ${ret} @${method.mangledName}(${paramParts.join(", ")}) {`,
    );
    lines.push("entry:");
    if (!method.isStatic) {
      this.rootClassThis(lines);
    }

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
        this.emitFunctionRet(lines, "  ret void");
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
    this.endGcFunctionScope(gcScope);
  }

  private emitNewExpression(
    expr: NewExpression,
    lines: string[],
  ): EmittedValue {
    this.needsSnAlloc = true;
    this.needsGc = true;
    const classInfo = this.lookupClass(
      expr.className.name,
      expr.namespace?.name ?? null,
    );
    if (!classInfo) {
      throw new Error(`Codegen: unknown class '${expr.className.name}'`);
    }
    const obj = this.nextTemp();
    lines.push(
      `  ${obj} = call ptr @sn_alloc(i64 noundef ${llvmSizeofExpr(`%${classInfo.name}`)})`,
    );
    this.rootHeapPtr(obj, lines);
    const typeIdPtr = this.emitObjectTypeIdPtr(classInfo.name, obj, lines);
    lines.push(`  store i32 ${classInfo.typeId}, ptr ${typeIdPtr}`);
    lines.push(
      `  call void @sn_gc_set_type(ptr noundef ${obj}, i32 noundef ${classInfo.typeId})`,
    );
    const vtPtr = this.emitObjectVtablePtr(classInfo.name, obj, lines);
    lines.push(`  store ptr @${classInfo.vtableGlobalName}, ptr ${vtPtr}`);

    const args: EmittedValue[] = [];
    for (let i = 0; i < expr.args.length; i += 1) {
      args.push(
        this.emitExpression(
          asExpressions(expr.args)[i]!,
          lines,
          classInfo.constructorParams[i],
        ),
      );
    }
    const argList = [
      `ptr ${obj}`,
      ...args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
    ].join(", ");
    lines.push(`  call void @${classInfo.constructorMangledName}(${argList})`);
    return { llvm: obj, type: { kind: "class", name: classInfo.name } };
  }

  private emitFunction(fn: FunctionDeclaration): void {
    if (fn.isExtern || !fn.body) {
      return;
    }
    this.locals = new Map();
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.controlStack.length = 0;
    const gcScope = this.beginGcFunctionScope();
    this.boxedNames = this.collectBoxedNamesInStmts(fn.body);
    const sig = this.localFunctions.get(fn.name.name);
    this.currentReturnType = sig?.returnType ?? "void";
    const lines: string[] = [];

    const isMain = fn.name.name === "main";
    const isExtension = fn.params[0]?.isReceiver === true;
    const header = isMain
      ? "define i32 @main(i32 %argc, ptr %argv) {"
      : this.emitFunctionHeader(fn);

    lines.push(header);
    lines.push("entry:");

    if (isMain) {
      // Non-entry module inits first (moduleInitFns already ordered that way).
      for (const initFn of this.moduleInitFns) {
        lines.push(`  call void @${initFn}()`);
      }
      lines.push("  call void @sn_init_typeinfo()");
      lines.push("  call void @sn_runtime_init(i32 %argc, ptr %argv)");
    }

    this.thisPtr = null;
    this.thisType = null;

    if (!isMain) {
      for (let i = 0; i < fn.params.length; i += 1) {
        const param = fn.params[i]!;
        if (param.isReceiver) {
          const type = this.resolveAnnotation(param.typeAnnotation);
          if (!type) {
            throw new Error("Codegen: invalid extension receiver type");
          }
          // Receiver is a by-value parameter (string/array are ptrs).
          this.thisType = type;
          this.thisPtr = `%arg${i}`;
          continue;
        }
        this.emitParameter(param, i, lines);
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
        this.emitFunctionRet(lines, isMain ? "  ret i32 0" : "  ret void");
      } else {
        throw new Error(
          `Codegen: non-void function '${fn.name.name}' missing return`,
        );
      }
    }

    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
    this.currentReturnType = null;
    this.thisPtr = null;
    this.thisType = null;
    this.boxedNames = new Set();
    this.endGcFunctionScope(gcScope);
    void isExtension;
  }

  /**
   * Function ABI: value types pass/return as first-class LLVM values (copied);
   * single-ptr references pass/return as `ptr` (shared identity).
   */
  private emitFunctionHeader(fn: FunctionDeclaration): string {
    const sig = this.localFunctions.get(fn.name.name)!;
    const ret = sig.returnType === "void" ? "void" : toLlvmType(sig.returnType);
    const params = sig.params
      .map((t, i) => `${toLlvmType(t)} %arg${i}`)
      .join(", ");
    return `define ${ret} @${sig.mangledName}(${params}) {`;
  }

  /** Spill incoming arg: value params copy the aggregate; reference params copy the ptr. */
  private emitParameter(
    param: Parameter,
    index: number,
    lines: string[],
  ): void {
    const type = this.resolveAnnotation(param.typeAnnotation);
    if (!type) {
      throw new Error(`Codegen: invalid parameter type`);
    }
    const llvmType = toLlvmType(type);
    const ptr = `%v.${param.name.name}`;
    lines.push(`  ${ptr} = alloca ${llvmType}`);
    lines.push(`  store ${llvmType} %arg${index}, ptr ${ptr}`);
    this.locals.set(param.name.name, { ptr, type, boxed: false });
    this.registerRootsForStorage(ptr, type, lines);
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
      case "SwitchStatement":
        return this.emitSwitchStatement(stmt, lines);
      case "BreakStatement": {
        this.emitBreak(lines);
        return true;
      }
      case "ContinueStatement": {
        this.emitContinue(lines);
        return true;
      }
      case "ThrowStatement":
        return this.emitThrowStatement(stmt, lines);
      case "TryStatement":
        return this.emitTryStatement(stmt, lines);
    }
  }

  private enclosingTryWithFinally(): Extract<
    ControlContext,
    { kind: "try" }
  > | null {
    for (let i = this.controlStack.length - 1; i >= 0; i -= 1) {
      const ctx = this.controlStack[i]!;
      if (ctx.kind === "try" && ctx.hasFinally) {
        return ctx;
      }
    }
    return null;
  }

  private emitFinallyBlock(stmts: Statement[], lines: string[]): void {
    let terminated = false;
    for (const s of stmts) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
  }

  private emitFinallyThunk(stmts: Statement[], id: number): string {
    const name = `__sn_finally_${id}`;
    const savedLocals = this.locals;
    const savedThisPtr = this.thisPtr;
    const savedThisType = this.thisType;
    const savedReturnType = this.currentReturnType;
    const savedControl = [...this.controlStack];
    const savedPendingReturn = this.pendingReturn;
    const savedPendingBranch = this.pendingBranch;
    const gcScope = this.beginGcFunctionScope();

    this.locals = new Map(this.locals);
    this.controlStack.length = 0;
    this.pendingReturn = null;
    this.pendingBranch = null;

    const thunkLines: string[] = [];
    thunkLines.push(`define internal void @${name}(ptr noundef %ctx) {`);
    thunkLines.push("entry:");
    let terminated = false;
    for (const s of stmts) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, thunkLines);
    }
    if (!terminated) {
      this.emitFunctionRet(thunkLines, "  ret void");
    }
    thunkLines.push("}");
    thunkLines.push("");
    this.functionBodies.push(...thunkLines);

    this.endGcFunctionScope(gcScope);
    this.locals = savedLocals;
    this.thisPtr = savedThisPtr;
    this.thisType = savedThisType;
    this.currentReturnType = savedReturnType;
    this.controlStack.length = 0;
    this.controlStack.push(...savedControl);
    this.pendingReturn = savedPendingReturn;
    this.pendingBranch = savedPendingBranch;
    return name;
  }

  private emitTryLeave(
    framePtr: string,
    afterLabel: string,
    finallyBlock: Statement[] | null,
    finallyOnly: boolean,
    lines: string[],
    popFrame = true,
  ): boolean {
    if (finallyBlock) {
      this.emitFinallyBlock(finallyBlock, lines);
    }
    if (popFrame) {
      lines.push(`  call void @sn_eh_pop(ptr noundef ${framePtr})`);
    }
    if (this.pendingReturn) {
      const pending = this.pendingReturn;
      this.pendingReturn = null;
      if (pending.type === "void") {
        this.emitFunctionRet(lines, "  ret void");
      } else {
        this.emitFunctionRet(
          lines,
          `  ret ${toLlvmType(pending.type)} ${pending.llvm}`,
        );
      }
      return true;
    }
    if (this.pendingBranch) {
      const target = this.pendingBranch;
      this.pendingBranch = null;
      lines.push(`  br label %${target}`);
      return true;
    }
    lines.push(`  br label %${afterLabel}`);
    return false;
  }

  private emitTryStatement(stmt: TryStatement, lines: string[]): boolean {
    this.needsSnException = true;
    const id = this.labelCounter;
    this.labelCounter += 1;

    const hasCatch = stmt.catchClause !== null;
    const hasFinally =
      stmt.finallyBlock !== null && stmt.finallyBlock.length > 0;
    const finallyOnly = hasFinally && !hasCatch;

    const framePtr = this.nextTemp();
    lines.push(`  ${framePtr} = alloca i8, i64 ${SN_EH_FRAME_SIZE}`);

    /* Pre-root catch param so gcRootCount matches both try-success and catch paths. */
    let catchPtr: string | null = null;
    if (hasCatch && stmt.catchClause) {
      const catchParam = stmt.catchClause.parameter.name;
      catchPtr = `%v.${catchParam}`;
      lines.push(`  ${catchPtr} = alloca ptr`);
      lines.push(`  store ptr null, ptr ${catchPtr}`);
      this.locals.set(catchParam, {
        ptr: catchPtr,
        type: { kind: "class", name: BUILTIN_ERROR_MANGLED },
        boxed: false,
      });
      this.registerRootsForStorage(
        catchPtr,
        { kind: "class", name: BUILTIN_ERROR_MANGLED },
        lines,
      );
    }

    let finallyFnName: string | null = null;
    if (finallyOnly && stmt.finallyBlock) {
      finallyFnName = this.emitFinallyThunk(stmt.finallyBlock, id);
    }

    const finallyArg = finallyFnName ? `ptr @${finallyFnName}` : "ptr null";
    lines.push(
      `  call void @sn_eh_init_frame(ptr noundef ${framePtr}, i32 ${hasCatch ? 1 : 0}, ${finallyArg}, ptr null)`,
    );
    lines.push(`  call void @sn_eh_push(ptr noundef ${framePtr})`);

    const jmpBuf = this.nextTemp();
    lines.push(
      `  ${jmpBuf} = call ptr @sn_eh_jmp_buf(ptr noundef ${framePtr})`,
    );
    const sj = this.nextTemp();
    lines.push(`  ${sj} = call i32 @setjmp(ptr noundef ${jmpBuf})`);
    const isCatch = this.nextTemp();
    lines.push(`  ${isCatch} = icmp ne i32 ${sj}, 0`);

    const tryLabel = `try.body.${id}`;
    const normalLeaveLabel = `try.normal.${id}`;
    const catchLabel = hasCatch ? `try.catch.${id}` : null;
    const afterLabel = `try.after.${id}`;

    if (hasCatch) {
      lines.push(
        `  br i1 ${isCatch}, label %${catchLabel}, label %${tryLabel}`,
      );
    } else {
      lines.push(
        `  br i1 ${isCatch}, label %${normalLeaveLabel}, label %${tryLabel}`,
      );
    }

    this.controlStack.push({
      kind: "try",
      framePtr,
      normalLeaveLabel,
      afterLabel,
      hasFinally,
      finallyOnly,
    });

    lines.push(`${tryLabel}:`);
    let terminated = false;
    for (const s of stmt.tryBlock) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    if (!terminated) {
      lines.push(`  br label %${normalLeaveLabel}`);
    }

    lines.push(`${normalLeaveLabel}:`);
    const tryLeaveTerminated = this.emitTryLeave(
      framePtr,
      afterLabel,
      stmt.finallyBlock,
      finallyOnly,
      lines,
    );

    if (catchLabel && stmt.catchClause && catchPtr) {
      lines.push(`${catchLabel}:`);
      /* Disable this catch frame so throws inside catch propagate outward. */
      lines.push(`  call void @sn_eh_pop(ptr noundef ${framePtr})`);
      const err = this.nextTemp();
      lines.push(`  ${err} = call ptr @sn_eh_caught_exception()`);
      lines.push(`  store ptr ${err}, ptr ${catchPtr}`);
      lines.push("  call void @sn_eh_clear_exception()");

      terminated = false;
      for (const s of stmt.catchClause.body) {
        if (terminated) {
          break;
        }
        terminated = this.emitStatement(s, lines);
      }
      if (!terminated) {
        lines.push(`  br label %${normalLeaveLabel}.catch.${id}`);
      }

      lines.push(`${normalLeaveLabel}.catch.${id}:`);
      const catchLeaveTerminated = this.emitTryLeave(
        framePtr,
        afterLabel,
        stmt.finallyBlock,
        finallyOnly,
        lines,
        false /* already popped at catch entry */,
      );
      this.controlStack.pop();
      if (!(tryLeaveTerminated || catchLeaveTerminated)) {
        lines.push(`${afterLabel}:`);
      }
      return tryLeaveTerminated || catchLeaveTerminated;
    }

    this.controlStack.pop();
    if (!tryLeaveTerminated) {
      lines.push(`${afterLabel}:`);
    }
    return tryLeaveTerminated;
  }

  private emitThrowStatement(stmt: ThrowStatement, lines: string[]): boolean {
    this.needsSnException = true;
    const value = this.emitExpression(stmt.expression, lines);
    lines.push(`  call void @sn_throw(ptr noundef ${value.llvm})`);
    lines.push("  unreachable");
    return true;
  }

  private emitContinue(lines: string[]): void {
    const tryCtx = this.enclosingTryWithFinally();
    if (tryCtx) {
      this.pendingBranch = this.currentContinueLabel();
      lines.push(`  br label %${tryCtx.normalLeaveLabel}`);
      return;
    }
    lines.push(`  br label %${this.currentContinueLabel()}`);
  }

  private currentBreakLabel(): string {
    for (let i = this.controlStack.length - 1; i >= 0; i -= 1) {
      const ctx = this.controlStack[i]!;
      if (ctx.kind === "loop" || ctx.kind === "switch") {
        return ctx.breakLabel;
      }
    }
    throw new Error("Codegen: break outside loop or switch");
  }

  private emitBreak(lines: string[]): void {
    const tryCtx = this.enclosingTryWithFinally();
    if (tryCtx) {
      this.pendingBranch = this.currentBreakLabel();
      lines.push(`  br label %${tryCtx.normalLeaveLabel}`);
      return;
    }
    lines.push(`  br label %${this.currentBreakLabel()}`);
  }

  private currentContinueLabel(): string {
    for (let i = this.controlStack.length - 1; i >= 0; i -= 1) {
      const ctx = this.controlStack[i]!;
      if (ctx.kind === "loop") {
        return ctx.continueLabel;
      }
    }
    throw new Error("Codegen: continue outside loop");
  }

  private emitSwitchStatement(stmt: SwitchStatement, lines: string[]): boolean {
    const id = this.labelCounter;
    this.labelCounter += 1;
    const exitLabel = `switch.exit.${id}`;

    const disc = this.emitExpression(stmt.discriminant, lines);

    this.controlStack.push({ kind: "switch", breakLabel: exitLabel });

    const caseBodyLabels = stmt.cases.map((_, i) => `switch.case.${id}.${i}`);
    const nonDefaultIndices: number[] = [];
    stmt.cases.forEach((switchCase, i) => {
      if (!switchCase.isDefault) {
        nonDefaultIndices.push(i);
      }
    });
    const defaultIndex = stmt.cases.findIndex(
      (switchCase) => switchCase.isDefault,
    );

    if (nonDefaultIndices.length > 0) {
      lines.push(`  br label %switch.check.${id}.0`);
      for (let ci = 0; ci < nonDefaultIndices.length; ci += 1) {
        const caseIdx = nonDefaultIndices[ci]!;
        const switchCase = stmt.cases[caseIdx]!;
        const checkLabel = `switch.check.${id}.${ci}`;
        const targetBody = caseBodyLabels[caseIdx]!;
        const failLabel =
          ci + 1 < nonDefaultIndices.length
            ? `switch.check.${id}.${ci + 1}`
            : defaultIndex >= 0
              ? caseBodyLabels[defaultIndex]!
              : exitLabel;

        lines.push(`${checkLabel}:`);
        const eq = this.emitSwitchCaseComparison(disc, switchCase.test!, lines);
        lines.push(`  br i1 ${eq}, label %${targetBody}, label %${failLabel}`);
      }
    } else if (defaultIndex >= 0) {
      lines.push(`  br label %${caseBodyLabels[defaultIndex]}`);
    }

    for (let i = 0; i < stmt.cases.length; i += 1) {
      lines.push(`${caseBodyLabels[i]}:`);
      let terminated = false;
      for (const s of stmt.cases[i]!.body) {
        if (terminated) {
          break;
        }
        terminated = this.emitStatement(s, lines);
      }
      if (!terminated) {
        const nextLabel =
          i + 1 < stmt.cases.length ? caseBodyLabels[i + 1]! : exitLabel;
        lines.push(`  br label %${nextLabel}`);
      }
    }

    this.controlStack.pop();
    lines.push(`${exitLabel}:`);
    return false;
  }

  private emitSwitchCaseComparison(
    disc: EmittedValue,
    caseTest: Expression,
    lines: string[],
  ): string {
    const caseVal = this.emitExpression(caseTest, lines);
    const right = this.coerceValue(caseVal, disc.type, lines);
    const tmp = this.nextTemp();

    if (disc.type === "string") {
      this.needsStrcmp = true;
      const cmp = this.nextTemp();
      lines.push(
        `  ${cmp} = call i32 @strcmp(ptr ${disc.llvm}, ptr ${right.llvm})`,
      );
      lines.push(`  ${tmp} = icmp eq i32 ${cmp}, 0`);
      return tmp;
    }

    const llvmType = toLlvmType(disc.type);
    const isFloat = disc.type === "f32" || disc.type === "f64";
    const cmp = isFloat ? "fcmp" : "icmp";
    const pred = isFloat ? "oeq" : "eq";
    lines.push(
      `  ${tmp} = ${cmp} ${pred} ${llvmType} ${disc.llvm}, ${right.llvm}`,
    );
    return tmp;
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
    lines.push(
      `  br i1 ${cond.llvm}, label %${bodyLabel}, label %${exitLabel}`,
    );

    lines.push(`${bodyLabel}:`);
    this.controlStack.push({
      kind: "loop",
      continueLabel: condLabel,
      breakLabel: exitLabel,
    });
    let terminated = false;
    for (const s of stmt.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    this.controlStack.pop();
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
      lines.push(
        `  br i1 ${cond.llvm}, label %${bodyLabel}, label %${exitLabel}`,
      );
    } else {
      lines.push(`  br label %${bodyLabel}`);
    }

    lines.push(`${bodyLabel}:`);
    this.controlStack.push({
      kind: "loop",
      continueLabel: latchLabel,
      breakLabel: exitLabel,
    });
    let terminated = false;
    for (const s of stmt.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    this.controlStack.pop();
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
    this.locals.set(stmt.name.name, {
      ptr: elemPtr,
      type: elemType,
      boxed: false,
    });

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
    const element = this.emitArrayIndexLoad(
      iterable.llvm,
      idxForLoad,
      elemType,
      lines,
    );
    lines.push(`  store ${elemLlvm} ${element.llvm}, ptr ${elemPtr}`);

    this.controlStack.push({
      kind: "loop",
      continueLabel: latchLabel,
      breakLabel: exitLabel,
    });
    let terminated = false;
    for (const s of stmt.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(s, lines);
    }
    this.controlStack.pop();
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

  /**
   * Locals: value types alloca the aggregate and store a copy; reference types
   * alloca a `ptr` and store the shared reference.
   */
  private emitVariableDeclaration(
    stmt: VariableDeclaration,
    lines: string[],
  ): void {
    if (stmt.binding.kind === "ArrayBindingPattern") {
      this.emitDestructuringDeclaration(stmt, lines);
      return;
    }

    const name = stmt.binding.name;
    const type = this.resolveDeclType(stmt);
    const llvmType = toLlvmType(type);
    const mutable = stmt.mutability === "let";
    const shouldBox = mutable && this.boxedNames.has(name);

    if (shouldBox) {
      this.needsSnAlloc = true;
      this.needsCallableRuntime = true;
      const boxHolder = `%v.${name}`;
      lines.push(`  ${boxHolder} = alloca ptr`);
      this.pushGcRoot(boxHolder, lines);
      const heap = this.nextTemp();
      lines.push(
        `  ${heap} = call ptr @sn_alloc(i64 noundef ${llvmSizeofExpr(llvmType)})`,
      );
      this.rootHeapPtr(heap, lines);
      this.needsGc = true;
      const boxTypeId = this.ensureBoxTypeInfo(type);
      lines.push(
        `  call void @sn_gc_set_type(ptr noundef ${heap}, i32 noundef ${boxTypeId})`,
      );
      lines.push(`  store ptr ${heap}, ptr ${boxHolder}`);
      this.locals.set(name, { ptr: boxHolder, type, boxed: true });
      if (stmt.initializer === null) {
        lines.push(`  store ${llvmType} ${zeroInitializer(type)}, ptr ${heap}`);
        return;
      }
      const init = this.emitExpression(stmt.initializer, lines, type);
      lines.push(`  store ${llvmType} ${init.llvm}, ptr ${heap}`);
      return;
    }

    const ptr = `%v.${name}`;
    lines.push(`  ${ptr} = alloca ${llvmType}`);
    this.locals.set(name, { ptr, type, boxed: false });
    this.registerRootsForStorage(ptr, type, lines);

    if (stmt.initializer === null) {
      lines.push(`  store ${llvmType} ${zeroInitializer(type)}, ptr ${ptr}`);
      return;
    }

    const init = this.emitExpression(stmt.initializer, lines, type);
    lines.push(`  store ${llvmType} ${init.llvm}, ptr ${ptr}`);
  }

  private emitDestructuringDeclaration(
    stmt: VariableDeclaration,
    lines: string[],
  ): void {
    const pattern = stmt.binding;
    if (pattern.kind !== "ArrayBindingPattern" || !stmt.initializer) {
      throw new Error("Codegen: invalid destructuring declaration");
    }
    const annotated = stmt.typeAnnotation
      ? this.resolveAnnotation(stmt.typeAnnotation)
      : null;
    const tuple = this.emitExpression(
      stmt.initializer,
      lines,
      annotated ?? undefined,
    );
    if (!isTupleType(tuple.type)) {
      throw new Error("Codegen: destructuring requires a tuple");
    }
    if (pattern.elements.length !== tuple.type.elements.length) {
      throw new Error("Codegen: destructuring arity mismatch");
    }
    const llvmType = toLlvmType(tuple.type);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${llvmType}`);
    lines.push(`  store ${llvmType} ${tuple.llvm}, ptr ${tmp}`);

    for (let i = 0; i < pattern.elements.length; i += 1) {
      const el = pattern.elements[i]!;
      if (!el.name) {
        continue;
      }
      const elemType = tuple.type.elements[i]!;
      const elemLlvm = toLlvmType(elemType);
      const fieldPtr = this.emitStructFieldPtr(
        tmp,
        tupleTypeName(tuple.type.elements),
        i,
        lines,
      );
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${elemLlvm}, ptr ${fieldPtr}`);
      const ptr = `%v.${el.name.name}`;
      lines.push(`  ${ptr} = alloca ${elemLlvm}`);
      lines.push(`  store ${elemLlvm} ${loaded}, ptr ${ptr}`);
      this.locals.set(el.name.name, { ptr, type: elemType, boxed: false });
      this.registerRootsForStorage(ptr, elemType, lines);
    }
  }

  /**
   * Assignment copies by TypeCategory: value → store aggregate/scalar;
   * reference → store ptr (alias). Struct copies are shallow (nested refs shared).
   */
  private emitAssignment(stmt: AssignmentStatement, lines: string[]): void {
    if (stmt.target.kind === "Identifier") {
      const local = this.locals.get(stmt.target.name);
      if (local) {
        const llvmType = toLlvmType(local.type);
        const storePtr = this.storagePtr(local, lines);

        if (stmt.operator === "=") {
          const value = this.emitExpression(stmt.value, lines, local.type);
          lines.push(`  store ${llvmType} ${value.llvm}, ptr ${storePtr}`);
          return;
        }

        const loaded = this.nextTemp();
        lines.push(`  ${loaded} = load ${llvmType}, ptr ${storePtr}`);
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
        lines.push(`  store ${llvmType} ${result}, ptr ${storePtr}`);
        return;
      }

      const modVal = this.localValues.get(stmt.target.name);
      if (!modVal) {
        throw new Error(`Codegen: unknown variable '${stmt.target.name}'`);
      }
      const llvmType = toLlvmType(modVal.type);
      const globalPtr = `@${modVal.mangledName}`;
      if (stmt.operator === "=") {
        const value = this.emitExpression(stmt.value, lines, modVal.type);
        lines.push(`  store ${llvmType} ${value.llvm}, ptr ${globalPtr}`);
        return;
      }
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${llvmType}, ptr ${globalPtr}`);
      const rhs = this.emitExpression(stmt.value, lines, modVal.type);
      const result = this.nextTemp();
      const isFloat = modVal.type === "f32" || modVal.type === "f64";
      const opcode =
        stmt.operator === "+="
          ? isFloat
            ? "fadd"
            : "add"
          : isFloat
            ? "fsub"
            : "sub";
      lines.push(`  ${result} = ${opcode} ${llvmType} ${loaded}, ${rhs.llvm}`);
      lines.push(`  store ${llvmType} ${result}, ptr ${globalPtr}`);
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
    if (
      isMapType(object.type) ||
      (isObjectType(object.type) && object.type.indexType)
    ) {
      this.needsSnMap = true;
      if (stmt.operator !== "=") {
        throw new Error("Codegen: compound assign on map element");
      }
      const index = this.emitExpression(stmt.target.index, lines, "string");
      const valueType = (
        isMapType(object.type) ? object.type.valueType : object.type.indexType
      ) as ValueType;
      const value = this.emitExpression(stmt.value, lines, valueType);
      lines.push(
        `  call void @sn_map_set(ptr ${object.llvm}, ptr ${index.llvm}, ptr ${value.llvm})`,
      );
      return;
    }
    if (isTupleType(object.type)) {
      const constIndex = this.constantIndexValue(stmt.target.index);
      if (constIndex === null) {
        throw new Error(
          "Codegen: tuple element assignment requires a constant index",
        );
      }
      if (constIndex < 0 || constIndex >= object.type.elements.length) {
        throw new Error(`Codegen: tuple index ${constIndex} out of bounds`);
      }
      const elemType = object.type.elements[constIndex]!;
      const elemLlvm = toLlvmType(elemType);
      const tupleName = tupleTypeName(object.type.elements);
      const tmp = this.nextTemp();
      const llvmType = toLlvmType(object.type);
      lines.push(`  ${tmp} = alloca ${llvmType}`);
      lines.push(`  store ${llvmType} ${object.llvm}, ptr ${tmp}`);
      const fieldPtr = this.emitStructFieldPtr(
        tmp,
        tupleName,
        constIndex,
        lines,
      );

      if (stmt.operator === "=") {
        const value = this.emitExpression(stmt.value, lines, elemType);
        lines.push(`  store ${elemLlvm} ${value.llvm}, ptr ${fieldPtr}`);
      } else {
        const loaded = this.nextTemp();
        lines.push(`  ${loaded} = load ${elemLlvm}, ptr ${fieldPtr}`);
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
        lines.push(
          `  ${result} = ${opcode} ${elemLlvm} ${loaded}, ${rhs.llvm}`,
        );
        lines.push(`  store ${elemLlvm} ${result}, ptr ${fieldPtr}`);
      }

      // Write updated aggregate back if the object is a local identifier
      if (stmt.target.object.kind === "Identifier") {
        const local = this.locals.get(stmt.target.object.name);
        if (local) {
          const updated = this.nextTemp();
          lines.push(`  ${updated} = load ${llvmType}, ptr ${tmp}`);
          lines.push(`  store ${llvmType} ${updated}, ptr ${local.ptr}`);
        }
      }
      return;
    }
    if (!isArrayType(object.type)) {
      throw new Error("Codegen: index assign on non-array");
    }
    const index = this.emitExpression(stmt.target.index, lines);
    const indexI32 = this.asI32Index(index, lines);
    const elemType = object.type.element;
    const elemLlvm = toLlvmType(elemType);
    const elemPtr = this.emitArrayElementPtr(
      object.llvm,
      indexI32,
      elemType,
      lines,
    );

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
    if (local) {
      const llvmType = toLlvmType(local.type);
      const storePtr = this.storagePtr(local, lines);
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${llvmType}, ptr ${storePtr}`);
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
      lines.push(`  store ${llvmType} ${result}, ptr ${storePtr}`);
      return;
    }

    const modVal = this.localValues.get(stmt.name.name);
    if (!modVal) {
      throw new Error(`Codegen: unknown variable '${stmt.name.name}'`);
    }
    const llvmType = toLlvmType(modVal.type);
    const globalPtr = `@${modVal.mangledName}`;
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${llvmType}, ptr ${globalPtr}`);
    const result = this.nextTemp();
    const isFloat = modVal.type === "f32" || modVal.type === "f64";
    const one = typedOne(modVal.type);
    if (stmt.operator === "++") {
      const opcode = isFloat ? "fadd" : "add";
      lines.push(`  ${result} = ${opcode} ${llvmType} ${loaded}, ${one}`);
    } else {
      const opcode = isFloat ? "fsub" : "sub";
      lines.push(`  ${result} = ${opcode} ${llvmType} ${loaded}, ${one}`);
    }
    lines.push(`  store ${llvmType} ${result}, ptr ${globalPtr}`);
  }

  /** Returns copy value aggregates / scalars; reference returns copy the ptr. */
  private emitReturn(stmt: ReturnStatement, lines: string[]): void {
    const tryCtx = this.enclosingTryWithFinally();
    if (stmt.value === null) {
      if (tryCtx) {
        this.pendingReturn = { llvm: "", type: "void" };
        lines.push(`  br label %${tryCtx.normalLeaveLabel}`);
        return;
      }
      this.emitFunctionRet(lines, "  ret void");
      return;
    }
    const expected =
      this.currentReturnType && this.currentReturnType !== "void"
        ? this.currentReturnType
        : undefined;
    const value = this.emitExpression(stmt.value, lines, expected);
    if (tryCtx) {
      this.pendingReturn = { llvm: value.llvm, type: value.type };
      lines.push(`  br label %${tryCtx.normalLeaveLabel}`);
      return;
    }
    this.emitFunctionRet(
      lines,
      `  ret ${toLlvmType(value.type)} ${value.llvm}`,
    );
  }

  private emitCallStatement(call: CallExpression, lines: string[]): void {
    if (call.callee.kind === "SuperExpression") {
      this.emitSuperCall(call, lines);
      return;
    }
    if (call.callee.kind === "MemberExpression") {
      if (this.isConsoleBuiltin(call)) {
        this.emitConsoleCall(call, lines);
        return;
      }
      if (this.isNamespaceCallee(call)) {
        this.emitNamespaceCall(call, lines, true);
        return;
      }
      this.emitMethodCall(call, lines, true);
      return;
    }
    if (call.callee.kind === "Identifier" && call.callee.name === "print") {
      this.emitPrintCall(call, lines);
      return;
    }
    if (call.callee.kind === "Identifier" && call.callee.name === "createMap") {
      this.emitCreateMap(lines);
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
      args.push(
        this.emitExpression(
          asExpressions(call.args)[i]!,
          lines,
          base.constructorParams[i],
        ),
      );
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
    if (!stmt.initializer) {
      throw new Error("Codegen: variable without initializer or annotation");
    }
    return this.inferExpressionType(stmt.initializer);
  }

  private emitIsNullValue(value: EmittedValue, lines: string[]): string {
    const tmp = this.nextTemp();
    if (value.type === "null") {
      lines.push(`  ${tmp} = add i1 true, false`);
      return tmp;
    }
    if (
      isNullablePointerUnion(value.type) ||
      isSinglePtrReference(value.type)
    ) {
      lines.push(`  ${tmp} = icmp eq ptr ${value.llvm}, null`);
      return tmp;
    }
    if (isUnionType(value.type)) {
      this.needsUnionRuntime = true;
      const tag = this.nextTemp();
      lines.push(`  ${tag} = extractvalue %__Union ${value.llvm}, 0`);
      lines.push(`  ${tmp} = icmp eq i32 ${tag}, ${UNION_TAG.null}`);
      return tmp;
    }
    lines.push(`  ${tmp} = add i1 false, false`);
    return tmp;
  }

  private emitNullForResultType(
    resultType: ValueType,
    lines: string[],
  ): EmittedValue {
    if (isUnionType(resultType)) {
      if (isNullablePointerUnion(resultType)) {
        return { llvm: "null", type: resultType };
      }
      return this.boxNullUnion(resultType, lines);
    }
    return { llvm: "null", type: "null" };
  }

  private emitOptionalBranch(
    object: EmittedValue,
    resultType: ValueType,
    lines: string[],
    access: (object: EmittedValue) => EmittedValue,
  ): EmittedValue {
    const isNull = this.emitIsNullValue(object, lines);
    const nullBb = this.nextLabel("opt_null");
    const accessBb = this.nextLabel("opt_access");
    const mergeBb = this.nextLabel("opt_merge");
    lines.push(`  br i1 ${isNull}, label %${nullBb}, label %${accessBb}`);

    lines.push(`${nullBb}:`);
    const nullVal = this.emitNullForResultType(resultType, lines);
    lines.push(`  br label %${mergeBb}`);

    lines.push(`${accessBb}:`);
    const accessed = access(object);
    const innerType = includesNull(resultType)
      ? (stripNull(resultType) as ValueType)
      : resultType;
    let accessVal = this.coerceValue(accessed, innerType, lines);
    if (isUnionType(resultType) && !isNullablePointerUnion(resultType)) {
      accessVal = this.boxUnion(accessVal, resultType, lines);
    } else if (isNullablePointerUnion(resultType)) {
      accessVal = { llvm: accessVal.llvm, type: resultType };
    }
    lines.push(`  br label %${mergeBb}`);

    lines.push(`${mergeBb}:`);
    const phi = this.nextTemp();
    const llvmType = toLlvmType(resultType);
    lines.push(
      `  ${phi} = phi ${llvmType} [ ${accessVal.llvm}, %${accessBb} ], [ ${nullVal.llvm}, %${nullBb} ]`,
    );
    return { llvm: phi, type: resultType };
  }

  private emitNullCoalescing(
    expr: Extract<Expression, { kind: "NullCoalescingExpression" }>,
    lines: string[],
  ): EmittedValue {
    const resultType = this.inferExpressionType(expr);
    const left = this.emitExpression(expr.left, lines);
    const isNull = this.emitIsNullValue(left, lines);
    const rhsBb = this.nextLabel("coalesce_rhs");
    const useLeftBb = this.nextLabel("coalesce_left");
    const mergeBb = this.nextLabel("coalesce_merge");
    lines.push(`  br i1 ${isNull}, label %${rhsBb}, label %${useLeftBb}`);

    lines.push(`${useLeftBb}:`);
    const leftCoerced = this.coerceValue(left, resultType, lines);
    lines.push(`  br label %${mergeBb}`);

    lines.push(`${rhsBb}:`);
    const right = this.emitExpression(expr.right, lines, resultType);
    const coercedRight = this.coerceValue(right, resultType, lines);
    lines.push(`  br label %${mergeBb}`);

    lines.push(`${mergeBb}:`);
    const phi = this.nextTemp();
    const llvmType = toLlvmType(resultType);
    lines.push(
      `  ${phi} = phi ${llvmType} [ ${leftCoerced.llvm}, %${useLeftBb} ], [ ${coercedRight.llvm}, %${rhsBb} ]`,
    );
    return { llvm: phi, type: resultType };
  }

  private inferExpressionType(
    expr: Expression,
    expected?: ValueType,
  ): ValueType {
    switch (expr.kind) {
      case "IntegerLiteral":
        return "i32";
      case "FloatLiteral":
        return "f64";
      case "BooleanLiteral":
        return "bool";
      case "StringLiteral":
        return "string";
      case "TemplateLiteral":
        return "string";
      case "CharLiteral":
        return "char";
      case "NullLiteral":
        return "null";
      case "IsExpression":
        return "bool";
      case "ArrayLiteral": {
        if (expected && isTupleType(expected)) {
          return expected;
        }
        if (expr.elements.length === 0) {
          if (expected && isArrayType(expected)) {
            return expected;
          }
          throw new Error("Codegen: empty array without annotation");
        }
        const elementTypes = expr.elements.map((el) =>
          this.inferExpressionType(el),
        );
        const first = elementTypes[0]!;
        if (elementTypes.every((t) => typesEqual(t, first))) {
          return { kind: "array", element: first };
        }
        return { kind: "tuple", elements: elementTypes };
      }
      case "StructLiteral": {
        const def = this.lookupStruct(
          expr.namespace?.name ?? null,
          expr.name.name,
        );
        if (!def) {
          throw new Error(`Codegen: unknown struct '${expr.name.name}'`);
        }
        return { kind: "struct", name: def.name };
      }
      case "NewExpression": {
        const info = this.lookupClass(
          expr.className.name,
          expr.namespace?.name ?? null,
        );
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
      case "TypeofExpression":
        return "string";
      case "IndexExpression": {
        let objectType = this.inferExpressionType(expr.object);
        if (
          expr.optional &&
          (includesNull(objectType) || objectType === "null")
        ) {
          if (objectType === "null") {
            return "null";
          }
          objectType = stripNull(objectType) as ValueType;
        }
        let inner: ValueType;
        if (isMapType(objectType)) {
          inner = objectType.valueType as ValueType;
        } else if (isObjectType(objectType) && objectType.indexType) {
          inner = objectType.indexType as ValueType;
        } else if (isTupleType(objectType)) {
          if (expr.index.kind === "IntegerLiteral") {
            const i = expr.index.value;
            if (i < 0 || i >= objectType.elements.length) {
              throw new Error(`Codegen: tuple index ${i} out of bounds`);
            }
            inner = objectType.elements[i]!;
          } else if (
            expr.index.kind === "UnaryExpression" &&
            expr.index.operator === "-" &&
            expr.index.operand.kind === "IntegerLiteral"
          ) {
            throw new Error("Codegen: negative tuple index");
          } else {
            inner = makeUnion(objectType.elements) as ValueType;
          }
        } else if (!isArrayType(objectType)) {
          throw new Error("Codegen: index into non-array");
        } else {
          inner = objectType.element;
        }
        if (expr.optional) {
          return makeUnion([inner, "null"]) as ValueType;
        }
        return inner;
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
            return { kind: "enum", name: def.name };
          }
        }
        if (
          expr.object.kind === "Identifier" &&
          this.localEnums.has(expr.object.name) &&
          !this.locals.has(expr.object.name)
        ) {
          return {
            kind: "enum",
            name: this.localEnums.get(expr.object.name)!.name,
          };
        }
        if (
          expr.object.kind === "Identifier" &&
          !this.locals.has(expr.object.name)
        ) {
          const classInfo = this.localClasses.get(expr.object.name);
          if (classInfo) {
            const field = classInfo.staticFields.find(
              (f) => f.name === expr.property.name,
            );
            if (field) {
              return field.type;
            }
          }
          const ns = this.namespaces.get(expr.object.name);
          if (ns) {
            const val = ns.values.get(expr.property.name);
            if (val) {
              return val.type;
            }
          }
        }
        const objectType = this.inferExpressionType(expr.object);
        let resolvedObjectType: ValueType = objectType;
        if (
          expr.optional &&
          (includesNull(objectType) || objectType === "null")
        ) {
          if (objectType === "null") {
            return "null";
          }
          resolvedObjectType = stripNull(objectType) as ValueType;
        }
        let inner: ValueType;
        if (isObjectType(resolvedObjectType)) {
          const field = resolvedObjectType.fields.find(
            (f) => f.name === expr.property.name,
          );
          if (!field) {
            throw new Error(`Codegen: unknown field '${expr.property.name}'`);
          }
          inner = field.type as ValueType;
        } else if (isStructType(resolvedObjectType)) {
          const def = this.structs.get(resolvedObjectType.name);
          if (!def) {
            throw new Error(
              `Codegen: unknown struct '${resolvedObjectType.name}'`,
            );
          }
          const field = def.fields.find((f) => f.name === expr.property.name);
          if (!field) {
            throw new Error(`Codegen: unknown field '${expr.property.name}'`);
          }
          inner = field.type;
        } else if (isClassType(resolvedObjectType)) {
          const def = this.classes.get(resolvedObjectType.name);
          if (!def) {
            throw new Error(
              `Codegen: unknown class '${resolvedObjectType.name}'`,
            );
          }
          const field = def.fields.find((f) => f.name === expr.property.name);
          if (!field) {
            throw new Error(`Codegen: unknown field '${expr.property.name}'`);
          }
          inner = field.type;
        } else if (expr.property.name === "length") {
          inner = "i32";
        } else {
          throw new Error(`Codegen: unknown property '${expr.property.name}'`);
        }
        if (expr.optional) {
          return makeUnion([inner, "null"]) as ValueType;
        }
        return inner;
      }
      case "NonNullExpression": {
        const operand = this.inferExpressionType(expr.expression);
        return stripNull(operand) as ValueType;
      }
      case "NullCoalescingExpression": {
        const left = this.inferExpressionType(expr.left);
        return stripNull(left) as ValueType;
      }
      case "Identifier": {
        const local = this.locals.get(expr.name);
        if (local) {
          return local.type;
        }
        const modVal = this.localValues.get(expr.name);
        if (modVal) {
          return modVal.type;
        }
        const sig = this.localFunctions.get(expr.name);
        if (sig) {
          return {
            kind: "function",
            params: sig.params,
            returnType: sig.returnType,
          };
        }
        throw new Error(`Codegen: unknown variable '${expr.name}'`);
      }
      case "UnaryExpression":
        if (expr.operator === "!") {
          return "bool";
        }
        return this.inferExpressionType(expr.operand);
      case "BinaryExpression": {
        if (
          COMPARISON_OPS.has(expr.operator) ||
          LOGICAL_OPS.has(expr.operator)
        ) {
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
        const wrapOptionalCallType = (inner: ValueType): ValueType =>
          expr.optional ? (makeUnion([inner, "null"]) as ValueType) : inner;
        if (expr.callee.kind === "SuperExpression") {
          throw new Error("Codegen: super call in type inference");
        }
        if (expr.callee.kind === "MemberExpression") {
          if (
            expr.callee.object.kind === "Identifier" &&
            expr.callee.object.name === "console" &&
            expr.callee.property.name === "readLine"
          ) {
            return "string";
          }
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
            return wrapOptionalCallType(sig.returnType);
          }
          if (
            expr.callee.object.kind === "Identifier" &&
            !this.locals.has(expr.callee.object.name)
          ) {
            const classInfo = this.localClasses.get(expr.callee.object.name);
            const methodName = expr.callee.property.name;
            const method = classInfo?.staticMethods.find(
              (m) => m.name === methodName,
            );
            if (method) {
              if (method.returnType === "void") {
                throw new Error("Codegen: void static method in inference");
              }
              return wrapOptionalCallType(method.returnType);
            }
          }
          const method = expr.callee.property.name;
          const extMangled = this.extensionCallRewrites.get(
            expr.span.start.offset,
          );
          if (extMangled) {
            const sig = this.functions.get(extMangled);
            if (!sig || sig.returnType === "void") {
              throw new Error(
                `Codegen: unexpected extension '${extMangled}' in inference`,
              );
            }
            return wrapOptionalCallType(sig.returnType);
          }
          let objectType = this.inferExpressionType(expr.callee.object);
          if (
            expr.optional &&
            (includesNull(objectType) || objectType === "null")
          ) {
            if (objectType === "null") {
              return "null";
            }
            objectType = stripNull(objectType) as ValueType;
          }
          if (isStructType(objectType)) {
            const def = this.structs.get(objectType.name);
            const m = def?.methods.find((x) => x.name === method);
            if (!m || m.returnType === "void") {
              throw new Error("Codegen: unexpected struct method in inference");
            }
            return wrapOptionalCallType(m.returnType);
          }
          if (isClassType(objectType)) {
            const def = this.classes.get(objectType.name);
            const m = def?.instanceMethods.find((x) => x.name === method);
            if (!m || m.returnType === "void") {
              throw new Error("Codegen: unexpected class method in inference");
            }
            return wrapOptionalCallType(m.returnType);
          }
          if (isInterfaceType(objectType)) {
            const def = this.interfaces.get(objectType.name);
            const m = def?.methods.find((x) => x.name === method);
            if (!m || m.returnType === "void") {
              throw new Error(
                "Codegen: unexpected interface method in inference",
              );
            }
            return wrapOptionalCallType(m.returnType);
          }
          throw new Error(
            `Codegen: unexpected method '${method}' on '${typeToString(objectType)}' in inference`,
          );
        }
        if (expr.callee.kind !== "Identifier") {
          // Indirect / lambda call — use expected or i32 fallback for inference
          if (expected && isFunctionType(expected)) {
            return expected.returnType === "void"
              ? "i32"
              : (expected.returnType as ValueType);
          }
          return "i32";
        }
        const sig = this.localFunctions.get(expr.callee.name);
        if (!sig || sig.returnType === "void") {
          if (expr.callee.name === "createMap") {
            return { kind: "map", valueType: "string" };
          }
          const local = this.locals.get(expr.callee.name);
          if (
            local &&
            isFunctionType(local.type) &&
            local.type.returnType !== "void"
          ) {
            return local.type.returnType as ValueType;
          }
          throw new Error(
            `Codegen: unexpected call in type inference '${expr.callee.name}'`,
          );
        }
        return sig.returnType;
      }
      case "LambdaExpression": {
        if (expected && isFunctionType(expected)) {
          return expected;
        }
        const params: ValueType[] = [];
        for (const p of expr.params) {
          if (!p.typeAnnotation) {
            throw new Error("Codegen: lambda param missing type in inference");
          }
          const t = this.resolveAnnotation(p.typeAnnotation);
          if (!t) {
            throw new Error("Codegen: invalid lambda param type");
          }
          params.push(t);
        }
        let returnType: ValueType | "void" = "i32";
        if (expr.returnType) {
          if (
            expr.returnType.kind === "PrimitiveType" &&
            expr.returnType.name === "void"
          ) {
            returnType = "void";
          } else {
            const rt = this.resolveAnnotation(expr.returnType);
            if (!rt) {
              throw new Error("Codegen: invalid lambda return type");
            }
            returnType = rt;
          }
        } else if (expr.body.kind === "expression") {
          const saved = this.locals;
          this.locals = new Map(saved);
          for (let i = 0; i < expr.params.length; i += 1) {
            this.locals.set(expr.params[i]!.name.name, {
              ptr: `%infer.${expr.params[i]!.name.name}`,
              type: params[i]!,
              boxed: false,
            });
          }
          try {
            returnType = this.inferExpressionType(expr.body.expression);
          } finally {
            this.locals = saved;
          }
        }
        return { kind: "function", params, returnType };
      }
    }
  }

  private emitExpression(
    expr: Expression,
    lines: string[],
    expected?: ValueType,
  ): EmittedValue {
    const value = this.emitExpressionRaw(expr, lines, expected);
    if (expected) {
      return this.coerceValue(value, expected, lines);
    }
    return value;
  }

  private emitExpressionRaw(
    expr: Expression,
    lines: string[],
    expected?: ValueType,
  ): EmittedValue {
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
      case "NullLiteral":
        return { llvm: "null", type: "null" };
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
      case "TemplateLiteral":
        return this.emitTemplateLiteral(expr, lines);
      case "ArrayLiteral":
        return this.emitArrayOrTupleLiteral(expr.elements, lines, expected);
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
          lines.push(
            `  ${loaded} = load %${this.thisType.name}, ptr ${this.thisPtr}`,
          );
          return { llvm: loaded, type: this.thisType };
        }
        return { llvm: this.thisPtr, type: this.thisType };
      }
      case "SuperExpression":
        throw new Error("Codegen: super used as value");
      case "TypeofExpression": {
        const operand = this.emitExpression(expr.operand, lines);
        if (isUnionType(operand.type)) {
          if (isNullablePointerUnion(operand.type)) {
            const isNull = this.nextTemp();
            lines.push(`  ${isNull} = icmp eq ptr ${operand.llvm}, null`);
            const nullG = this.internString("null");
            const objG = this.internString("object");
            const nullPtr = this.nextTemp();
            lines.push(
              `  ${nullPtr} = getelementptr inbounds [${nullG.length} x i8], ptr @${nullG.name}, i64 0, i64 0`,
            );
            const objPtr = this.nextTemp();
            lines.push(
              `  ${objPtr} = getelementptr inbounds [${objG.length} x i8], ptr @${objG.name}, i64 0, i64 0`,
            );
            const sel = this.nextTemp();
            lines.push(
              `  ${sel} = select i1 ${isNull}, ptr ${nullPtr}, ptr ${objPtr}`,
            );
            return { llvm: sel, type: "string" };
          }
          this.needsUnionRuntime = true;
          const tag = this.nextTemp();
          lines.push(`  ${tag} = extractvalue %__Union ${operand.llvm}, 0`);
          return this.emitTypeofFromTag(tag, lines);
        }
        const tagName = typeofTagForType(operand.type) ?? "object";
        const global = this.internString(tagName);
        const tmp = this.nextTemp();
        lines.push(
          `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
        );
        return { llvm: tmp, type: "string" };
      }
      case "IsExpression":
        return this.emitIsExpression(expr, lines);
      case "NonNullExpression":
        return this.emitExpression(expr.expression, lines, expected);
      case "NullCoalescingExpression":
        return this.emitNullCoalescing(expr, lines);
      case "IndexExpression": {
        if (expr.optional) {
          const object = this.emitExpression(expr.object, lines);
          const resultType = this.inferExpressionType(expr);
          return this.emitOptionalBranch(object, resultType, lines, (obj) =>
            this.emitIndexAccess(expr, obj, lines),
          );
        }
        const object = this.emitExpression(expr.object, lines);
        return this.emitIndexAccess(expr, object, lines);
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
              throw new Error(
                `Codegen: unknown variant '${expr.property.name}'`,
              );
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
        if (
          expr.object.kind === "Identifier" &&
          !this.locals.has(expr.object.name)
        ) {
          const classInfo = this.localClasses.get(expr.object.name);
          if (classInfo) {
            const field = classInfo.staticFields.find(
              (f) => f.name === expr.property.name,
            );
            if (field?.staticGlobal) {
              const loaded = this.nextTemp();
              lines.push(
                `  ${loaded} = load ${toLlvmType(field.type)}, ptr @${field.staticGlobal}`,
              );
              return { llvm: loaded, type: field.type };
            }
          }
          const ns = this.namespaces.get(expr.object.name);
          if (ns) {
            const val = ns.values.get(expr.property.name);
            if (val) {
              const loaded = this.nextTemp();
              lines.push(
                `  ${loaded} = load ${toLlvmType(val.type)}, ptr @${val.mangledName}`,
              );
              return { llvm: loaded, type: val.type };
            }
          }
        }
        const objectType = this.inferExpressionType(expr.object);
        const emitMemberValue = (): EmittedValue => {
          if (isStructType(objectType)) {
            return this.emitStructFieldLoad(expr, lines);
          }
          if (isClassType(objectType)) {
            return this.emitClassFieldLoad(expr, lines);
          }
          if (isNullablePointerUnion(objectType)) {
            const classArm = flattenUnion(objectType).find(
              (a) => typeof a === "object" && a.kind === "class",
            );
            if (
              classArm &&
              typeof classArm === "object" &&
              classArm.kind === "class"
            ) {
              const object = this.emitExpression(expr.object, lines);
              const classInfo =
                [...this.localClasses.values()].find(
                  (c) => c.name === classArm.name,
                ) ??
                [...this.localClasses.values()].find(
                  (c) => c.localName === classArm.name,
                );
              if (!classInfo) {
                throw new Error(`Codegen: unknown class '${classArm.name}'`);
              }
              const field = classInfo.fields.find(
                (f) => f.name === expr.property.name,
              );
              if (!field) {
                throw new Error(
                  `Codegen: unknown field '${expr.property.name}'`,
                );
              }
              const fieldPtr = this.nextTemp();
              lines.push(
                `  ${fieldPtr} = getelementptr inbounds %${classInfo.name}, ptr ${object.llvm}, i32 0, i32 ${field.fieldIndex}`,
              );
              const loaded = this.nextTemp();
              lines.push(
                `  ${loaded} = load ${toLlvmType(field.type)}, ptr ${fieldPtr}`,
              );
              return { llvm: loaded, type: field.type };
            }
          }
          if (expr.property.name !== "length") {
            throw new Error(
              `Codegen: unknown property '${expr.property.name}'`,
            );
          }
          const object = this.emitExpression(expr.object, lines);
          if (object.type === "string" || isUnionType(object.type)) {
            this.needsSnString = true;
            let asString = object;
            if (isUnionType(object.type)) {
              if (isNullablePointerUnion(object.type)) {
                asString = { llvm: object.llvm, type: "string" };
              } else {
                asString = this.unboxUnion(object, "string", lines);
              }
            }
            const len32 = this.nextTemp();
            lines.push(
              `  ${len32} = call i32 @sn_str_len(ptr ${asString.llvm})`,
            );
            return { llvm: len32, type: "i32" };
          }
          if (isTupleType(object.type)) {
            return { llvm: String(object.type.elements.length), type: "i32" };
          }
          if (!isArrayType(object.type)) {
            throw new Error("Codegen: .length on non-array");
          }
          const length = this.emitArrayLength(object.llvm, lines);
          return { llvm: length, type: "i32" };
        };
        if (expr.optional) {
          const object = this.emitExpression(expr.object, lines);
          const resultType = this.inferExpressionType(expr);
          return this.emitOptionalBranch(object, resultType, lines, (obj) =>
            this.emitMemberValueWithObject(expr, obj, lines),
          );
        }
        return emitMemberValue();
      }
      case "Identifier": {
        const local = this.locals.get(expr.name);
        if (local) {
          const storePtr = this.storagePtr(local, lines);
          const tmp = this.nextTemp();
          lines.push(
            `  ${tmp} = load ${toLlvmType(local.type)}, ptr ${storePtr}`,
          );
          return { llvm: tmp, type: local.type };
        }
        const modVal = this.localValues.get(expr.name);
        if (modVal) {
          const tmp = this.nextTemp();
          lines.push(
            `  ${tmp} = load ${toLlvmType(modVal.type)}, ptr @${modVal.mangledName}`,
          );
          return { llvm: tmp, type: modVal.type };
        }
        const sig = this.localFunctions.get(expr.name);
        if (sig) {
          return this.emitNamedFunctionRef(sig, lines);
        }
        throw new Error(`Codegen: unknown variable '${expr.name}'`);
      }
      case "LambdaExpression":
        return this.emitLambdaExpression(expr, lines, expected);
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
          if (this.isConsoleBuiltin(expr)) {
            if (
              expr.callee.property.name === "readLine"
            ) {
              this.needsSnPrint = true;
              this.needsGc = true;
              const tmp = this.nextTemp();
              lines.push(`  ${tmp} = call ptr @sn_read_line()`);
              this.rootHeapPtr(tmp, lines);
              return { llvm: tmp, type: "string" };
            }
            this.emitConsoleCall(expr, lines);
            return { llvm: "void", type: "i32" };
          }
          if (this.isNamespaceCallee(expr)) {
            return this.emitNamespaceCall(expr, lines, false);
          }
          if (expr.optional) {
            const object = this.emitExpression(expr.callee.object, lines);
            const resultType = this.inferExpressionType(expr);
            return this.emitOptionalBranch(object, resultType, lines, (obj) =>
              this.emitMethodCall(expr, lines, false, obj),
            );
          }
          return this.emitMethodCall(expr, lines, false);
        }
        if (
          expr.callee.kind === "Identifier" &&
          expr.callee.name === "createMap"
        ) {
          return this.emitCreateMap(lines, expected);
        }
        return this.emitUserCall(expr, lines, false);
    }
  }

  private interfaceToValueType(
    ifaceInfo: InterfaceInfo,
    localStructs: Map<string, StructInfo>,
    localEnums: Map<string, EnumInfo>,
    localClasses: Map<string, ClassInfo>,
    localInterfaces: Map<string, InterfaceInfo>,
    namespaces: Map<string, NamespaceInfo>,
  ): ValueType | null {
    const indexSig = ifaceInfo.decl.indexSignature;
    if (
      indexSig &&
      ifaceInfo.methods.length === 0 &&
      ifaceInfo.decl.methods.length === 0
    ) {
      const valueType = this.resolveAnnotationInModule(
        indexSig.valueType,
        localStructs,
        localEnums,
        localClasses,
        localInterfaces,
        namespaces,
      );
      if (valueType) {
        return { kind: "map", valueType };
      }
    }
    return { kind: "interface", name: ifaceInfo.name };
  }

  private lookupStruct(
    namespace: string | null,
    name: string,
  ): StructInfo | undefined {
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
    if (
      call.callee.kind !== "MemberExpression" ||
      call.callee.object.kind !== "Identifier"
    ) {
      throw new Error("Codegen: expected namespace call");
    }
    const ns = this.namespaces.get(call.callee.object.name);
    if (!ns) {
      throw new Error(
        `Codegen: unknown namespace '${call.callee.object.name}'`,
      );
    }
    const sig = ns.functions.get(call.callee.property.name);
    if (!sig) {
      throw new Error(
        `Codegen: unknown function '${call.callee.object.name}.${call.callee.property.name}'`,
      );
    }
    return this.emitCallWithSig(
      sig,
      asExpressions(call.args),
      lines,
      asStatement,
    );
  }

  private emitStructLiteral(
    expr: StructLiteral,
    lines: string[],
  ): EmittedValue {
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
        throw new Error(
          `Codegen: missing field '${field.name}' in struct literal`,
        );
      }
      const value = this.emitExpression(initExpr, lines, field.type);
      const fieldPtr = this.emitStructFieldPtr(tmp, def.name, i, lines);
      lines.push(
        `  store ${toLlvmType(field.type)} ${value.llvm}, ptr ${fieldPtr}`,
      );
    }

    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${llvmType}, ptr ${tmp}`);
    return { llvm: loaded, type: structType };
  }

  private emitStructFieldLoad(
    expr: MemberExpression,
    lines: string[],
  ): EmittedValue {
    const fieldPtr = this.emitMemberFieldPtr(expr, lines);
    const fieldType = this.inferExpressionType(expr);
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${toLlvmType(fieldType)}, ptr ${fieldPtr}`);
    return { llvm: loaded, type: fieldType };
  }

  /** Address of the field referenced by a MemberExpression (supports nested a.b.c). */
  private emitMemberFieldPtr(expr: MemberExpression, lines: string[]): string {
    // Static class field
    if (
      expr.object.kind === "Identifier" &&
      !this.locals.has(expr.object.name)
    ) {
      const classInfo = this.localClasses.get(expr.object.name);
      if (classInfo) {
        const field = classInfo.staticFields.find(
          (f) => f.name === expr.property.name,
        );
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
      const fieldIndex = def.fields.findIndex(
        (f) => f.name === expr.property.name,
      );
      if (fieldIndex < 0) {
        throw new Error(`Codegen: unknown field '${expr.property.name}'`);
      }
      return this.emitStructFieldPtr(
        structPtr,
        objectType.name,
        fieldIndex,
        lines,
      );
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

  private emitClassFieldLoad(
    expr: MemberExpression,
    lines: string[],
  ): EmittedValue {
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
      const fieldIndex = def.fields.findIndex(
        (f) => f.name === expr.property.name,
      );
      if (fieldIndex < 0) {
        throw new Error(`Codegen: unknown field '${expr.property.name}'`);
      }
      const fieldType = def.fields[fieldIndex]!.type;
      if (!isStructType(fieldType) || fieldType.name !== expected.name) {
        throw new Error("Codegen: nested field is not the expected struct");
      }
      return this.emitStructFieldPtr(
        parentPtr,
        objectType.name,
        fieldIndex,
        lines,
      );
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
    this.needsSnArray = true;

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
    const elemLlvm = toLlvmType(elementType);
    const header = this.nextTemp();
    this.needsGc = true;
    lines.push(
      `  ${header} = call ptr @sn_array_new(i64 noundef ${length}, i64 noundef ${capacity}, i64 noundef ${llvmSizeofExpr(elemLlvm)})`,
    );
    this.rootHeapPtr(header, lines);
    const elemRef = this.refClassForElement(elementType);
    const elemTypeId = this.elementTypeIdForGc(elementType, elemRef);
    lines.push(
      `  call void @sn_gc_set_array_meta(ptr noundef ${header}, i32 noundef ${elemRef}, i32 noundef ${elemTypeId}, i64 noundef ${llvmSizeofExpr(elemLlvm)})`,
    );

    const dataField = this.nextTemp();
    lines.push(
      `  ${dataField} = getelementptr inbounds i8, ptr ${header}, i64 16`,
    );
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataField}`);

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

  private emitArrayOrTupleLiteral(
    elements: Expression[],
    lines: string[],
    expected?: ValueType,
  ): EmittedValue {
    if (expected && isTupleType(expected)) {
      return this.emitTupleLiteral(elements, expected, lines);
    }
    if (elements.length > 0) {
      const elementTypes = elements.map((el) => this.inferExpressionType(el));
      const first = elementTypes[0]!;
      if (!elementTypes.every((t) => typesEqual(t, first))) {
        const tupleType: TupleValueType = {
          kind: "tuple",
          elements: elementTypes,
        };
        return this.emitTupleLiteral(elements, tupleType, lines);
      }
    }
    return this.emitArrayLiteral(elements, lines, expected);
  }

  private emitTupleLiteral(
    elements: Expression[],
    tupleType: TupleValueType,
    lines: string[],
  ): EmittedValue {
    if (elements.length !== tupleType.elements.length) {
      throw new Error("Codegen: tuple literal arity mismatch");
    }
    const llvmType = toLlvmType(tupleType);
    const name = tupleTypeName(tupleType.elements);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${llvmType}`);
    for (let i = 0; i < elements.length; i += 1) {
      const elemType = tupleType.elements[i]!;
      const value = this.emitExpression(elements[i]!, lines, elemType);
      const fieldPtr = this.emitStructFieldPtr(tmp, name, i, lines);
      lines.push(
        `  store ${toLlvmType(elemType)} ${value.llvm}, ptr ${fieldPtr}`,
      );
    }
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${llvmType}, ptr ${tmp}`);
    return { llvm: loaded, type: tupleType };
  }

  private constantIndexValue(expr: Expression): number | null {
    if (expr.kind === "IntegerLiteral") {
      return expr.value;
    }
    if (
      expr.kind === "UnaryExpression" &&
      expr.operator === "-" &&
      expr.operand.kind === "IntegerLiteral"
    ) {
      return -expr.operand.value;
    }
    return null;
  }

  private emitTupleIndexLoad(
    object: EmittedValue,
    indexExpr: Expression,
    lines: string[],
  ): EmittedValue {
    if (!isTupleType(object.type)) {
      throw new Error("Codegen: tuple index on non-tuple");
    }
    const tupleType = object.type;
    const constIndex = this.constantIndexValue(indexExpr);
    const llvmType = toLlvmType(tupleType);
    const name = tupleTypeName(tupleType.elements);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${llvmType}`);
    lines.push(`  store ${llvmType} ${object.llvm}, ptr ${tmp}`);

    if (constIndex !== null) {
      if (constIndex < 0 || constIndex >= tupleType.elements.length) {
        throw new Error(`Codegen: tuple index ${constIndex} out of bounds`);
      }
      const elemType = tupleType.elements[constIndex]!;
      const fieldPtr = this.emitStructFieldPtr(tmp, name, constIndex, lines);
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${toLlvmType(elemType)}, ptr ${fieldPtr}`);
      return { llvm: loaded, type: elemType };
    }

    // Dynamic index: bounds check + switch, box into union of element types
    const resultType = makeUnion(tupleType.elements) as ValueType;
    this.needsAbort = true;
    if (isUnionType(resultType)) {
      this.needsUnionRuntime = true;
    }

    const index = this.emitExpression(indexExpr, lines);
    const indexI32 = this.asI32Index(index, lines);
    const n = tupleType.elements.length;
    const okGe = this.nextTemp();
    lines.push(`  ${okGe} = icmp sge i32 ${indexI32}, 0`);
    const okLt = this.nextTemp();
    lines.push(`  ${okLt} = icmp slt i32 ${indexI32}, ${n}`);
    const ok = this.nextTemp();
    lines.push(`  ${ok} = and i1 ${okGe}, ${okLt}`);
    const okLabel = this.nextLabel("tuple_idx_ok");
    const badLabel = this.nextLabel("tuple_idx_oob");
    const contLabel = this.nextLabel("tuple_idx_cont");
    lines.push(`  br i1 ${ok}, label %${okLabel}, label %${badLabel}`);

    lines.push(`${badLabel}:`);
    lines.push(`  call void @abort()`);
    lines.push(`  unreachable`);

    lines.push(`${okLabel}:`);
    const resultPtr = this.nextTemp();
    const resultLlvm = toLlvmType(resultType);
    lines.push(`  ${resultPtr} = alloca ${resultLlvm}`);

    const defaultLabel = this.nextLabel("tuple_idx_default");
    const caseLabels = tupleType.elements.map((_, i) =>
      this.nextLabel(`tuple_idx_${i}`),
    );
    const switchCases = caseLabels
      .map((lab, i) => `i32 ${i}, label %${lab}`)
      .join(" ");
    lines.push(
      `  switch i32 ${indexI32}, label %${defaultLabel} [ ${switchCases} ]`,
    );

    for (let i = 0; i < tupleType.elements.length; i += 1) {
      lines.push(`${caseLabels[i]!}:`);
      const elemType = tupleType.elements[i]!;
      const fieldPtr = this.emitStructFieldPtr(tmp, name, i, lines);
      const loaded = this.nextTemp();
      lines.push(`  ${loaded} = load ${toLlvmType(elemType)}, ptr ${fieldPtr}`);
      const boxed = this.coerceValue(
        { llvm: loaded, type: elemType },
        resultType,
        lines,
      );
      lines.push(`  store ${resultLlvm} ${boxed.llvm}, ptr ${resultPtr}`);
      lines.push(`  br label %${contLabel}`);
    }

    lines.push(`${defaultLabel}:`);
    lines.push(`  call void @abort()`);
    lines.push(`  unreachable`);

    lines.push(`${contLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultLlvm}, ptr ${resultPtr}`);
    return { llvm: result, type: resultType };
  }

  private nextLabel(prefix: string): string {
    const id = this.labelCounter;
    this.labelCounter += 1;
    return `${prefix}.${id}`;
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
    lines.push(
      `  ${dataField} = getelementptr inbounds i8, ptr ${header}, i64 16`,
    );
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

  private emitIndexAccess(
    expr: Extract<Expression, { kind: "IndexExpression" }>,
    object: EmittedValue,
    lines: string[],
  ): EmittedValue {
    let obj = object;
    if (isNullablePointerUnion(obj.type)) {
      const nonNullArms = flattenUnion(obj.type).filter((a) => a !== "null");
      if (nonNullArms.length === 1) {
        obj = { llvm: obj.llvm, type: nonNullArms[0] as ValueType };
      }
    }
    if (isMapType(obj.type) || (isObjectType(obj.type) && obj.type.indexType)) {
      this.needsSnMap = true;
      const index = this.emitExpression(expr.index, lines, "string");
      const result = this.nextTemp();
      lines.push(
        `  ${result} = call ptr @sn_map_get(ptr ${obj.llvm}, ptr ${index.llvm})`,
      );
      const valueType = isMapType(obj.type)
        ? (obj.type.valueType as ValueType)
        : (obj.type.indexType as ValueType);
      return { llvm: result, type: valueType };
    }
    if (isTupleType(obj.type)) {
      return this.emitTupleIndexLoad(obj, expr.index, lines);
    }
    if (!isArrayType(obj.type)) {
      throw new Error("Codegen: index into non-array");
    }
    const index = this.emitExpression(expr.index, lines);
    const indexI32 = this.asI32Index(index, lines);
    return this.emitArrayIndexLoad(obj.llvm, indexI32, obj.type.element, lines);
  }

  private emitMemberValueWithObject(
    expr: MemberExpression,
    object: EmittedValue,
    lines: string[],
  ): EmittedValue {
    const objectType =
      object.type === "null"
        ? object.type
        : this.inferExpressionType(expr.object);
    let resolvedType = objectType;
    if (includesNull(objectType) || objectType === "null") {
      resolvedType = stripNull(objectType) as ValueType;
    }
    if (isStructType(resolvedType)) {
      const def = this.structs.get(resolvedType.name);
      if (!def) {
        throw new Error(`Codegen: unknown struct '${resolvedType.name}'`);
      }
      const fieldIndex = def.fields.findIndex(
        (f) => f.name === expr.property.name,
      );
      if (fieldIndex < 0) {
        throw new Error(`Codegen: unknown field '${expr.property.name}'`);
      }
      const field = def.fields[fieldIndex]!;
      const fieldPtr = this.nextTemp();
      lines.push(
        `  ${fieldPtr} = getelementptr inbounds %${def.name}, ${toLlvmType(resolvedType)} ${object.llvm}, i32 0, i32 ${fieldIndex}`,
      );
      const loaded = this.nextTemp();
      lines.push(
        `  ${loaded} = load ${toLlvmType(field.type)}, ptr ${fieldPtr}`,
      );
      return { llvm: loaded, type: field.type };
    }
    if (isClassType(resolvedType)) {
      const def = this.classes.get(resolvedType.name);
      if (!def) {
        throw new Error(`Codegen: unknown class '${resolvedType.name}'`);
      }
      const field = def.fields.find((f) => f.name === expr.property.name);
      if (!field) {
        throw new Error(`Codegen: unknown field '${expr.property.name}'`);
      }
      const fieldPtr = this.nextTemp();
      lines.push(
        `  ${fieldPtr} = getelementptr inbounds %${def.name}, ptr ${object.llvm}, i32 0, i32 ${field.fieldIndex}`,
      );
      const loaded = this.nextTemp();
      lines.push(
        `  ${loaded} = load ${toLlvmType(field.type)}, ptr ${fieldPtr}`,
      );
      return { llvm: loaded, type: field.type };
    }
    if (expr.property.name === "length") {
      if (object.type === "string" || isUnionType(object.type)) {
        this.needsSnString = true;
        let asString = object;
        if (isUnionType(object.type) && !isNullablePointerUnion(object.type)) {
          asString = this.unboxUnion(object, "string", lines);
        } else if (isNullablePointerUnion(object.type)) {
          asString = { llvm: object.llvm, type: "string" };
        }
        const len32 = this.nextTemp();
        lines.push(`  ${len32} = call i32 @sn_str_len(ptr ${asString.llvm})`);
        return { llvm: len32, type: "i32" };
      }
      if (isTupleType(object.type)) {
        return { llvm: String(object.type.elements.length), type: "i32" };
      }
      if (!isArrayType(object.type)) {
        throw new Error("Codegen: .length on non-array");
      }
      const length = this.emitArrayLength(object.llvm, lines);
      return { llvm: length, type: "i32" };
    }
    throw new Error(`Codegen: unknown property '${expr.property.name}'`);
  }

  private emitMethodCall(
    call: CallExpression,
    lines: string[],
    asStatement: boolean,
    objectOverride?: EmittedValue,
  ): EmittedValue {
    if (call.callee.kind !== "MemberExpression") {
      throw new Error("Codegen: expected method call");
    }
    const callee = call.callee;

    // Extension method: lower to free-function call with receiver as arg0.
    const extMangled = this.extensionCallRewrites.get(call.span.start.offset);
    if (extMangled) {
      const sig = this.functions.get(extMangled);
      if (!sig) {
        throw new Error(`Codegen: unknown extension target '${extMangled}'`);
      }
      const object =
        objectOverride ?? this.emitExpression(callee.object, lines);
      if (objectOverride) {
        const rest = asExpressions(call.args);
        const emitted: EmittedValue[] = [object];
        for (let i = 0; i < rest.length; i += 1) {
          emitted.push(this.emitExpression(rest[i]!, lines, sig.params[i + 1]));
        }
        return this.emitCallWithEmittedArgs(sig, emitted, lines, asStatement);
      }
      const args: Expression[] = [callee.object, ...asExpressions(call.args)];
      return this.emitCallWithSig(sig, args, lines, asStatement);
    }

    // Static method: ClassName.method(...)
    if (
      callee.object.kind === "Identifier" &&
      !this.locals.has(callee.object.name)
    ) {
      const classInfo = this.localClasses.get(callee.object.name);
      const method = classInfo?.staticMethods.find(
        (m) => m.name === callee.property.name,
      );
      if (method) {
        const args: EmittedValue[] = [];
        for (let i = 0; i < call.args.length; i += 1) {
          args.push(
            this.emitExpression(
              asExpressions(call.args)[i]!,
              lines,
              method.params[i],
            ),
          );
        }
        const argList = args
          .map((a) => `${toLlvmType(a.type)} ${a.llvm}`)
          .join(", ");
        if (method.returnType === "void") {
          lines.push(`  call void @${method.mangledName}(${argList})`);
          if (!asStatement) {
            throw new Error("Codegen: void static method used as value");
          }
          return { llvm: "void", type: "i32" };
        }
        const tmp = this.nextTemp();
        const retTy = toLlvmType(method.returnType);
        lines.push(
          `  ${tmp} = call ${retTy} @${method.mangledName}(${argList})`,
        );
        return { llvm: tmp, type: method.returnType };
      }
    }

    let objectType = this.inferExpressionType(callee.object);
    if (objectOverride) {
      objectType = objectOverride.type;
      if (objectType === "null") {
        throw new Error(
          "Codegen: optional call on null object in access block",
        );
      }
      if (includesNull(objectType)) {
        objectType = stripNull(objectType) as ValueType;
      }
    }

    if (isStructType(objectType)) {
      const def = this.structs.get(objectType.name);
      const method = def?.methods.find((m) => m.name === callee.property.name);
      if (!def || !method) {
        throw new Error(
          `Codegen: unknown struct method '${callee.property.name}'`,
        );
      }
      const thisAddr = this.emitStructAddress(callee.object, objectType, lines);
      const args: EmittedValue[] = [];
      for (let i = 0; i < call.args.length; i += 1) {
        args.push(
          this.emitExpression(
            asExpressions(call.args)[i]!,
            lines,
            method.params[i],
          ),
        );
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
      const method = def?.instanceMethods.find(
        (m) => m.name === callee.property.name,
      );
      if (!def || !method) {
        throw new Error(
          `Codegen: unknown class method '${callee.property.name}'`,
        );
      }
      const obj = objectOverride ?? this.emitExpression(callee.object, lines);
      const args: EmittedValue[] = [];
      for (let i = 0; i < call.args.length; i += 1) {
        args.push(
          this.emitExpression(
            asExpressions(call.args)[i]!,
            lines,
            method.params[i],
          ),
        );
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
        lines.push(
          `  ${tmp} = call ${retTy} @${method.mangledName}(${argList})`,
        );
        return { llvm: tmp, type: method.returnType };
      }

      // Virtual dispatch via vtable
      const vtField = this.emitObjectVtablePtr(def.name, obj.llvm, lines);
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
        throw new Error(
          `Codegen: unknown interface method '${callee.property.name}'`,
        );
      }
      const obj = objectOverride ?? this.emitExpression(callee.object, lines);
      const args: EmittedValue[] = [];
      for (let i = 0; i < call.args.length; i += 1) {
        args.push(
          this.emitExpression(
            asExpressions(call.args)[i]!,
            lines,
            method.params[i],
          ),
        );
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

    throw new Error(
      `Codegen: unknown method '${callee.property.name}' on '${typeToString(objectType)}'`,
    );
  }

  private emitArrayPush(
    header: string,
    value: EmittedValue,
    elementType: ValueType,
    lines: string[],
  ): void {
    this.needsSnArray = true;
    const elemLlvm = toLlvmType(elementType);
    const valuePtr = this.nextTemp();
    lines.push(`  ${valuePtr} = alloca ${elemLlvm}`);
    lines.push(`  store ${elemLlvm} ${value.llvm}, ptr ${valuePtr}`);
    lines.push(
      `  call void @sn_array_push(ptr noundef ${header}, ptr noundef ${valuePtr}, i64 noundef ${llvmSizeofExpr(elemLlvm)})`,
    );
  }

  private emitArrayPop(
    header: string,
    elementType: ValueType,
    lines: string[],
  ): EmittedValue {
    this.needsSnArray = true;
    this.needsAbort = true;
    const elemLlvm = toLlvmType(elementType);
    const dest = this.nextTemp();
    lines.push(`  ${dest} = alloca ${elemLlvm}`);
    lines.push(
      `  call void @sn_array_pop(ptr noundef ${header}, ptr noundef ${dest}, i64 noundef ${llvmSizeofExpr(elemLlvm)})`,
    );
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load ${elemLlvm}, ptr ${dest}`);
    return { llvm: loaded, type: elementType };
  }

  private emitArrayIncludes(
    header: string,
    needle: EmittedValue,
    elementType: ValueType,
    lines: string[],
  ): EmittedValue {
    const index = this.emitArrayIndexOf(header, needle, elementType, lines);
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp sge i32 ${index.llvm}, 0`);
    return { llvm: cmp, type: "bool" };
  }

  private emitArrayIndexOf(
    header: string,
    needle: EmittedValue,
    elementType: ValueType,
    lines: string[],
  ): EmittedValue {
    this.needsSnArray = true;
    const cmpKind = this.snCmpKindForType(elementType);
    const elemLlvm = toLlvmType(elementType);
    const needlePtr = this.nextTemp();
    lines.push(`  ${needlePtr} = alloca ${elemLlvm}`);
    lines.push(`  store ${elemLlvm} ${needle.llvm}, ptr ${needlePtr}`);
    const result = this.nextTemp();
    lines.push(
      `  ${result} = call i32 @sn_array_index_of(ptr noundef ${header}, ptr noundef ${needlePtr}, i64 noundef ${llvmSizeofExpr(elemLlvm)}, i32 noundef ${cmpKind})`,
    );
    return { llvm: result, type: "i32" };
  }

  private emitTypeofFromTag(tag: string, lines: string[]): EmittedValue {
    const entries: Array<{ tag: number; name: string }> = [
      { tag: UNION_TAG.string, name: "string" },
      { tag: UNION_TAG.i32, name: "i32" },
      { tag: UNION_TAG.bool, name: "bool" },
      { tag: UNION_TAG.null, name: "null" },
      { tag: UNION_TAG.i64, name: "i64" },
      { tag: UNION_TAG.f32, name: "f32" },
      { tag: UNION_TAG.f64, name: "f64" },
      { tag: UNION_TAG.char, name: "char" },
    ];
    const objG = this.internString("object");
    let result = this.nextTemp();
    lines.push(
      `  ${result} = getelementptr inbounds [${objG.length} x i8], ptr @${objG.name}, i64 0, i64 0`,
    );
    for (const entry of entries) {
      const isMatch = this.nextTemp();
      lines.push(`  ${isMatch} = icmp eq i32 ${tag}, ${entry.tag}`);
      const g = this.internString(entry.name);
      const ptr = this.nextTemp();
      lines.push(
        `  ${ptr} = getelementptr inbounds [${g.length} x i8], ptr @${g.name}, i64 0, i64 0`,
      );
      const sel = this.nextTemp();
      lines.push(`  ${sel} = select i1 ${isMatch}, ptr ${ptr}, ptr ${result}`);
      result = sel;
    }
    return { llvm: result, type: "string" };
  }

  private emitIsExpression(
    expr: Extract<Expression, { kind: "IsExpression" }>,
    lines: string[],
  ): EmittedValue {
    const value = this.emitExpression(expr.value, lines);
    const targetType = this.resolveAnnotation(expr.typeAnnotation);
    if (!targetType) {
      throw new Error("Codegen: invalid is-type annotation");
    }

    const tmp = this.nextTemp();

    if (targetType === "null") {
      if (
        isNullablePointerUnion(value.type) ||
        isSinglePtrReference(value.type) ||
        value.type === "null"
      ) {
        lines.push(`  ${tmp} = icmp eq ptr ${value.llvm}, null`);
        return { llvm: tmp, type: "bool" };
      }
      if (isUnionType(value.type)) {
        this.needsUnionRuntime = true;
        const tag = this.nextTemp();
        lines.push(`  ${tag} = extractvalue %__Union ${value.llvm}, 0`);
        lines.push(`  ${tmp} = icmp eq i32 ${tag}, ${UNION_TAG.null}`);
        return { llvm: tmp, type: "bool" };
      }
      lines.push(`  ${tmp} = add i1 false, false`);
      return { llvm: tmp, type: "bool" };
    }

    // Class match via type_id ancestry (subclass is Base succeeds).
    if (typeof targetType === "object" && targetType.kind === "class") {
      const classInfo =
        this.localClasses.get(targetType.name) ??
        [...this.localClasses.values()].find((c) => c.name === targetType.name);
      // Also search all modules
      let info = classInfo;
      if (!info) {
        for (const c of this.localClasses.values()) {
          if (c.name === targetType.name || c.localName === targetType.name) {
            info = c;
            break;
          }
        }
      }
      // Search namespaces
      if (!info) {
        for (const ns of this.namespaces.values()) {
          for (const c of ns.classes.values()) {
            if (c.name === targetType.name || c.localName === targetType.name) {
              info = c;
              break;
            }
          }
          if (info) {
            break;
          }
        }
      }
      // Search all classes (mangled names)
      if (!info) {
        info = this.classes.get(targetType.name);
      }
      if (!info) {
        for (const c of this.classes.values()) {
          if (c.name === targetType.name || c.localName === targetType.name) {
            info = c;
            break;
          }
        }
      }
      if (!info) {
        throw new Error(
          `Codegen: unknown class for is-check '${targetType.name}'`,
        );
      }

      this.needsTypeInfo = true;
      this.needsIsInstance = true;

      let objPtr = value.llvm;
      if (isUnionType(value.type) && !isNullablePointerUnion(value.type)) {
        this.needsUnionRuntime = true;
        const tag = this.nextTemp();
        lines.push(`  ${tag} = extractvalue %__Union ${value.llvm}, 0`);
        const isObj = this.nextTemp();
        lines.push(`  ${isObj} = icmp eq i32 ${tag}, ${UNION_TAG.object}`);
        const payload = this.nextTemp();
        lines.push(`  ${payload} = extractvalue %__Union ${value.llvm}, 1`);
        const loaded = this.nextTemp();
        lines.push(`  ${loaded} = load ptr, ptr ${payload}`);
        const match = this.nextTemp();
        lines.push(
          `  ${match} = call i1 @sn_is_instance(ptr noundef ${loaded}, i32 noundef ${info.typeId})`,
        );
        lines.push(`  ${tmp} = and i1 ${isObj}, ${match}`);
        return { llvm: tmp, type: "bool" };
      }
      if (isNullablePointerUnion(value.type) || isClassType(value.type)) {
        lines.push(
          `  ${tmp} = call i1 @sn_is_instance(ptr noundef ${objPtr}, i32 noundef ${info.typeId})`,
        );
        return { llvm: tmp, type: "bool" };
      }
    }

    // Primitive / typeof-tag style: compare union tag or static typeof
    const wantTag = this.unionTagForType(targetType);
    if (isUnionType(value.type) && !isNullablePointerUnion(value.type)) {
      this.needsUnionRuntime = true;
      const tag = this.nextTemp();
      lines.push(`  ${tag} = extractvalue %__Union ${value.llvm}, 0`);
      lines.push(`  ${tmp} = icmp eq i32 ${tag}, ${wantTag}`);
      return { llvm: tmp, type: "bool" };
    }

    // Nullable pointer union: non-null means the non-null arm(s)
    if (isNullablePointerUnion(value.type)) {
      const nonNull = flattenUnion(value.type).filter((a) => a !== "null");
      const matches = nonNull.some(
        (arm) =>
          this.unionTagForType(arm as ValueType) === wantTag ||
          (typeof targetType === "object" &&
            typeof arm === "object" &&
            arm.kind === targetType.kind &&
            "name" in arm &&
            "name" in targetType &&
            arm.name === targetType.name),
      );
      if (!matches) {
        lines.push(`  ${tmp} = add i1 false, false`);
        return { llvm: tmp, type: "bool" };
      }
      // True when pointer is non-null (and the non-null arm matches the target)
      lines.push(`  ${tmp} = icmp ne ptr ${value.llvm}, null`);
      return { llvm: tmp, type: "bool" };
    }

    // Static knowledge
    const actualTag = this.unionTagForType(value.type);
    lines.push(
      `  ${tmp} = add i1 ${actualTag === wantTag ? "true" : "false"}, false`,
    );
    return { llvm: tmp, type: "bool" };
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
      const rightType = this.inferExpressionType(expr.right);
      if (leftType === "string" || rightType === "string") {
        return this.emitStringConcat(expr, lines);
      }
    }

    // Null comparisons
    if (
      (expr.operator === "==" || expr.operator === "!=") &&
      (expr.left.kind === "NullLiteral" || expr.right.kind === "NullLiteral")
    ) {
      const nonNullExpr =
        expr.left.kind === "NullLiteral" ? expr.right : expr.left;
      const value = this.emitExpression(nonNullExpr, lines);
      const tmp = this.nextTemp();
      if (
        isNullablePointerUnion(value.type) ||
        isSinglePtrReference(value.type)
      ) {
        const pred = expr.operator === "==" ? "eq" : "ne";
        lines.push(`  ${tmp} = icmp ${pred} ptr ${value.llvm}, null`);
        return { llvm: tmp, type: "bool" };
      }
      if (isUnionType(value.type)) {
        this.needsUnionRuntime = true;
        const tag = this.nextTemp();
        lines.push(`  ${tag} = extractvalue %__Union ${value.llvm}, 0`);
        const pred = expr.operator === "==" ? "eq" : "ne";
        lines.push(`  ${tmp} = icmp ${pred} i32 ${tag}, ${UNION_TAG.null}`);
        return { llvm: tmp, type: "bool" };
      }
      // Fallback: never null
      lines.push(
        `  ${tmp} = add i1 ${expr.operator === "==" ? "false" : "true"}, false`,
      );
      return { llvm: tmp, type: "bool" };
    }

    let left = this.emitExpression(expr.left, lines);
    let right = this.emitExpression(expr.right, lines);
    if (isUnionType(left.type) && !isUnionType(right.type)) {
      if (!isNullablePointerUnion(left.type)) {
        left = this.unboxUnion(left, right.type, lines);
      }
    } else if (!isUnionType(left.type) && isUnionType(right.type)) {
      if (!isNullablePointerUnion(right.type)) {
        right = this.unboxUnion(right, left.type, lines);
      }
    } else if (isUnionType(left.type) && isUnionType(right.type)) {
      if (
        !isNullablePointerUnion(left.type) &&
        !isNullablePointerUnion(right.type)
      ) {
        left = this.unboxUnion(left, "i32", lines);
        right = this.unboxUnion(right, "i32", lines);
      }
    } else if (left.type !== "null" && right.type !== "null") {
      right = this.coerceValue(right, left.type, lines);
    }
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

    // String content equality (not pointer identity).
    if (
      (expr.operator === "==" || expr.operator === "!=") &&
      left.type === "string" &&
      right.type === "string"
    ) {
      this.needsStrcmp = true;
      const cmp = this.nextTemp();
      lines.push(
        `  ${cmp} = call i32 @strcmp(ptr ${left.llvm}, ptr ${right.llvm})`,
      );
      const pred = expr.operator === "==" ? "eq" : "ne";
      lines.push(`  ${tmp} = icmp ${pred} i32 ${cmp}, 0`);
      return { llvm: tmp, type: "bool" };
    }

    if (COMPARISON_OPS.has(expr.operator)) {
      const pred = comparisonPredicate(expr.operator, left.type);
      const isFloat = left.type === "f32" || left.type === "f64";
      const cmp = isFloat ? "fcmp" : "icmp";
      lines.push(
        `  ${tmp} = ${cmp} ${pred} ${llvmType} ${left.llvm}, ${right.llvm}`,
      );
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
        throw new Error(
          `Codegen: unexpected arithmetic operator '${expr.operator}'`,
        );
    }
    lines.push(`  ${tmp} = ${opcode} ${llvmType} ${left.llvm}, ${right.llvm}`);
    return { llvm: tmp, type: left.type };
  }

  private emitStringConcat(
    expr: BinaryExpression,
    lines: string[],
  ): EmittedValue {
    if (
      expr.left.kind === "StringLiteral" &&
      expr.right.kind === "StringLiteral"
    ) {
      const folded = expr.left.value + expr.right.value;
      const global = this.internString(folded);
      const tmp = this.nextTemp();
      lines.push(
        `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
      );
      return { llvm: tmp, type: "string" };
    }

    this.needsSnString = true;
    this.needsGc = true;
    let left = this.emitExpression(expr.left, lines);
    let right = this.emitExpression(expr.right, lines);
    left = this.coerceToString(left, lines);
    right = this.coerceToString(right, lines);
    const buf = this.nextTemp();
    lines.push(
      `  ${buf} = call ptr @sn_str_concat(ptr noundef ${left.llvm}, ptr noundef ${right.llvm})`,
    );
    this.rootHeapPtr(buf, lines);
    return { llvm: buf, type: "string" };
  }

  private emitTemplateLiteral(
    expr: TemplateLiteral,
    lines: string[],
  ): EmittedValue {
    this.needsSnString = true;
    this.needsGc = true;

    const emitQuasi = (text: string): EmittedValue => {
      const global = this.internString(text);
      const tmp = this.nextTemp();
      lines.push(
        `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
      );
      return { llvm: tmp, type: "string" };
    };

    let result = emitQuasi(expr.quasis[0] ?? "");
    for (let i = 0; i < expr.expressions.length; i += 1) {
      let part = this.emitExpression(expr.expressions[i]!, lines);
      part = this.coerceToString(part, lines);
      const buf = this.nextTemp();
      lines.push(
        `  ${buf} = call ptr @sn_str_concat(ptr noundef ${result.llvm}, ptr noundef ${part.llvm})`,
      );
      this.rootHeapPtr(buf, lines);
      result = { llvm: buf, type: "string" };

      const quasi = emitQuasi(expr.quasis[i + 1] ?? "");
      const buf2 = this.nextTemp();
      lines.push(
        `  ${buf2} = call ptr @sn_str_concat(ptr noundef ${result.llvm}, ptr noundef ${quasi.llvm})`,
      );
      this.rootHeapPtr(buf2, lines);
      result = { llvm: buf2, type: "string" };
    }
    return result;
  }

  /** Coerce a printable scalar to a heap string via sn_*_to_string. */
  private coerceToString(value: EmittedValue, lines: string[]): EmittedValue {
    if (
      value.type === "string" ||
      (isLiteralType(value.type) && value.type.literalKind === "string")
    ) {
      return { llvm: value.llvm, type: "string" };
    }
    this.needsSnFormat = true;
    this.needsGc = true;
    const buf = this.nextTemp();
    if (value.type === "i32" || isEnumType(value.type)) {
      lines.push(
        `  ${buf} = call ptr @sn_i32_to_string(i32 noundef ${value.llvm})`,
      );
    } else if (value.type === "i64") {
      lines.push(
        `  ${buf} = call ptr @sn_i64_to_string(i64 noundef ${value.llvm})`,
      );
    } else if (value.type === "f32") {
      lines.push(
        `  ${buf} = call ptr @sn_f32_to_string(float noundef ${value.llvm})`,
      );
    } else if (value.type === "f64") {
      lines.push(
        `  ${buf} = call ptr @sn_f64_to_string(double noundef ${value.llvm})`,
      );
    } else if (value.type === "bool") {
      lines.push(
        `  ${buf} = call ptr @sn_bool_to_string(i1 noundef ${value.llvm})`,
      );
    } else if (value.type === "char") {
      lines.push(
        `  ${buf} = call ptr @sn_char_to_string(i8 noundef ${value.llvm})`,
      );
    } else if (
      isLiteralType(value.type) &&
      value.type.literalKind === "number"
    ) {
      lines.push(
        `  ${buf} = call ptr @sn_i32_to_string(i32 noundef ${value.llvm})`,
      );
    } else if (isArrayType(value.type)) {
      const elemLlvm = toLlvmType(value.type.element);
      const fmtKind = this.snFmtKindForType(value.type.element);
      lines.push(
        `  ${buf} = call ptr @sn_array_to_string(ptr noundef ${value.llvm}, i64 noundef ${llvmSizeofExpr(elemLlvm)}, i32 noundef ${fmtKind})`,
      );
    } else {
      throw new Error(
        `Codegen: cannot coerce type '${typeof value.type === "object" ? value.type.kind : value.type}' to string`,
      );
    }
    this.rootHeapPtr(buf, lines);
    return { llvm: buf, type: "string" };
  }

  private emitCreateMap(lines: string[], expected?: ValueType): EmittedValue {
    this.needsSnMap = true;
    this.needsGc = true;
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = call ptr @sn_map_new()`);
    this.rootHeapPtr(tmp, lines);

    let valueType: ValueType = "string";
    let resultType: ValueType = { kind: "map", valueType: "string" };
    if (expected && isMapType(expected)) {
      valueType = expected.valueType as ValueType;
      resultType = expected;
    } else if (expected && isObjectType(expected) && expected.indexType) {
      valueType = expected.indexType as ValueType;
      resultType = { kind: "map", valueType };
    }

    const valueRef = this.refClassForElement(valueType);
    const valueTypeId =
      valueRef === SN_REF_VALUE
        ? 0
        : valueRef === SN_REF_PTR
          ? this.relatedTypeId(valueType)
          : isFunctionType(valueType)
            ? SN_TYPEID_CLOSURE
            : this.ensureAggregateTypeInfo(valueType);
    lines.push(
      `  call void @sn_gc_set_map_meta(ptr noundef ${tmp}, i32 noundef ${SN_REF_PTR}, i32 noundef ${SN_TYPEID_STRING}, i32 noundef ${valueRef}, i32 noundef ${valueTypeId})`,
    );
    return { llvm: tmp, type: resultType };
  }

  private emitUserCall(
    call: CallExpression,
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    if (call.callee.kind === "Identifier") {
      let sig = this.localFunctions.get(call.callee.name);
      if (!sig) {
        // Extern / runtime symbols are keyed by unmangled C name across modules.
        sig = this.functions.get(call.callee.name);
      }
      if (sig) {
        return this.emitCallWithSig(
          sig,
          asExpressions(call.args),
          lines,
          asStatement,
        );
      }
    }
    const callee = this.emitExpression(call.callee, lines);
    if (!isFunctionType(callee.type)) {
      throw new Error("Codegen: calling non-function value");
    }
    return this.emitIndirectCall(
      callee,
      callee.type,
      asExpressions(call.args),
      lines,
      asStatement,
    );
  }

  private storagePtr(local: LocalBinding, lines: string[]): string {
    if (!local.boxed) {
      return local.ptr;
    }
    const box = this.nextTemp();
    lines.push(`  ${box} = load ptr, ptr ${local.ptr}`);
    return box;
  }

  private collectBoxedNamesInStmts(stmts: Statement[]): Set<string> {
    const names = new Set<string>();
    const visitExpr = (e: Expression): void => {
      if (e.kind === "LambdaExpression") {
        const caps = this.lambdaCaptures.get(e.span.start.offset) ?? [];
        for (const c of caps) {
          if (c.mutable) {
            names.add(c.name);
          }
        }
        if (e.body.kind === "expression") {
          visitExpr(e.body.expression);
        } else {
          for (const s of e.body.statements) visitStmt(s);
        }
        return;
      }
      if (e.kind === "CallExpression") {
        visitExpr(e.callee);
        for (const a of asExpressions(e.args)) visitExpr(a);
      } else if (e.kind === "BinaryExpression") {
        visitExpr(e.left);
        visitExpr(e.right);
      } else if (
        e.kind === "UnaryExpression" ||
        e.kind === "TypeofExpression"
      ) {
        visitExpr(e.operand);
      } else if (e.kind === "IsExpression") {
        visitExpr(e.value);
      } else if (e.kind === "IndexExpression") {
        visitExpr(e.object);
        visitExpr(e.index);
      } else if (e.kind === "MemberExpression") {
        visitExpr(e.object);
      } else if (e.kind === "ArrayLiteral") {
        for (const el of e.elements) visitExpr(el);
      } else if (e.kind === "StructLiteral") {
        for (const f of e.fields) visitExpr(f.value);
      } else if (e.kind === "NewExpression") {
        for (const a of asExpressions(e.args)) visitExpr(a);
      }
    };
    const visitStmt = (s: Statement): void => {
      switch (s.kind) {
        case "VariableDeclaration":
          if (s.initializer) visitExpr(s.initializer);
          break;
        case "AssignmentStatement":
          visitExpr(s.value);
          break;
        case "ExpressionStatement":
          visitExpr(s.expression);
          break;
        case "ReturnStatement":
          if (s.value) visitExpr(s.value);
          break;
        case "IfStatement":
          visitExpr(s.condition);
          for (const st of s.consequent) visitStmt(st);
          if (Array.isArray(s.alternate))
            for (const st of s.alternate) visitStmt(st);
          else if (s.alternate) visitStmt(s.alternate);
          break;
        case "WhileStatement":
          visitExpr(s.condition);
          for (const st of s.body) visitStmt(st);
          break;
        case "ForStatement":
          if (s.initializer) visitStmt(s.initializer);
          if (s.condition) visitExpr(s.condition);
          for (const st of s.body) visitStmt(st);
          break;
        case "ForInStatement":
          visitExpr(s.iterable);
          for (const st of s.body) visitStmt(st);
          break;
        case "SwitchStatement":
          visitExpr(s.discriminant);
          for (const switchCase of s.cases) {
            if (switchCase.test) {
              visitExpr(switchCase.test);
            }
            for (const st of switchCase.body) visitStmt(st);
          }
          break;
        default:
          break;
      }
    };
    for (const s of stmts) visitStmt(s);
    return names;
  }

  private emitNamedFunctionRef(
    sig: FunctionSig,
    lines: string[],
  ): EmittedValue {
    this.needsSnAlloc = true;
    this.needsCallableRuntime = true;
    const trampoline = this.ensureTrampoline(sig);
    return this.emitCallableValue(
      `@${trampoline}`,
      "null",
      {
        kind: "function",
        params: sig.params,
        returnType: sig.returnType,
      },
      lines,
    );
  }

  private ensureTrampoline(sig: FunctionSig): string {
    const name = `${sig.mangledName}__as_closure`;
    if (this.emittedTrampolines.has(name)) {
      return name;
    }
    this.emittedTrampolines.add(name);
    const ret = sig.returnType === "void" ? "void" : toLlvmType(sig.returnType);
    const params = [
      "ptr %env",
      ...sig.params.map((t, i) => `${toLlvmType(t)} %arg${i}`),
    ].join(", ");
    const lines: string[] = [];
    lines.push(`define ${ret} @${name}(${params}) {`);
    lines.push("entry:");
    const argList = sig.params
      .map((t, i) => `${toLlvmType(t)} %arg${i}`)
      .join(", ");
    if (sig.returnType === "void") {
      lines.push(`  call void @${sig.mangledName}(${argList})`);
      lines.push("  ret void");
    } else {
      const tmp = "%ret";
      const retTy = toLlvmType(sig.returnType);
      lines.push(`  ${tmp} = call ${retTy} @${sig.mangledName}(${argList})`);
      lines.push(`  ret ${retTy} ${tmp}`);
    }
    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
    return name;
  }

  private emitCallableValue(
    codePtr: string,
    envPtr: string,
    type: FunctionValueType,
    lines: string[],
  ): EmittedValue {
    this.needsSnAlloc = true;
    this.needsCallableRuntime = true;
    const alloca = this.nextTemp();
    lines.push(`  ${alloca} = alloca %__Callable`);
    const codeSlot = this.nextTemp();
    lines.push(
      `  ${codeSlot} = getelementptr inbounds %__Callable, ptr ${alloca}, i32 0, i32 0`,
    );
    lines.push(`  store ptr ${codePtr}, ptr ${codeSlot}`);
    const envSlot = this.nextTemp();
    lines.push(
      `  ${envSlot} = getelementptr inbounds %__Callable, ptr ${alloca}, i32 0, i32 1`,
    );
    lines.push(`  store ptr ${envPtr}, ptr ${envSlot}`);
    const loaded = this.nextTemp();
    lines.push(`  ${loaded} = load %__Callable, ptr ${alloca}`);
    return { llvm: loaded, type };
  }

  private emitIndirectCall(
    callee: EmittedValue,
    fnType: FunctionValueType,
    args: Expression[],
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    this.needsSnAlloc = true;
    this.needsCallableRuntime = true;
    const tmpAlloca = this.nextTemp();
    lines.push(`  ${tmpAlloca} = alloca %__Callable`);
    lines.push(`  store %__Callable ${callee.llvm}, ptr ${tmpAlloca}`);
    const codeSlot = this.nextTemp();
    lines.push(
      `  ${codeSlot} = getelementptr inbounds %__Callable, ptr ${tmpAlloca}, i32 0, i32 0`,
    );
    const code = this.nextTemp();
    lines.push(`  ${code} = load ptr, ptr ${codeSlot}`);
    const envSlot = this.nextTemp();
    lines.push(
      `  ${envSlot} = getelementptr inbounds %__Callable, ptr ${tmpAlloca}, i32 0, i32 1`,
    );
    const env = this.nextTemp();
    lines.push(`  ${env} = load ptr, ptr ${envSlot}`);

    const emittedArgs: EmittedValue[] = [];
    for (let i = 0; i < args.length; i += 1) {
      emittedArgs.push(
        this.emitExpression(args[i]!, lines, fnType.params[i] as ValueType),
      );
    }
    const argList = [
      `ptr ${env}`,
      ...emittedArgs.map((a) => `${toLlvmType(a.type)} ${a.llvm}`),
    ].join(", ");

    if (fnType.returnType === "void") {
      lines.push(`  call void ${code}(${argList})`);
      if (!asStatement) {
        throw new Error("Codegen: void indirect call used as value");
      }
      return { llvm: "void", type: "i32" };
    }
    const retTy = toLlvmType(fnType.returnType as ValueType);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = call ${retTy} ${code}(${argList})`);
    return { llvm: tmp, type: fnType.returnType as ValueType };
  }

  private emitLambdaExpression(
    expr: LambdaExpression,
    lines: string[],
    expected?: ValueType,
  ): EmittedValue {
    this.needsSnAlloc = true;
    this.needsCallableRuntime = true;
    const fnType = this.inferExpressionType(
      expr,
      expected,
    ) as FunctionValueType;
    const capRecords = this.lambdaCaptures.get(expr.span.start.offset) ?? [];
    const captures: LambdaCaptureLowering[] = capRecords.map((c) => {
      const local = this.locals.get(c.name);
      const fromLayout = this.currentLambdaCaptureLayout.find(
        (x) => x.name === c.name,
      );
      const type = local?.type ?? fromLayout?.type;
      if (!type) {
        throw new Error(`Codegen: missing capture type for '${c.name}'`);
      }
      return { name: c.name, mutable: c.mutable, type };
    });
    const mangled = this.ensureLambdaFunction(expr, fnType, captures);

    let envPtr = "null";
    if (captures.length > 0) {
      const envTypeName = this.envTypeName(expr.span.start.offset, captures);
      const envTypeId = this.ensureEnvTypeInfo(envTypeName, captures);
      envPtr = this.nextTemp();
      this.needsGc = true;
      lines.push(
        `  ${envPtr} = call ptr @sn_alloc(i64 noundef ${llvmSizeofExpr(`%${envTypeName}`)})`,
      );
      this.rootHeapPtr(envPtr, lines);
      lines.push(
        `  call void @sn_gc_set_type(ptr noundef ${envPtr}, i32 noundef ${envTypeId})`,
      );
      for (let i = 0; i < captures.length; i += 1) {
        const cap = captures[i]!;
        const fieldPtr = this.nextTemp();
        lines.push(
          `  ${fieldPtr} = getelementptr inbounds %${envTypeName}, ptr ${envPtr}, i32 0, i32 ${i}`,
        );
        if (cap.mutable) {
          const local = this.locals.get(cap.name);
          if (local?.boxed) {
            const box = this.nextTemp();
            lines.push(`  ${box} = load ptr, ptr ${local.ptr}`);
            lines.push(`  store ptr ${box}, ptr ${fieldPtr}`);
          } else if (local) {
            lines.push(`  store ptr ${local.ptr}, ptr ${fieldPtr}`);
          } else {
            const outer = this.loadCaptureFromCurrentEnv(cap.name, lines);
            lines.push(`  store ptr ${outer}, ptr ${fieldPtr}`);
          }
        } else {
          const value = this.loadCaptureValue(cap.name, cap.type, lines);
          lines.push(
            `  store ${toLlvmType(cap.type)} ${value}, ptr ${fieldPtr}`,
          );
        }
      }
    }

    return this.emitCallableValue(`@${mangled}`, envPtr, fnType, lines);
  }

  private loadCaptureValue(
    name: string,
    type: ValueType,
    lines: string[],
  ): string {
    const local = this.locals.get(name);
    if (local) {
      const ptr = this.storagePtr(local, lines);
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = load ${toLlvmType(type)}, ptr ${ptr}`);
      return tmp;
    }
    const idx = this.currentLambdaCaptureLayout.findIndex(
      (c) => c.name === name,
    );
    if (idx < 0 || !this.currentLambdaEnv || !this.currentLambdaEnvTypeName) {
      throw new Error(`Codegen: cannot load capture '${name}'`);
    }
    const fieldPtr = this.nextTemp();
    lines.push(
      `  ${fieldPtr} = getelementptr inbounds %${this.currentLambdaEnvTypeName}, ptr ${this.currentLambdaEnv}, i32 0, i32 ${idx}`,
    );
    const tmp = this.nextTemp();
    const llvmTy = this.currentLambdaCaptureLayout[idx]!.mutable
      ? "ptr"
      : toLlvmType(type);
    lines.push(`  ${tmp} = load ${llvmTy}, ptr ${fieldPtr}`);
    if (this.currentLambdaCaptureLayout[idx]!.mutable) {
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${toLlvmType(type)}, ptr ${tmp}`);
      return val;
    }
    return tmp;
  }

  private loadCaptureFromCurrentEnv(name: string, lines: string[]): string {
    const idx = this.currentLambdaCaptureLayout.findIndex(
      (c) => c.name === name,
    );
    if (idx < 0 || !this.currentLambdaEnv || !this.currentLambdaEnvTypeName) {
      throw new Error(`Codegen: capture '${name}' not in current env`);
    }
    const fieldPtr = this.nextTemp();
    lines.push(
      `  ${fieldPtr} = getelementptr inbounds %${this.currentLambdaEnvTypeName}, ptr ${this.currentLambdaEnv}, i32 0, i32 ${idx}`,
    );
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = load ptr, ptr ${fieldPtr}`);
    return tmp;
  }

  private envTypeName(
    offset: number,
    captures: LambdaCaptureLowering[],
  ): string {
    const name =
      `__env_${captures.map((c) => `${c.name}_${c.mutable ? "m" : "c"}`).join("__") || "empty"}` +
      `_${offset}`;
    if (!this.globalDefs.some((l) => l.startsWith(`%${name} =`))) {
      const fields = captures
        .map((c) => (c.mutable ? "ptr" : toLlvmType(c.type)))
        .join(", ");
      this.globalDefs.push(`%${name} = type { ${fields || "i8"} }`);
    }
    return name;
  }

  private ensureLambdaFunction(
    expr: LambdaExpression,
    fnType: FunctionValueType,
    captures: LambdaCaptureLowering[],
  ): string {
    const offset = expr.span.start.offset;
    const mangled =
      (this.currentModuleId ? `${this.currentModuleId}__` : "") +
      `lambda_${offset}`;
    if (this.emittedLambdas.has(offset)) {
      return mangled;
    }
    this.emittedLambdas.add(offset);
    return this.emitLambdaFunctionBody(expr, fnType, mangled, captures);
  }

  private emitLambdaFunctionBody(
    expr: LambdaExpression,
    fnType: FunctionValueType,
    mangled: string,
    layout: LambdaCaptureLowering[],
  ): string {
    const envName =
      layout.length > 0 ? this.envTypeName(expr.span.start.offset, layout) : "";

    const savedLocals = this.locals;
    const savedTemp = this.tempCounter;
    const savedReturn = this.currentReturnType;
    const savedEnv = this.currentLambdaEnv;
    const savedEnvType = this.currentLambdaEnvTypeName;
    const savedLayout = this.currentLambdaCaptureLayout;
    const savedBoxed = this.boxedNames;
    const gcScope = this.beginGcFunctionScope();

    this.locals = new Map();
    this.tempCounter = 0;
    this.currentReturnType =
      fnType.returnType === "void" ? "void" : (fnType.returnType as ValueType);
    this.currentLambdaEnv = "%env";
    this.currentLambdaEnvTypeName = envName || null;
    this.currentLambdaCaptureLayout = layout;
    this.boxedNames = this.collectBoxedNamesInStmts(
      expr.body.kind === "block" ? expr.body.statements : [],
    );

    const ret =
      fnType.returnType === "void"
        ? "void"
        : toLlvmType(fnType.returnType as ValueType);
    const params = [
      "ptr %env",
      ...fnType.params.map((t, i) => `${toLlvmType(t as ValueType)} %arg${i}`),
    ].join(", ");
    const lines: string[] = [];
    lines.push(`define ${ret} @${mangled}(${params}) {`);
    lines.push("entry:");

    if (layout.length > 0) {
      const envHolder = "%v.env";
      lines.push(`  ${envHolder} = alloca ptr`);
      lines.push(`  store ptr %env, ptr ${envHolder}`);
      this.pushGcRoot(envHolder, lines);
    }

    for (let i = 0; i < layout.length; i += 1) {
      const cap = layout[i]!;
      const fieldPtr = this.nextTemp();
      lines.push(
        `  ${fieldPtr} = getelementptr inbounds %${envName}, ptr %env, i32 0, i32 ${i}`,
      );
      if (cap.mutable) {
        const boxHolder = `%v.${cap.name}`;
        lines.push(`  ${boxHolder} = alloca ptr`);
        const box = this.nextTemp();
        lines.push(`  ${box} = load ptr, ptr ${fieldPtr}`);
        lines.push(`  store ptr ${box}, ptr ${boxHolder}`);
        this.locals.set(cap.name, {
          ptr: boxHolder,
          type: cap.type,
          boxed: true,
        });
        this.pushGcRoot(boxHolder, lines);
      } else {
        const llvmTy = toLlvmType(cap.type);
        const ptr = `%v.${cap.name}`;
        lines.push(`  ${ptr} = alloca ${llvmTy}`);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${llvmTy}, ptr ${fieldPtr}`);
        lines.push(`  store ${llvmTy} ${val}, ptr ${ptr}`);
        this.locals.set(cap.name, { ptr, type: cap.type, boxed: false });
        this.registerRootsForStorage(ptr, cap.type, lines);
      }
    }

    for (let i = 0; i < expr.params.length; i += 1) {
      const p = expr.params[i]!;
      const type = fnType.params[i]! as ValueType;
      const llvmType = toLlvmType(type);
      const ptr = `%v.${p.name.name}`;
      lines.push(`  ${ptr} = alloca ${llvmType}`);
      lines.push(`  store ${llvmType} %arg${i}, ptr ${ptr}`);
      this.locals.set(p.name.name, { ptr, type, boxed: false });
      this.registerRootsForStorage(ptr, type, lines);
    }

    let terminated = false;
    if (expr.body.kind === "expression") {
      const expectedRet =
        fnType.returnType !== "void"
          ? (fnType.returnType as ValueType)
          : undefined;
      const value = this.emitExpression(
        expr.body.expression,
        lines,
        expectedRet,
      );
      if (fnType.returnType === "void") {
        this.emitFunctionRet(lines, "  ret void");
      } else {
        this.emitFunctionRet(
          lines,
          `  ret ${toLlvmType(value.type)} ${value.llvm}`,
        );
      }
      terminated = true;
    } else {
      for (const stmt of expr.body.statements) {
        if (terminated) break;
        terminated = this.emitStatement(stmt, lines);
      }
      if (!terminated) {
        if (fnType.returnType === "void") {
          this.emitFunctionRet(lines, "  ret void");
        } else {
          throw new Error("Codegen: lambda missing return");
        }
      }
    }

    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);

    this.locals = savedLocals;
    this.tempCounter = savedTemp;
    this.currentReturnType = savedReturn;
    this.currentLambdaEnv = savedEnv;
    this.currentLambdaEnvTypeName = savedEnvType;
    this.currentLambdaCaptureLayout = savedLayout;
    this.boxedNames = savedBoxed;
    this.endGcFunctionScope(gcScope);
    return mangled;
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
    return this.emitCallWithEmittedArgs(sig, emittedArgs, lines, asStatement);
  }

  private emitCallWithEmittedArgs(
    sig: FunctionSig,
    emittedArgs: EmittedValue[],
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    // Well-known array runtime helpers: inject elem_size / cmp_kind.
    if (sig.mangledName === "sn_array_push" && emittedArgs.length >= 2) {
      const arr = emittedArgs[0]!;
      const value = emittedArgs[1]!;
      if (!isArrayType(arr.type)) {
        throw new Error("Codegen: sn_array_push expects array receiver");
      }
      this.emitArrayPush(arr.llvm, value, arr.type.element, lines);
      if (!asStatement) {
        throw new Error("Codegen: sn_array_push used as value");
      }
      return { llvm: "void", type: "i32" };
    }
    if (sig.mangledName === "sn_array_pop" && emittedArgs.length >= 1) {
      const arr = emittedArgs[0]!;
      if (!isArrayType(arr.type)) {
        throw new Error("Codegen: sn_array_pop expects array receiver");
      }
      return this.emitArrayPop(arr.llvm, arr.type.element, lines);
    }
    if (sig.mangledName === "sn_array_index_of" && emittedArgs.length >= 2) {
      const arr = emittedArgs[0]!;
      const needle = emittedArgs[1]!;
      if (!isArrayType(arr.type)) {
        throw new Error("Codegen: sn_array_index_of expects array receiver");
      }
      return this.emitArrayIndexOf(arr.llvm, needle, arr.type.element, lines);
    }

    if (sig.isExtern) {
      this.noteExternUse(sig);
    }

    const argList = emittedArgs
      .map((a) => `${toLlvmType(a.type)} ${a.llvm}`)
      .join(", ");
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

  private noteExternUse(sig: FunctionSig): void {
    this.externDeclares.add(sig.mangledName);
    if (
      sig.mangledName.startsWith("sn_str_") &&
      sig.mangledName !== "sn_str_len" &&
      sig.mangledName !== "sn_str_concat"
    ) {
      this.needsSnStrExtras = true;
    }
    if (
      sig.mangledName === "sn_array_push" ||
      sig.mangledName === "sn_array_pop" ||
      sig.mangledName === "sn_array_index_of" ||
      sig.mangledName === "sn_array_new" ||
      sig.mangledName === "sn_array_length"
    ) {
      this.needsSnArray = true;
    }
    if (
      sig.mangledName === "sn_str_len" ||
      sig.mangledName === "sn_str_concat"
    ) {
      this.needsSnString = true;
    }
  }

  private emitPrintCall(call: CallExpression, lines: string[]): void {
    this.needsSnPrint = true;
    const args = asExpressions(call.args);
    for (let i = 0; i < args.length; i += 1) {
      const value = this.emitExpression(args[i]!, lines);
      this.emitPrintValue(value, lines);
      if (i < args.length - 1) {
        lines.push("  call void @sn_print_space()");
      }
    }
    lines.push("  call void @sn_print_newline()");
  }

  private isConsoleBuiltin(call: CallExpression): boolean {
    if (call.callee.kind !== "MemberExpression") {
      return false;
    }
    const obj = call.callee.object;
    if (obj.kind !== "Identifier" || obj.name !== "console") {
      return false;
    }
    const prop = call.callee.property.name;
    return (
      prop === "log" ||
      prop === "error" ||
      prop === "warn" ||
      prop === "readLine"
    );
  }

  private emitConsoleCall(call: CallExpression, lines: string[]): void {
    if (call.callee.kind !== "MemberExpression") {
      return;
    }
    const prop = call.callee.property.name;
    if (prop === "readLine") {
      this.needsSnPrint = true;
      this.needsGc = true;
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = call ptr @sn_read_line()`);
      this.rootHeapPtr(tmp, lines);
      // Statement form discards the result; value form handled in emitExpression.
      return;
    }
    const toStderr = prop === "error";
    this.needsSnPrint = true;
    const args = asExpressions(call.args);
    for (let i = 0; i < args.length; i += 1) {
      const value = this.emitExpression(args[i]!, lines);
      this.emitPrintValue(value, lines, toStderr);
      if (i < args.length - 1) {
        lines.push(
          toStderr
            ? "  call void @sn_eprint_space()"
            : "  call void @sn_print_space()",
        );
      }
    }
    lines.push(
      toStderr
        ? "  call void @sn_eprint_newline()"
        : "  call void @sn_print_newline()",
    );
  }

  private emitPrintValue(
    value: EmittedValue,
    lines: string[],
    toStderr = false,
  ): void {
    const p = (name: string) => (toStderr ? `sn_eprint_${name}` : `sn_print_${name}`);
    if (isArrayType(value.type)) {
      this.needsSnFormat = true;
      const elemLlvm = toLlvmType(value.type.element);
      const fmtKind = this.snFmtKindForType(value.type.element);
      const arrayStr = this.nextTemp();
      lines.push(
        `  ${arrayStr} = call ptr @sn_array_to_string(ptr noundef ${value.llvm}, i64 noundef ${llvmSizeofExpr(elemLlvm)}, i32 noundef ${fmtKind})`,
      );
      lines.push(`  call void @${p("str")}(ptr noundef ${arrayStr})`);
      return;
    }
    if (value.type === "bool") {
      lines.push(`  call void @${p("bool")}(i1 ${value.llvm})`);
      return;
    }
    if (value.type === "string") {
      lines.push(`  call void @${p("str")}(ptr noundef ${value.llvm})`);
      return;
    }
    if (value.type === "i32" || isEnumType(value.type)) {
      lines.push(`  call void @${p("i32")}(i32 ${value.llvm})`);
      return;
    }
    if (value.type === "i64") {
      lines.push(`  call void @${p("i64")}(i64 ${value.llvm})`);
      return;
    }
    if (value.type === "f32") {
      lines.push(`  call void @${p("f32")}(float ${value.llvm})`);
      return;
    }
    if (value.type === "f64") {
      lines.push(`  call void @${p("f64")}(double ${value.llvm})`);
      return;
    }
    if (value.type === "char") {
      lines.push(`  call void @${p("char")}(i8 ${value.llvm})`);
      return;
    }
    if (isLiteralType(value.type)) {
      if (value.type.literalKind === "string") {
        lines.push(`  call void @${p("str")}(ptr noundef ${value.llvm})`);
        return;
      }
      lines.push(`  call void @${p("i32")}(i32 ${value.llvm})`);
      return;
    }
    throw new Error(
      `Codegen: cannot print type '${typeof value.type === "object" ? value.type.kind : value.type}'`,
    );
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

/**
 * Byte size of an LLVM type as a constant expression resolved by the target
 * data layout (GEP-null sizeof), rather than a hardcoded TS integer.
 */
function llvmSizeofExpr(llvmType: string): string {
  return `ptrtoint (ptr getelementptr (${llvmType}, ptr null, i32 1) to i64)`;
}

/** `sizeof` truncated to i32 for TypeInfo constants. */
function llvmSizeofI32Expr(llvmType: string): string {
  return `trunc (i64 ${llvmSizeofExpr(llvmType)} to i32)`;
}

/** `offsetof` via GEP-null, truncated to i32 for TypeInfo field offsets. */
function llvmOffsetOfExpr(
  aggregateTy: string,
  indices: readonly number[],
): string {
  const idxList = ["i32 0", ...indices.map((i) => `i32 ${i}`)].join(", ");
  return `trunc (i64 ptrtoint (ptr getelementptr inbounds (${aggregateTy}, ptr null, ${idxList}) to i64) to i32)`;
}

interface TypeInfoFieldConst {
  readonly offsetExpr: string;
  readonly sizeExpr: string;
  readonly refClass: number;
  readonly typeId: number;
}

/**
 * LLVM ABI type for a semantic ValueType (aligned with TypeCategory):
 * - Value (primitives, enum, struct, tuple) → first-class scalar/aggregate (copied)
 * - Reference (class, array, map, string) → bare `ptr` (shared identity)
 * - Reference (function) → `%__Callable` handle (shallow copy of fn+env ptrs)
 * - Struct fields use this per-field, so value structs may embed reference ptrs
 */
function toLlvmType(type: ValueType | "void"): string {
  if (type === "void") {
    return "void";
  }
  if (typeof type === "object") {
    if (
      type.kind === "struct" ||
      type.kind === "interface" ||
      type.kind === "object"
    ) {
      return `%${type.name}`;
    }
    if (type.kind === "tuple") {
      return `%${tupleTypeName(type.elements)}`;
    }
    if (type.kind === "enum") {
      return "i32";
    }
    if (type.kind === "union") {
      if (isNullablePointerUnion(type)) {
        return "ptr";
      }
      if (
        type.arms.every((a) => isLiteralType(a) && a.literalKind === "string")
      ) {
        return "ptr";
      }
      if (
        type.arms.every((a) => isLiteralType(a) && a.literalKind === "number")
      ) {
        return "i32";
      }
      return "%__Union";
    }
    if (type.kind === "literal") {
      return type.literalKind === "string" ? "ptr" : "i32";
    }
    if (type.kind === "map") {
      return "ptr";
    }
    if (type.kind === "function") {
      return "%__Callable";
    }
    if (type.kind === "intersection") {
      for (const arm of type.arms) {
        if (
          typeof arm === "object" &&
          (arm.kind === "object" || arm.kind === "struct")
        ) {
          return toLlvmType(arm as ValueType);
        }
      }
      return "ptr";
    }
    // class and array: reference → ptr
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
    case "null":
      return "ptr";
  }
}

function tupleTypeName(elements: readonly ValueType[]): string {
  const mangled = elements
    .map((el) => mangleTypeAnnotation(valueTypeToAnnotation(el as never)))
    .join("__");
  const name = `__tuple_${mangled || "empty"}`;
  activeTupleRegistry?.set(name, elements);
  return name;
}

function zeroInitializer(type: ValueType): string {
  if (typeof type === "object") {
    if (type.kind === "enum") {
      return "0";
    }
    if (type.kind === "union") {
      if (isNullablePointerUnion(type)) {
        return "null";
      }
      return "zeroinitializer";
    }
    if (
      type.kind === "struct" ||
      type.kind === "interface" ||
      type.kind === "object"
    ) {
      return "zeroinitializer";
    }
    if (type.kind === "tuple") {
      return "zeroinitializer";
    }
    if (type.kind === "literal") {
      return type.literalKind === "string" ? "null" : "0";
    }
    if (type.kind === "function") {
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
      return "0.0";
    case "f64":
      return "0.0";
    case "bool":
      return "false";
    case "string":
    case "null":
      return "null";
  }
}

function itableGlobalName(classMangled: string, ifaceMangled: string): string {
  return `${classMangled}__${ifaceMangled}__itable`;
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

function formatFloat(value: number, _type: ValueType): string {
  if (Number.isInteger(value)) {
    return `${value}.0`;
  }
  return String(value);
}

function isConstantModuleInit(expr: Expression): boolean {
  switch (expr.kind) {
    case "IntegerLiteral":
    case "FloatLiteral":
    case "BooleanLiteral":
    case "CharLiteral":
    case "NullLiteral":
    case "StringLiteral":
      return true;
    default:
      return false;
  }
}

function inferLiteralModuleType(expr: Expression): ValueType | null {
  switch (expr.kind) {
    case "IntegerLiteral":
      return "i32";
    case "FloatLiteral":
      return "f64";
    case "BooleanLiteral":
      return "bool";
    case "CharLiteral":
      return "char";
    case "NullLiteral":
      return "null";
    case "StringLiteral":
      return "string";
    default:
      return null;
  }
}

function constantLlvmValue(expr: Expression, type: ValueType): string {
  switch (expr.kind) {
    case "IntegerLiteral":
      return String(expr.value);
    case "FloatLiteral":
      return formatFloat(expr.value, type);
    case "BooleanLiteral":
      return expr.value ? "true" : "false";
    case "CharLiteral":
      return String(expr.value.codePointAt(0) ?? 0);
    case "NullLiteral":
      return "null";
    default:
      return zeroInitializer(type);
  }
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
