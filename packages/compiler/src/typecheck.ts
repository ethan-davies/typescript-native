import type {
  CallArgument,
  ClassDeclaration,
  ClassMethod,
  ConstructorDeclaration,
  EnumDeclaration,
  Expression,
  FunctionDeclaration,
  InterfaceDeclaration,
  ModuleVariableDeclaration,
  Parameter,
  PrimitiveTypeName,
  Program,
  Statement,
  StructDeclaration,
  StructMethod,
  TypeAliasDeclaration,
  TypeAnnotation,
  TypeParameter,
  Visibility,
} from "./ast/nodes.js";
import type { SourceSpan } from "./diagnostics/diagnostic.js";
import { DiagnosticCollector } from "./diagnostics/diagnostic.js";
import {
  SemanticCollector,
  emptySemanticModel,
  type SemanticModel,
  type ScopeBindingInfo,
} from "./analysis/semantic.js";
import {
  InstantiationCollector,
  checkTypeArgArity,
  mangleFunctionInstance,
  mangleInstance,
  validateTypeParamList,
  valueTypeToAnnotation,
  type GenericClassTemplate,
  type GenericFunctionTemplate,
  type GenericInterfaceTemplate,
  type GenericStructTemplate,
} from "./generics/registry.js";
import {
  buildSubst,
  specializeStructDecl,
  substituteAnnotation,
  substituteExpression,
} from "./generics/substitute.js";
import type { TypecheckInstantiations } from "./generics/monomorphize.js";
import { mangleSymbol } from "./modules/mangle.js";
import {
  buildExportTables,
  hasPrivateDeclarationInAst,
  type ExportTable,
} from "./modules/exports.js";
import type { ModuleImportBinding, ResolvedModule } from "./modules/resolve.js";
import {
  BUILTIN_ERROR_LOCAL_NAME,
  BUILTIN_ERROR_MANGLED,
  createBuiltinErrorClassDef,
} from "./builtins/error.js";
import {
  advancedIsAssignable,
  advancedTypeToString,
  advancedTypesEqual,
  applyNarrowingFacts,
  expandMappedType,
  extractFalseNarrowingFacts,
  extractNarrowingFacts,
  flattenUnion,
  includesNull,
  indexedAccess,
  isIntersectionType,
  isLiteralType,
  isMapType,
  isFunctionType,
  isObjectType,
  isUnionType,
  keyofType,
  literalBaseType,
  makeIntersection,
  makeUnion,
  mutateScopeWithFacts,
  stripNull,
  objectShapeName,
  typeofTagForType,
  type ExtendedValueType,
  type FunctionValueType,
  type IntersectionValueType,
  type LiteralValueType,
  type MapValueType,
  type ObjectValueType,
  type TypeAliasDef,
  type TypeAnnResolver,
  type UnionValueType,
} from "./typecheck-advanced.js";

export type PrimitiveValueType = Exclude<PrimitiveTypeName, "void">;

export interface ArrayValueType {
  readonly kind: "array";
  readonly element: ValueType;
}

export interface TupleValueType {
  readonly kind: "tuple";
  readonly elements: readonly ValueType[];
}

export interface StructValueType {
  readonly kind: "struct";
  readonly name: string;
}

export interface ClassValueType {
  readonly kind: "class";
  readonly name: string;
}

export interface InterfaceValueType {
  readonly kind: "interface";
  readonly name: string;
}

export interface EnumValueType {
  readonly kind: "enum";
  readonly name: string;
}

/** Unbound type parameter while checking a generic template body. */
export interface TypeParamValueType {
  readonly kind: "typeParam";
  readonly name: string;
  /** Constraint interface/class mangled name when `extends` is present. */
  readonly constraintName: string | null;
  readonly constraintKind: "interface" | "class" | null;
  /** Intersection constraint arms for multi-constraint method lookup. */
  readonly constraintArms: readonly {
    readonly kind: "interface" | "class";
    readonly name: string;
  }[];
}

export type ValueType =
  | PrimitiveValueType
  | ArrayValueType
  | TupleValueType
  | StructValueType
  | ClassValueType
  | InterfaceValueType
  | EnumValueType
  | TypeParamValueType
  | UnionValueType
  | IntersectionValueType
  | ObjectValueType
  | LiteralValueType
  | MapValueType
  | FunctionValueType;

export type {
  FunctionValueType,
  IntersectionValueType,
  LiteralValueType,
  MapValueType,
  ObjectValueType,
  UnionValueType,
};

export type ReturnType = ValueType | "void";

export interface StructFieldDef {
  readonly name: string;
  readonly type: ValueType;
}

export interface StructMethodDef {
  readonly name: string;
  readonly mangledName: string;
  readonly params: ValueType[];
  readonly returnType: ReturnType;
  readonly decl: StructMethod;
}

export interface StructDef {
  readonly name: string;
  readonly fields: StructFieldDef[];
  readonly methods: StructMethodDef[];
  readonly decl: StructDeclaration;
  readonly exported: boolean;
}

export interface ClassFieldDef {
  readonly name: string;
  readonly type: ValueType;
  readonly visibility: Visibility;
  readonly isReadonly: boolean;
  readonly isStatic: boolean;
  /** Mangled name of the class that declared this field. */
  readonly declaringClass: string;
  /** LLVM field index in the instance object (0 = ObjectHeader); -1 for static. */
  readonly fieldIndex: number;
  readonly initializer: Expression | null;
}

export interface ClassMethodDef {
  readonly name: string;
  readonly mangledName: string;
  readonly params: ValueType[];
  readonly returnType: ReturnType;
  readonly visibility: Visibility;
  readonly isStatic: boolean;
  readonly isAbstract: boolean;
  /** Vtable slot for instance methods; -1 for static. */
  readonly vtableSlot: number;
  /** Mangled name of the class that provides this implementation (may be ancestor). */
  readonly implementingClass: string;
  readonly decl: ClassMethod | null;
}

export interface InterfaceMethodDef {
  readonly name: string;
  readonly params: ValueType[];
  readonly returnType: ReturnType;
  /** Slot index in this interface's itable. */
  readonly itableSlot: number;
}

export interface InterfaceDef {
  readonly name: string;
  readonly localName: string;
  /** Direct base interfaces. */
  readonly bases: InterfaceDef[];
  /**
   * Flattened methods in itable order (base methods first, then own).
   * Prefix-compatible with each base at `baseItableOffsets`.
   */
  readonly methods: InterfaceMethodDef[];
  /** Mangled interface name → starting slot offset within this itable. */
  readonly baseItableOffsets: ReadonlyMap<string, number>;
  /** Index signature value type when `[key: string]: T` is present. */
  readonly indexType: ValueType | null;
  readonly decl: InterfaceDeclaration;
  readonly exported: boolean;
}

export interface ClassDef {
  readonly name: string;
  readonly localName: string;
  readonly isAbstract: boolean;
  readonly superclass: ClassDef | null;
  /** Interfaces directly listed in `implements` (not transitive). */
  readonly implementedInterfaces: InterfaceDef[];
  /** Instance fields in layout order (after ObjectHeader slot). */
  readonly instanceFields: ClassFieldDef[];
  readonly staticFields: ClassFieldDef[];
  /** Instance methods in vtable order. */
  readonly instanceMethods: ClassMethodDef[];
  readonly staticMethods: ClassMethodDef[];
  readonly constructorParams: ValueType[];
  readonly constructorDecl: ConstructorDeclaration | null;
  readonly constructorMangledName: string;
  readonly vtableGlobalName: string;
  readonly decl: ClassDeclaration;
  readonly exported: boolean;
}

export interface EnumDef {
  readonly name: string;
  readonly variants: ReadonlyMap<string, number>;
  readonly decl: EnumDeclaration;
  readonly exported: boolean;
}

interface Binding {
  readonly type: ValueType;
  readonly mutable: boolean;
  /** For const bindings initialized with a compile-time constant expression */
  readonly constantExpr?: Expression;
  readonly defSpan?: SourceSpan;
  readonly defFile?: string;
  /** How this binding was introduced (for completion icons). */
  readonly bindingKind?: "parameter" | "let" | "const";
}

interface FunctionSig {
  readonly name: string;
  readonly mangledName: string;
  readonly params: ValueType[];
  readonly returnType: ReturnType;
  readonly decl: FunctionDeclaration;
  readonly exported: boolean;
  readonly isExtern: boolean;
  readonly isExtension: boolean;
  readonly modulePath: string;
}

export interface ModuleValueDef {
  readonly name: string;
  readonly type: ValueType;
  readonly mutability: "let" | "const";
  readonly exported: boolean;
  readonly mangledName: string;
  readonly modulePath: string;
  readonly span: SourceSpan;
  readonly decl: ModuleVariableDeclaration;
}

export interface ModuleNamespace {
  readonly moduleId: string;
  readonly functions: ReadonlyMap<string, FunctionSig>;
  readonly structs: ReadonlyMap<string, StructDef>;
  readonly enums: ReadonlyMap<string, EnumDef>;
  readonly classes: ReadonlyMap<string, ClassDef>;
  readonly interfaces: ReadonlyMap<string, InterfaceDef>;
  readonly typeAliases: ReadonlyMap<string, TypeAliasDef>;
  readonly values: ReadonlyMap<string, ModuleValueDef>;
}

interface ModuleSymbols {
  readonly moduleId: string;
  readonly modulePath: string;
  readonly functions: Map<string, FunctionSig>;
  readonly structs: Map<string, StructDef>;
  readonly enums: Map<string, EnumDef>;
  readonly classes: Map<string, ClassDef>;
  readonly interfaces: Map<string, InterfaceDef>;
  readonly typeAliases: Map<string, TypeAliasDef>;
  readonly values: Map<string, ModuleValueDef>;
  readonly genericStructs: Map<string, GenericStructTemplate>;
  readonly genericClasses: Map<string, GenericClassTemplate>;
  readonly genericInterfaces: Map<string, GenericInterfaceTemplate>;
  readonly genericFunctions: Map<string, GenericFunctionTemplate>;
  readonly genericTypeAliases: Map<string, TypeAliasDeclaration>;
}

interface MemberContext {
  readonly thisType: ValueType;
  readonly enclosingClass: ClassDef | null;
  readonly enclosingStruct: StructDef | null;
  readonly isConstructor: boolean;
  readonly isStatic: boolean;
}

const NUMERIC_PRIMITIVES = new Set<PrimitiveValueType>([
  "i32",
  "i64",
  "f32",
  "f64",
]);
const EQUALITY_PRIMITIVES = new Set<PrimitiveValueType>([
  "i32",
  "i64",
  "f32",
  "f64",
  "bool",
  "char",
  "string",
  "null",
]);

/** Active extension methods available while type-checking a module (concrete + generic). */
let activeExtensions: ExtensionEntry[] = [];

interface ExtensionEntry {
  readonly name: string;
  readonly kind: "concrete" | "generic";
  readonly sig: FunctionSig | null;
  readonly template: GenericFunctionTemplate | null;
}

/** Active import namespaces while type-checking a module. */
let activeNamespaces: Map<string, ModuleNamespace> = new Map();
/** Active class defs for the module under check (local name → def). */
let activeClasses: Map<string, ClassDef> = new Map();
/** Active interface defs for the module under check (local name → def). */
let activeInterfaces: Map<string, InterfaceDef> = new Map();
/** Active type aliases for the module under check. */
let activeTypeAliases: Map<string, TypeAliasDef> = new Map();
/** Generic type alias templates. */
let activeGenericTypeAliases: Map<string, TypeAliasDeclaration> = new Map();
/** Synthetic object structs registered during resolution. */
let syntheticObjectStructs: Map<string, StructDef> = new Map();
/** Alias expansion stack for cycle detection. */
let aliasExpandStack: string[] = [];
/** Active function sigs for typeof type queries. */
let activeFunctions: Map<string, FunctionSig> = new Map();
/** Active module-level values (local + named imports). */
let activeValues: Map<string, ModuleValueDef> = new Map();
/** All class defs by mangled name (for inheritance lookups). */
let classesByMangled: Map<string, ClassDef> = new Map();
/** All interface defs by mangled name. */
let interfacesByMangled: Map<string, InterfaceDef> = new Map();
let memberContext: MemberContext | null = null;
/** Type parameters in scope while checking a generic template. */
let activeTypeParams: Map<string, TypeParamValueType> = new Map();
/** Nesting depth while typechecking lambda bodies (for `this` rejection). */
let lambdaDepth = 0;
/** Instantiation collector for the current typecheck run. */
let instantiationCollector: InstantiationCollector =
  new InstantiationCollector();
/** Module currently being checked (for instantiation records). */
let activeModulePath = "";
let activeModuleId = "";
/** Optional semantic collector for IDE queries (LSP). */
let activeSemantic: SemanticCollector | null = null;
/** Templates for the active module. */
let activeGenericStructs: Map<string, GenericStructTemplate> = new Map();
let activeGenericClasses: Map<string, GenericClassTemplate> = new Map();
let activeGenericInterfaces: Map<string, GenericInterfaceTemplate> = new Map();
let activeGenericFunctions: Map<string, GenericFunctionTemplate> = new Map();
/** All module symbols by path (for cross-module template lookup). */
let allModuleSymbols: Map<string, ModuleSymbols> = new Map();
/** Concrete specialized defs created during this run (local name → def), per module context. */
let specializedStructs: Map<string, StructDef> = new Map();
let specializedClasses: Map<string, ClassDef> = new Map();
let specializedInterfaces: Map<string, InterfaceDef> = new Map();
let specializedFunctions: Map<string, FunctionSig> = new Map();

/**
 * Type-check a validated single-file program.
 */
export function typecheck(
  program: Program,
  diagnostics: DiagnosticCollector,
): TypecheckResult {
  for (const decl of program.body) {
    if (decl.kind === "ImportDeclaration") {
      diagnostics.error(
        "Import declarations require compiling from a file path (use compileFile)",
        decl.span,
        "E0400",
      );
      return {
        instantiations: new InstantiationCollector().snapshot(),
        semantic: emptySemanticModel(),
      };
    }
  }

  return typecheckModules(
    [
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
    ],
    diagnostics,
  );
}

export interface TypecheckResult {
  readonly instantiations: TypecheckInstantiations;
  readonly semantic: SemanticModel;
}

/**
 * Type-check a multi-module compilation unit.
 */
export function typecheckModules(
  modules: readonly ResolvedModule[],
  diagnostics: DiagnosticCollector,
): TypecheckResult {
  instantiationCollector = new InstantiationCollector();
  allModuleSymbols = new Map();
  const byPath = new Map<string, ModuleSymbols>();
  const semantic = new SemanticCollector();
  activeSemantic = semantic;

  for (const mod of modules) {
    diagnostics.setFile(mod.path);
    const symbols = collectModuleSymbols(mod, diagnostics);
    byPath.set(mod.path, symbols);
    allModuleSymbols.set(mod.path, symbols);
  }

  // Index IDE symbols only after every module is in allModuleSymbols so named
  // imports can resolve to the correct CompletionItemKind (not "variable").
  if (activeSemantic) {
    for (const mod of modules) {
      const local = byPath.get(mod.path)!;
      indexModuleSymbols(
        mod,
        local.functions,
        local.structs,
        local.enums,
        local.classes,
        local.interfaces,
        local.typeAliases,
        local.values,
      );
    }
  }

  classesByMangled = new Map();
  interfacesByMangled = new Map();
  for (const symbols of byPath.values()) {
    for (const def of symbols.classes.values()) {
      classesByMangled.set(def.name, def);
    }
    for (const def of symbols.interfaces.values()) {
      interfacesByMangled.set(def.name, def);
    }
  }

  // Formal export tables (local exports + re-exports) — authoritative for imports.
  const exportTables = buildExportTables(
    modules.map((m) => ({
      path: m.path,
      ast: m.ast,
      reexportSources: m.reexportSources,
    })),
    diagnostics,
  );

  // Keep going for IDE analysis even when the parser already reported errors.
  // Symbol tables from collectModuleSymbols are still useful for completions.

  for (const mod of modules) {
    diagnostics.setFile(mod.path);
    const local = byPath.get(mod.path)!;
    const namespaces = new Map<string, ModuleNamespace>();

    // Working maps: local symbols plus named imports injected under local names.
    const functions = new Map(local.functions);
    const structs = new Map(local.structs);
    const enums = new Map(local.enums);
    const classes = new Map(local.classes);
    const interfaces = new Map(local.interfaces);
    const typeAliases = new Map(local.typeAliases);
    const values = new Map(local.values);
    const genericStructs = new Map(local.genericStructs);
    const genericClasses = new Map(local.genericClasses);
    const genericInterfaces = new Map(local.genericInterfaces);
    const genericFunctions = new Map(local.genericFunctions);
    const genericTypeAliases = new Map(local.genericTypeAliases);

    const localNames = new Set<string>([
      ...local.functions.keys(),
      ...local.structs.keys(),
      ...local.enums.keys(),
      ...local.classes.keys(),
      ...local.interfaces.keys(),
      ...local.typeAliases.keys(),
      ...local.values.keys(),
      ...local.genericStructs.keys(),
      ...local.genericClasses.keys(),
      ...local.genericInterfaces.keys(),
      ...local.genericFunctions.keys(),
      ...local.genericTypeAliases.keys(),
    ]);

    const errorsBeforeImports = diagnostics.diagnostics.length;
    const exportTable = exportTables.get(mod.path);

    for (const binding of mod.imports) {
      const imported = byPath.get(binding.modulePath);
      const importedTable = exportTables.get(binding.modulePath);
      if (!imported || !importedTable) {
        continue;
      }

      if (binding.kind === "namespace") {
        if (localNames.has(binding.alias)) {
          diagnostics.error(
            `Import "${binding.alias}" conflicts with an existing declaration.`,
            binding.span,
            "E0405",
          );
          continue;
        }
        namespaces.set(
          binding.alias,
          namespaceFromExportTable(
            imported.moduleId,
            importedTable,
            byPath,
          ),
        );
        continue;
      }

      // Named import
      if (localNames.has(binding.localName)) {
        diagnostics.error(
          `Import "${binding.localName}" conflicts with an existing declaration.`,
          binding.span,
          "E0405",
        );
        continue;
      }

      const entry = importedTable.get(binding.exportName);
      if (!entry) {
        const sourceAst = modules.find(
          (m) => m.path === binding.modulePath,
        )?.ast;
        if (
          sourceAst &&
          hasPrivateDeclarationInAst(sourceAst, binding.exportName)
        ) {
          diagnostics.error(
            `"${binding.exportName}" is declared in "${binding.specifier}" but is not exported.`,
            binding.span,
            "E0408",
          );
        } else {
          diagnostics.error(
            `Module "${binding.specifier}" does not export "${binding.exportName}".`,
            binding.span,
            "E0408",
          );
        }
        continue;
      }

      const origin = byPath.get(entry.sourceModulePath);
      if (!origin) {
        continue;
      }
      const resolved = lookupExport(origin, entry.originalName);
      if (!resolved) {
        diagnostics.error(
          `Module "${binding.specifier}" does not export "${binding.exportName}".`,
          binding.span,
          "E0408",
        );
        continue;
      }

      injectNamedImport(binding.localName, resolved, {
        functions,
        structs,
        enums,
        classes,
        interfaces,
        typeAliases,
        values,
        genericStructs,
        genericClasses,
        genericInterfaces,
        genericFunctions,
        genericTypeAliases,
      });
      localNames.add(binding.localName);
    }

    void exportTable;

    // Only skip body checking when imports for this module failed (not prior parse errors).
    if (diagnostics.diagnostics.length > errorsBeforeImports) {
      continue;
    }

    activeNamespaces = namespaces;
    activeClasses = classes;
    activeInterfaces = interfaces;
    activeTypeAliases = typeAliases;
    activeGenericTypeAliases = genericTypeAliases;
    activeGenericStructs = genericStructs;
    activeGenericClasses = genericClasses;
    activeGenericInterfaces = genericInterfaces;
    activeGenericFunctions = genericFunctions;
    activeModulePath = mod.path;
    activeModuleId = mod.moduleId;
    specializedStructs = new Map();
    specializedClasses = new Map();
    specializedInterfaces = new Map();
    specializedFunctions = new Map();
    syntheticObjectStructs = new Map();
    aliasExpandStack = [];
    activeFunctions = functions;
    activeValues = values;
    activeExtensions = collectExtensionsFromMaps(functions, genericFunctions);
    indexMembersByType(structs, classes, enums, functions, genericFunctions);

    for (const decl of mod.ast.body) {
      if (decl.kind === "FunctionDeclaration") {
        if (decl.isExtern) {
          // Extern declarations have no body to type-check.
          continue;
        }
        if (decl.typeParams.length > 0) {
          checkGenericFunctionTemplate(
            decl,
            functions,
            structs,
            enums,
            diagnostics,
          );
        } else {
          checkFunction(decl, functions, structs, enums, diagnostics);
        }
      } else if (decl.kind === "StructDeclaration") {
        if (decl.typeParams.length > 0) {
          checkGenericStructTemplate(
            decl,
            functions,
            structs,
            enums,
            diagnostics,
          );
        } else {
          const def = structs.get(decl.name.name);
          if (def) {
            checkStructMethods(def, functions, structs, enums, diagnostics);
          }
        }
      } else if (decl.kind === "ClassDeclaration") {
        if (decl.typeParams.length > 0) {
          checkGenericClassTemplate(
            decl,
            functions,
            structs,
            enums,
            diagnostics,
          );
        } else {
          const def = classes.get(decl.name.name);
          if (def) {
            checkClassMembers(def, functions, structs, enums, diagnostics);
          }
        }
      }
    }
  }

  activeNamespaces = new Map();
  activeClasses = new Map();
  activeInterfaces = new Map();
  activeTypeAliases = new Map();
  activeGenericTypeAliases = new Map();
  activeValues = new Map();
  syntheticObjectStructs = new Map();
  aliasExpandStack = [];
  classesByMangled = new Map();
  interfacesByMangled = new Map();
  memberContext = null;
  activeTypeParams = new Map();
  activeGenericStructs = new Map();
  activeGenericClasses = new Map();
  activeGenericInterfaces = new Map();
  activeGenericFunctions = new Map();
  activeExtensions = [];
  allModuleSymbols = new Map();
  diagnostics.clearFile();
  activeSemantic = null;

  return {
    instantiations: instantiationCollector.snapshot(),
    semantic: semantic.freeze(modules),
  };
}

function collectExtensionsFromMaps(
  functions: Map<string, FunctionSig>,
  genericFunctions: Map<string, GenericFunctionTemplate>,
): ExtensionEntry[] {
  const out: ExtensionEntry[] = [];
  for (const sig of functions.values()) {
    if (sig.isExtension) {
      out.push({ name: sig.name, kind: "concrete", sig, template: null });
    }
  }
  for (const tpl of genericFunctions.values()) {
    if (tpl.decl.params[0]?.isReceiver) {
      out.push({
        name: tpl.decl.name.name,
        kind: "generic",
        sig: null,
        template: tpl,
      });
    }
  }
  return out;
}

function indexMembersByType(
  structs: Map<string, StructDef>,
  classes: Map<string, ClassDef>,
  enums: Map<string, EnumDef>,
  functions: Map<string, FunctionSig>,
  genericFunctions: Map<string, GenericFunctionTemplate>,
): void {
  if (!activeSemantic) {
    return;
  }

  const add = (typeString: string, item: ScopeBindingInfo) => {
    activeSemantic!.recordMembersForType(typeString, [item]);
  };

  for (const def of structs.values()) {
    const typeName = typeToString({ kind: "struct", name: def.name });
    const localName = def.decl.name.name;
    for (const f of def.fields) {
      const item = {
        name: f.name,
        detail: typeToString(f.type),
        kind: "field" as const,
      };
      add(typeName, item);
      add(localName, item);
    }
    for (const m of def.methods) {
      const item = {
        name: m.name,
        detail: typeToString({
          kind: "function",
          params: m.params,
          returnType: m.returnType,
        }),
        kind: "method" as const,
      };
      add(typeName, item);
      add(localName, item);
    }
  }

  for (const def of classes.values()) {
    const typeName = typeToString({ kind: "class", name: def.name });
    const localName = def.localName;
    for (const f of def.instanceFields) {
      const item = {
        name: f.name,
        detail: typeToString(f.type),
        kind: "field" as const,
      };
      add(typeName, item);
      add(localName, item);
    }
    for (const m of def.instanceMethods) {
      const item = {
        name: m.name,
        detail: typeToString({
          kind: "function",
          params: m.params,
          returnType: m.returnType,
        }),
        kind: "method" as const,
      };
      add(typeName, item);
      add(localName, item);
    }
    // Static members complete on the class name itself (Foo.bar).
    for (const f of def.staticFields) {
      const item = {
        name: f.name,
        detail: typeToString(f.type),
        kind: "field" as const,
      };
      add(localName, item);
      add(typeName, item);
    }
    for (const m of def.staticMethods) {
      const item = {
        name: m.name,
        detail: typeToString({
          kind: "function",
          params: m.params,
          returnType: m.returnType,
        }),
        kind: "method" as const,
      };
      add(localName, item);
      add(typeName, item);
    }
    if (def.constructorDecl) {
      add(localName, {
        name: "constructor",
        detail: "constructor",
        kind: "constructor",
      });
    }
  }

  for (const def of enums.values()) {
    const typeName = typeToString({ kind: "enum", name: def.name });
    const localName = def.decl.name.name;
    for (const variant of def.variants.keys()) {
      const item = {
        name: variant,
        detail: typeName,
        kind: "enumMember" as const,
      };
      add(typeName, item);
      add(localName, item);
    }
  }

  add("string", { name: "length", detail: "i32", kind: "property" });

  const sink = new DiagnosticCollector();
  for (const sig of functions.values()) {
    if (!sig.isExtension || !sig.decl.params[0]) {
      continue;
    }
    const receiver = resolveAnnotation(
      sig.decl.params[0].typeAnnotation,
      structs,
      enums,
      sink,
    );
    if (!receiver) {
      continue;
    }
    const typeName = typeToString(receiver);
    if (isArrayType(receiver)) {
      add(typeName, { name: "length", detail: "i32", kind: "property" });
    }
    add(typeName, {
      name: sig.name,
      detail: typeToString({
        kind: "function",
        params: sig.params.slice(1),
        returnType: sig.returnType,
      }),
      kind: "method",
    });
  }

  for (const tpl of genericFunctions.values()) {
    if (!tpl.decl.params[0]?.isReceiver) {
      continue;
    }
    const recv = tpl.decl.params[0].typeAnnotation;
    let typeName: string | null = null;
    if (recv.kind === "PrimitiveType") {
      typeName = recv.name;
    } else if (recv.kind === "NamedType" && recv.namespace === null) {
      typeName = recv.name;
    }
    if (!typeName) {
      continue;
    }
    add(typeName, {
      name: tpl.decl.name.name,
      detail: "extension method",
      kind: "method",
    });
  }
}

type NamedExportKind =
  | { kind: "function"; value: FunctionSig }
  | { kind: "struct"; value: StructDef }
  | { kind: "enum"; value: EnumDef }
  | { kind: "class"; value: ClassDef }
  | { kind: "interface"; value: InterfaceDef }
  | { kind: "typeAlias"; value: TypeAliasDef }
  | { kind: "value"; value: ModuleValueDef }
  | { kind: "genericStruct"; value: GenericStructTemplate }
  | { kind: "genericClass"; value: GenericClassTemplate }
  | { kind: "genericInterface"; value: GenericInterfaceTemplate }
  | { kind: "genericFunction"; value: GenericFunctionTemplate }
  | { kind: "genericTypeAlias"; value: TypeAliasDeclaration };

function lookupExport(
  symbols: ModuleSymbols,
  exportName: string,
): NamedExportKind | null {
  const fn = symbols.functions.get(exportName);
  if (fn) {
    return fn.exported ? { kind: "function", value: fn } : null;
  }
  const st = symbols.structs.get(exportName);
  if (st) {
    return st.exported ? { kind: "struct", value: st } : null;
  }
  const en = symbols.enums.get(exportName);
  if (en) {
    return en.exported ? { kind: "enum", value: en } : null;
  }
  const cl = symbols.classes.get(exportName);
  if (cl) {
    return cl.exported ? { kind: "class", value: cl } : null;
  }
  const iface = symbols.interfaces.get(exportName);
  if (iface) {
    return iface.exported ? { kind: "interface", value: iface } : null;
  }
  const alias = symbols.typeAliases.get(exportName);
  if (alias) {
    return alias.exported ? { kind: "typeAlias", value: alias } : null;
  }
  const val = symbols.values.get(exportName);
  if (val) {
    return val.exported ? { kind: "value", value: val } : null;
  }
  const gs = symbols.genericStructs.get(exportName);
  if (gs) {
    return gs.decl.exported ? { kind: "genericStruct", value: gs } : null;
  }
  const gc = symbols.genericClasses.get(exportName);
  if (gc) {
    return gc.decl.exported ? { kind: "genericClass", value: gc } : null;
  }
  const gi = symbols.genericInterfaces.get(exportName);
  if (gi) {
    return gi.decl.exported ? { kind: "genericInterface", value: gi } : null;
  }
  const gf = symbols.genericFunctions.get(exportName);
  if (gf) {
    return gf.decl.exported ? { kind: "genericFunction", value: gf } : null;
  }
  const gta = symbols.genericTypeAliases.get(exportName);
  if (gta) {
    return gta.exported ? { kind: "genericTypeAlias", value: gta } : null;
  }
  return null;
}

interface NamedImportMaps {
  functions: Map<string, FunctionSig>;
  structs: Map<string, StructDef>;
  enums: Map<string, EnumDef>;
  classes: Map<string, ClassDef>;
  interfaces: Map<string, InterfaceDef>;
  typeAliases: Map<string, TypeAliasDef>;
  values: Map<string, ModuleValueDef>;
  genericStructs: Map<string, GenericStructTemplate>;
  genericClasses: Map<string, GenericClassTemplate>;
  genericInterfaces: Map<string, GenericInterfaceTemplate>;
  genericFunctions: Map<string, GenericFunctionTemplate>;
  genericTypeAliases: Map<string, TypeAliasDeclaration>;
}

function injectNamedImport(
  localName: string,
  resolved: NamedExportKind,
  maps: NamedImportMaps,
): void {
  switch (resolved.kind) {
    case "function":
      maps.functions.set(localName, resolved.value);
      break;
    case "struct":
      maps.structs.set(localName, resolved.value);
      break;
    case "enum":
      maps.enums.set(localName, resolved.value);
      break;
    case "class":
      maps.classes.set(localName, resolved.value);
      break;
    case "interface":
      maps.interfaces.set(localName, resolved.value);
      break;
    case "typeAlias":
      maps.typeAliases.set(localName, resolved.value);
      break;
    case "value":
      maps.values.set(localName, resolved.value);
      break;
    case "genericStruct":
      maps.genericStructs.set(localName, resolved.value);
      break;
    case "genericClass":
      maps.genericClasses.set(localName, resolved.value);
      break;
    case "genericInterface":
      maps.genericInterfaces.set(localName, resolved.value);
      break;
    case "genericFunction":
      maps.genericFunctions.set(localName, resolved.value);
      break;
    case "genericTypeAlias":
      maps.genericTypeAliases.set(localName, resolved.value);
      break;
  }
}

function namespaceFromExportTable(
  moduleId: string,
  table: ExportTable,
  byPath: Map<string, ModuleSymbols>,
): ModuleNamespace {
  const functions = new Map<string, FunctionSig>();
  const structs = new Map<string, StructDef>();
  const enums = new Map<string, EnumDef>();
  const classes = new Map<string, ClassDef>();
  const interfaces = new Map<string, InterfaceDef>();
  const typeAliases = new Map<string, TypeAliasDef>();
  const values = new Map<string, ModuleValueDef>();

  for (const [exportName, entry] of table) {
    const origin = byPath.get(entry.sourceModulePath);
    if (!origin) {
      continue;
    }
    const resolved = lookupExport(origin, entry.originalName);
    if (!resolved) {
      continue;
    }
    switch (resolved.kind) {
      case "function":
        functions.set(exportName, resolved.value);
        break;
      case "struct":
        structs.set(exportName, resolved.value);
        break;
      case "enum":
        enums.set(exportName, resolved.value);
        break;
      case "class":
        classes.set(exportName, resolved.value);
        break;
      case "interface":
        interfaces.set(exportName, resolved.value);
        break;
      case "typeAlias":
        typeAliases.set(exportName, resolved.value);
        break;
      case "value":
        values.set(exportName, resolved.value);
        break;
      default:
        // Generics are available via named import injection; skip in namespace maps for now.
        break;
    }
  }

  return {
    moduleId,
    functions,
    structs,
    enums,
    classes,
    interfaces,
    typeAliases,
    values,
  };
}

function exportedFunctions(
  fns: Map<string, FunctionSig>,
): Map<string, FunctionSig> {
  const out = new Map<string, FunctionSig>();
  for (const [name, sig] of fns) {
    if (sig.exported) {
      out.set(name, sig);
    }
  }
  return out;
}

function exportedStructs(
  structs: Map<string, StructDef>,
): Map<string, StructDef> {
  const out = new Map<string, StructDef>();
  for (const [name, def] of structs) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
}

function exportedEnums(enums: Map<string, EnumDef>): Map<string, EnumDef> {
  const out = new Map<string, EnumDef>();
  for (const [name, def] of enums) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
}

function exportedClasses(
  classes: Map<string, ClassDef>,
): Map<string, ClassDef> {
  const out = new Map<string, ClassDef>();
  for (const [name, def] of classes) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
}

function exportedInterfaces(
  interfaces: Map<string, InterfaceDef>,
): Map<string, InterfaceDef> {
  const out = new Map<string, InterfaceDef>();
  for (const [name, def] of interfaces) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
}

function exportedTypeAliases(
  aliases: Map<string, TypeAliasDef>,
): Map<string, TypeAliasDef> {
  const out = new Map<string, TypeAliasDef>();
  for (const [name, def] of aliases) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
}

function isHiddenPreludeImport(binding: ModuleImportBinding): boolean {
  if (binding.kind !== "named") {
    return false;
  }
  return (
    binding.localName.startsWith("__prelude_ext_") ||
    binding.specifier.startsWith("std/prelude/")
  );
}

function exportLocation(
  imported: ModuleSymbols,
  exportName: string,
): { file: string; span: SourceSpan } | null {
  const fn = imported.functions.get(exportName);
  if (fn && !fn.isExtension) {
    return { file: imported.modulePath, span: fn.decl.name.span };
  }
  const st = imported.structs.get(exportName);
  if (st) {
    return { file: imported.modulePath, span: st.decl.name.span };
  }
  const en = imported.enums.get(exportName);
  if (en) {
    return { file: imported.modulePath, span: en.decl.name.span };
  }
  const cl = imported.classes.get(exportName);
  if (cl) {
    return { file: imported.modulePath, span: cl.decl.name.span };
  }
  const iface = imported.interfaces.get(exportName);
  if (iface) {
    return { file: imported.modulePath, span: iface.decl.name.span };
  }
  const alias = imported.typeAliases.get(exportName);
  if (alias) {
    return { file: imported.modulePath, span: alias.decl.name.span };
  }
  const val = imported.values.get(exportName);
  if (val) {
    return { file: imported.modulePath, span: val.span };
  }
  return null;
}

function firstModuleLocation(
  imported: ModuleSymbols,
): { file: string; span: SourceSpan } | null {
  for (const sig of imported.functions.values()) {
    if (!sig.isExtension) {
      return { file: imported.modulePath, span: sig.decl.name.span };
    }
  }
  for (const def of imported.structs.values()) {
    return { file: imported.modulePath, span: def.decl.name.span };
  }
  for (const def of imported.enums.values()) {
    return { file: imported.modulePath, span: def.decl.name.span };
  }
  for (const def of imported.classes.values()) {
    return { file: imported.modulePath, span: def.decl.name.span };
  }
  for (const def of imported.interfaces.values()) {
    return { file: imported.modulePath, span: def.decl.name.span };
  }
  for (const def of imported.typeAliases.values()) {
    return { file: imported.modulePath, span: def.decl.name.span };
  }
  for (const def of imported.values.values()) {
    return { file: imported.modulePath, span: def.span };
  }
  return null;
}

function namespaceMemberCompletions(
  imported: ModuleSymbols,
): ScopeBindingInfo[] {
  const members: ScopeBindingInfo[] = [];
  for (const sig of imported.functions.values()) {
    if (sig.isExtension || !sig.exported) {
      continue;
    }
    members.push({
      name: sig.name,
      kind: "function",
      detail: typeToString({
        kind: "function",
        params: sig.params,
        returnType: sig.returnType,
      }),
    });
  }
  for (const def of imported.structs.values()) {
    if (!def.exported) {
      continue;
    }
    members.push({
      name: def.decl.name.name,
      kind: "struct",
      detail: "struct",
    });
  }
  for (const def of imported.enums.values()) {
    if (!def.exported) {
      continue;
    }
    members.push({ name: def.decl.name.name, kind: "enum", detail: "enum" });
  }
  for (const def of imported.classes.values()) {
    if (!def.exported) {
      continue;
    }
    members.push({ name: def.decl.name.name, kind: "class", detail: "class" });
  }
  for (const def of imported.interfaces.values()) {
    if (!def.exported) {
      continue;
    }
    members.push({
      name: def.decl.name.name,
      kind: "interface",
      detail: "interface",
    });
  }
  for (const def of imported.typeAliases.values()) {
    if (!def.exported) {
      continue;
    }
    members.push({ name: def.decl.name.name, kind: "type", detail: "type" });
  }
  for (const def of imported.values.values()) {
    if (!def.exported) {
      continue;
    }
    members.push({
      name: def.name,
      kind: def.mutability === "const" ? "constant" : "variable",
      detail: typeToString(def.type),
    });
  }
  return members;
}

function modulePathOwningMangled(
  kind: "struct" | "class",
  mangledName: string,
): string | null {
  for (const symbols of allModuleSymbols.values()) {
    if (kind === "struct") {
      for (const def of symbols.structs.values()) {
        if (def.name === mangledName) {
          return symbols.modulePath;
        }
      }
    } else {
      for (const def of symbols.classes.values()) {
        if (def.name === mangledName) {
          return symbols.modulePath;
        }
      }
    }
  }
  return null;
}

function indexModuleSymbols(
  mod: ResolvedModule,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  classes: Map<string, ClassDef>,
  interfaces: Map<string, InterfaceDef>,
  typeAliases: Map<string, TypeAliasDef>,
  values: Map<string, ModuleValueDef>,
): void {
  if (!activeSemantic) {
    return;
  }
  const file = mod.path;
  for (const binding of mod.imports) {
    if (isHiddenPreludeImport(binding)) {
      continue;
    }
    if (binding.kind === "namespace") {
      activeSemantic.addModuleSymbol(file, {
        name: binding.alias,
        kind: "module",
        detail: "namespace",
        location: { file, span: binding.span },
      });
      activeSemantic.recordDeclaration(file, binding.span);
      const imported = allModuleSymbols.get(binding.modulePath);
      if (imported) {
        const members = namespaceMemberCompletions(imported);
        if (members.length > 0) {
          activeSemantic.recordMembersForType(binding.alias, members);
        }
        const modLoc = firstModuleLocation(imported);
        if (modLoc) {
          activeSemantic.recordDefinition(file, binding.span, modLoc);
        }
      }
    } else {
      const imported = allModuleSymbols.get(binding.modulePath);
      let kind: ScopeBindingInfo["kind"] = "variable";
      let detail = `import ${binding.exportName}`;
      if (imported) {
        if (imported.functions.has(binding.exportName)) {
          kind = "function";
          const sig = imported.functions.get(binding.exportName)!;
          detail = typeToString({
            kind: "function",
            params: sig.params,
            returnType: sig.returnType,
          });
        } else if (imported.structs.has(binding.exportName)) {
          kind = "struct";
          detail = "struct";
        } else if (imported.classes.has(binding.exportName)) {
          kind = "class";
          detail = "class";
        } else if (imported.enums.has(binding.exportName)) {
          kind = "enum";
          detail = "enum";
        } else if (imported.interfaces.has(binding.exportName)) {
          kind = "interface";
          detail = "interface";
        } else if (imported.typeAliases.has(binding.exportName)) {
          kind = "type";
          detail = "type";
        } else if (imported.values.has(binding.exportName)) {
          const val = imported.values.get(binding.exportName)!;
          kind = val.mutability === "const" ? "constant" : "variable";
          detail = typeToString(val.type);
        }
        const defLoc = exportLocation(imported, binding.exportName);
        if (defLoc) {
          activeSemantic.recordDefinition(file, binding.span, defLoc);
        }
      }
      activeSemantic.addModuleSymbol(file, {
        name: binding.localName,
        kind,
        detail,
        location: { file, span: binding.span },
      });
      activeSemantic.recordDeclaration(file, binding.span);
    }
  }
  for (const sig of functions.values()) {
    if (sig.isExtension) {
      continue;
    }
    activeSemantic.addModuleSymbol(file, {
      name: sig.name,
      kind: "function",
      detail: typeToString({
        kind: "function",
        params: sig.params,
        returnType: sig.returnType,
      }),
      location: { file, span: sig.decl.name.span },
    });
    activeSemantic.recordDeclaration(file, sig.decl.name.span);
  }
  for (const def of structs.values()) {
    activeSemantic.addModuleSymbol(file, {
      name: def.decl.name.name,
      kind: "struct",
      detail: "struct",
      location: { file, span: def.decl.name.span },
    });
    activeSemantic.recordDeclaration(file, def.decl.name.span);
  }
  for (const def of enums.values()) {
    activeSemantic.addModuleSymbol(file, {
      name: def.decl.name.name,
      kind: "enum",
      detail: "enum",
      location: { file, span: def.decl.name.span },
    });
    activeSemantic.recordDeclaration(file, def.decl.name.span);
  }
  for (const def of classes.values()) {
    activeSemantic.addModuleSymbol(file, {
      name: def.decl.name.name,
      kind: "class",
      detail: "class",
      location: { file, span: def.decl.name.span },
    });
    activeSemantic.recordDeclaration(file, def.decl.name.span);
  }
  for (const def of interfaces.values()) {
    activeSemantic.addModuleSymbol(file, {
      name: def.decl.name.name,
      kind: "interface",
      detail: "interface",
      location: { file, span: def.decl.name.span },
    });
    activeSemantic.recordDeclaration(file, def.decl.name.span);
  }
  for (const def of typeAliases.values()) {
    activeSemantic.addModuleSymbol(file, {
      name: def.decl.name.name,
      kind: "type",
      detail: "type",
      location: { file, span: def.decl.name.span },
    });
    activeSemantic.recordDeclaration(file, def.decl.name.span);
  }
  for (const def of values.values()) {
    activeSemantic.addModuleSymbol(file, {
      name: def.name,
      kind: def.mutability === "const" ? "constant" : "variable",
      detail: typeToString(def.type),
      location: { file, span: def.span },
    });
    activeSemantic.recordDeclaration(file, def.span);
  }
}

function collectModuleSymbols(
  mod: ResolvedModule,
  diagnostics: DiagnosticCollector,
): ModuleSymbols {
  const enums = collectEnums(mod.ast, mod.moduleId, diagnostics);
  const genericStructs = new Map<string, GenericStructTemplate>();
  const genericClasses = new Map<string, GenericClassTemplate>();
  const genericInterfaces = new Map<string, GenericInterfaceTemplate>();
  const genericFunctions = new Map<string, GenericFunctionTemplate>();
  const genericTypeAliases = new Map<string, TypeAliasDeclaration>();

  for (const decl of mod.ast.body) {
    if (decl.kind === "StructDeclaration" && decl.typeParams.length > 0) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericStructs.set(decl.name.name, {
          decl,
          moduleId: mod.moduleId,
          modulePath: mod.path,
        });
      }
    } else if (decl.kind === "ClassDeclaration" && decl.typeParams.length > 0) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericClasses.set(decl.name.name, {
          decl,
          moduleId: mod.moduleId,
          modulePath: mod.path,
        });
      }
    } else if (
      decl.kind === "InterfaceDeclaration" &&
      decl.typeParams.length > 0
    ) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericInterfaces.set(decl.name.name, {
          decl,
          moduleId: mod.moduleId,
          modulePath: mod.path,
        });
      }
    } else if (
      decl.kind === "FunctionDeclaration" &&
      decl.typeParams.length > 0
    ) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericFunctions.set(decl.name.name, {
          decl,
          moduleId: mod.moduleId,
          modulePath: mod.path,
        });
      }
    } else if (
      decl.kind === "TypeAliasDeclaration" &&
      decl.typeParams.length > 0
    ) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericTypeAliases.set(decl.name.name, decl);
      }
    }
  }

  const structs = collectStructs(
    mod.ast,
    mod.moduleId,
    enums,
    diagnostics,
    genericStructs,
  );
  const typeAliases = collectTypeAliases(
    mod.ast,
    mod.moduleId,
    diagnostics,
    genericTypeAliases,
  );
  const interfaces = collectInterfaces(
    mod.ast,
    mod.moduleId,
    structs,
    enums,
    diagnostics,
    genericInterfaces,
  );
  const classes = collectClasses(
    mod.ast,
    mod.moduleId,
    structs,
    enums,
    interfaces,
    diagnostics,
    genericClasses,
  );
  const functions = new Map<string, FunctionSig>();

  const prevClasses = activeClasses;
  const prevInterfaces = activeInterfaces;
  const prevAliases = activeTypeAliases;
  activeClasses = classes;
  activeInterfaces = interfaces;
  activeTypeAliases = typeAliases;

  for (const decl of mod.ast.body) {
    if (decl.kind !== "FunctionDeclaration" || decl.typeParams.length > 0) {
      continue;
    }
    const fn = decl;

    if (fn.name.name === "print" || fn.name.name === "createMap") {
      diagnostics.error(
        `Cannot redefine builtin function '${fn.name.name}'`,
        fn.name.span,
        "E0310",
      );
      continue;
    }

    if (structs.has(fn.name.name) || genericStructs.has(fn.name.name)) {
      diagnostics.error(
        `Name '${fn.name.name}' is already used as a struct`,
        fn.name.span,
        "E0330",
      );
      continue;
    }

    if (enums.has(fn.name.name)) {
      diagnostics.error(
        `Name '${fn.name.name}' is already used as an enum`,
        fn.name.span,
        "E0330",
      );
      continue;
    }

    if (classes.has(fn.name.name) || genericClasses.has(fn.name.name)) {
      diagnostics.error(
        `Name '${fn.name.name}' is already used as a class`,
        fn.name.span,
        "E0330",
      );
      continue;
    }

    if (interfaces.has(fn.name.name) || genericInterfaces.has(fn.name.name)) {
      diagnostics.error(
        `Name '${fn.name.name}' is already used as an interface`,
        fn.name.span,
        "E0330",
      );
      continue;
    }

    if (functions.has(fn.name.name) || genericFunctions.has(fn.name.name)) {
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
      const paramType = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (paramType === null) {
        paramsOk = false;
        continue;
      }
      params.push(paramType);
    }

    if (!paramsOk) {
      continue;
    }

    const returnType = resolveReturnType(
      fn.returnType,
      structs,
      enums,
      diagnostics,
    );
    if (returnType === undefined) {
      continue;
    }

    functions.set(fn.name.name, {
      name: fn.name.name,
      mangledName: fn.isExtern
        ? fn.name.name
        : fn.name.name === "main"
          ? "main"
          : mangleSymbol(mod.moduleId, fn.name.name),
      params,
      returnType,
      decl: fn,
      exported: fn.exported,
      isExtern: fn.isExtern,
      isExtension: fn.params[0]?.isReceiver === true,
      modulePath: mod.path,
    });
  }

  const values = new Map<string, ModuleValueDef>();
  for (const decl of mod.ast.body) {
    if (decl.kind !== "ModuleVariableDeclaration") {
      continue;
    }

    const name = decl.name.name;
    if (
      functions.has(name) ||
      genericFunctions.has(name) ||
      structs.has(name) ||
      genericStructs.has(name) ||
      enums.has(name) ||
      classes.has(name) ||
      genericClasses.has(name) ||
      interfaces.has(name) ||
      genericInterfaces.has(name) ||
      typeAliases.has(name) ||
      genericTypeAliases.has(name) ||
      values.has(name)
    ) {
      diagnostics.error(
        `Duplicate declaration '${name}'`,
        decl.name.span,
        "E0330",
      );
      continue;
    }

    let annotated: ValueType | null = null;
    if (decl.typeAnnotation) {
      annotated = resolveAnnotation(
        decl.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (annotated === null) {
        continue;
      }
    }

    // Infer type from initializer for the symbol table; full checking happens later.
    const valuesScope = new Map<string, Binding>();
    for (const [n, v] of values) {
      valuesScope.set(n, {
        type: v.type,
        mutable: v.mutability === "let",
        defSpan: v.span,
        defFile: v.modulePath,
        bindingKind: v.mutability === "const" ? "const" : "let",
      });
    }
    const inferred = checkExpression(
      decl.initializer,
      valuesScope,
      functions,
      structs,
      enums,
      diagnostics,
      false,
      annotated ?? undefined,
    );
    if (!inferred) {
      continue;
    }

    let bindingType: ValueType = inferred;
    if (annotated) {
      if (
        !initializerMatchesAnnotation(decl.initializer, inferred, annotated)
      ) {
        diagnostics.error(
          typeMismatchMessage(annotated, inferred),
          decl.initializer.span,
          "E0303",
        );
        continue;
      }
      bindingType = annotated;
    }

    values.set(name, {
      name,
      type: bindingType,
      mutability: decl.mutability,
      exported: decl.exported,
      mangledName: mangleSymbol(mod.moduleId, name),
      modulePath: mod.path,
      span: decl.name.span,
      decl,
    });
  }

  activeClasses = prevClasses;
  activeInterfaces = prevInterfaces;
  activeTypeAliases = prevAliases;

  return {
    moduleId: mod.moduleId,
    modulePath: mod.path,
    functions,
    structs,
    enums,
    classes,
    interfaces,
    typeAliases,
    values,
    genericStructs,
    genericClasses,
    genericInterfaces,
    genericFunctions,
    genericTypeAliases,
  };
}

function collectTypeAliases(
  program: Program,
  moduleId: string,
  diagnostics: DiagnosticCollector,
  genericTypeAliases: Map<string, TypeAliasDeclaration>,
): Map<string, TypeAliasDef> {
  const aliases = new Map<string, TypeAliasDef>();
  for (const decl of program.body) {
    if (decl.kind !== "TypeAliasDeclaration") {
      continue;
    }
    if (decl.typeParams.length > 0) {
      continue;
    }
    if (aliases.has(decl.name.name) || genericTypeAliases.has(decl.name.name)) {
      diagnostics.error(
        `Duplicate type alias '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }
    aliases.set(decl.name.name, {
      name: mangleSymbol(moduleId, decl.name.name),
      localName: decl.name.name,
      decl,
      exported: decl.exported,
    });
  }
  return aliases;
}

function collectEnums(
  program: Program,
  moduleId: string,
  diagnostics: DiagnosticCollector,
): Map<string, EnumDef> {
  const enums = new Map<string, EnumDef>();
  const reservedNames = new Set<string>();

  for (const decl of program.body) {
    if (
      decl.kind === "StructDeclaration" ||
      decl.kind === "ClassDeclaration" ||
      decl.kind === "InterfaceDeclaration"
    ) {
      reservedNames.add(decl.name.name);
    }
  }

  for (const decl of program.body) {
    if (decl.kind !== "EnumDeclaration") {
      continue;
    }

    if (enums.has(decl.name.name)) {
      diagnostics.error(
        `Duplicate enum '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }

    if (reservedNames.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as a struct, class, or interface`,
        decl.name.span,
        "E0330",
      );
      continue;
    }

    if (decl.variants.length === 0) {
      diagnostics.error(
        `Enum '${decl.name.name}' must have at least one variant`,
        decl.name.span,
        "E0334",
      );
      continue;
    }

    const variants = new Map<string, number>();
    let variantsOk = true;
    for (let i = 0; i < decl.variants.length; i += 1) {
      const variant = decl.variants[i]!;
      if (variants.has(variant.name.name)) {
        diagnostics.error(
          `Duplicate variant '${variant.name.name}' in enum '${decl.name.name}'`,
          variant.name.span,
          "E0329",
        );
        variantsOk = false;
        continue;
      }
      variants.set(variant.name.name, i);
    }

    if (variantsOk) {
      enums.set(decl.name.name, {
        name: mangleSymbol(moduleId, decl.name.name),
        variants,
        decl,
        exported: decl.exported,
      });
    }
  }

  return enums;
}

/** Minimal ClassDef so resolveAnnotation can see same-module class names early. */
function classNamePlaceholder(
  moduleId: string,
  decl: ClassDeclaration,
): ClassDef {
  const mangled = mangleSymbol(moduleId, decl.name.name);
  return {
    name: mangled,
    localName: decl.name.name,
    isAbstract: decl.isAbstract,
    superclass: null,
    implementedInterfaces: [],
    instanceFields: [],
    staticFields: [],
    instanceMethods: [],
    staticMethods: [],
    constructorParams: [],
    constructorDecl: null,
    constructorMangledName: mangleSymbol(
      moduleId,
      `${decl.name.name}__constructor`,
    ),
    vtableGlobalName: `${mangled}__vtable`,
    decl,
    exported: decl.exported,
  };
}

function collectStructs(
  program: Program,
  moduleId: string,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  genericStructs: Map<string, GenericStructTemplate>,
): Map<string, StructDef> {
  const structs = new Map<string, StructDef>();
  const declarations: StructDeclaration[] = [];
  const reservedNames = new Set<string>();
  for (const decl of program.body) {
    if (
      decl.kind === "ClassDeclaration" ||
      decl.kind === "InterfaceDeclaration"
    ) {
      reservedNames.add(decl.name.name);
    }
  }

  for (const decl of program.body) {
    if (decl.kind !== "StructDeclaration") {
      continue;
    }

    if (decl.typeParams.length > 0) {
      // Template only — already registered in genericStructs.
      continue;
    }

    if (
      structs.has(decl.name.name) ||
      declarations.some((d) => d.name.name === decl.name.name)
    ) {
      diagnostics.error(
        `Duplicate struct '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }

    if (genericStructs.has(decl.name.name)) {
      diagnostics.error(
        `Duplicate struct '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }

    if (enums.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as an enum`,
        decl.name.span,
        "E0330",
      );
      continue;
    }

    if (reservedNames.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as a class or interface`,
        decl.name.span,
        "E0330",
      );
      continue;
    }

    declarations.push(decl);
    structs.set(decl.name.name, {
      name: mangleSymbol(moduleId, decl.name.name),
      fields: [],
      methods: [],
      decl,
      exported: decl.exported,
    });
  }

  // Struct fields may be reference types (e.g. class); expose same-module class names
  // before collectClasses runs so field annotations resolve correctly.
  const prevClasses = activeClasses;
  const classPlaceholders = new Map(activeClasses);
  for (const decl of program.body) {
    if (decl.kind === "ClassDeclaration") {
      classPlaceholders.set(
        decl.name.name,
        classNamePlaceholder(moduleId, decl),
      );
    }
  }
  activeClasses = classPlaceholders;

  for (const decl of declarations) {
    const fields: StructFieldDef[] = [];
    const methods: StructMethodDef[] = [];
    const seen = new Set<string>();
    let ok = true;

    for (const field of decl.fields) {
      if (seen.has(field.name.name)) {
        diagnostics.error(
          `Duplicate field '${field.name.name}' in struct '${decl.name.name}'`,
          field.name.span,
          "E0329",
        );
        ok = false;
        continue;
      }
      seen.add(field.name.name);

      const fieldType = resolveAnnotation(
        field.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (fieldType === null) {
        ok = false;
        continue;
      }
      fields.push({ name: field.name.name, type: fieldType });
    }

    for (const method of decl.methods) {
      if (method.typeParams.length > 0) {
        // Generic methods are specialized at call sites.
        if (seen.has(method.name.name)) {
          diagnostics.error(
            `Duplicate member '${method.name.name}' in struct '${decl.name.name}'`,
            method.name.span,
            "E0329",
          );
          ok = false;
          continue;
        }
        seen.add(method.name.name);
        if (!validateTypeParamList(method.typeParams, diagnostics)) {
          ok = false;
        }
        continue;
      }
      if (seen.has(method.name.name)) {
        diagnostics.error(
          `Duplicate member '${method.name.name}' in struct '${decl.name.name}'`,
          method.name.span,
          "E0329",
        );
        ok = false;
        continue;
      }
      seen.add(method.name.name);

      const params: ValueType[] = [];
      let paramsOk = true;
      for (const param of method.params) {
        const paramType = resolveAnnotation(
          param.typeAnnotation,
          structs,
          enums,
          diagnostics,
        );
        if (paramType === null) {
          paramsOk = false;
          continue;
        }
        params.push(paramType);
      }
      const returnType = resolveReturnType(
        method.returnType,
        structs,
        enums,
        diagnostics,
      );
      if (returnType === undefined || !paramsOk) {
        ok = false;
        continue;
      }
      methods.push({
        name: method.name.name,
        mangledName: mangleSymbol(
          moduleId,
          `${decl.name.name}__${method.name.name}`,
        ),
        params,
        returnType,
        decl: method,
      });
    }

    if (ok) {
      const existing = structs.get(decl.name.name)!;
      structs.set(decl.name.name, {
        name: existing.name,
        fields,
        methods,
        decl,
        exported: decl.exported,
      });
    } else {
      structs.delete(decl.name.name);
    }
  }

  activeClasses = prevClasses;
  return structs;
}

function collectInterfaces(
  program: Program,
  moduleId: string,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  genericInterfaces: Map<string, GenericInterfaceTemplate>,
): Map<string, InterfaceDef> {
  const declarations: InterfaceDeclaration[] = [];
  const byLocal = new Map<string, InterfaceDeclaration>();
  const classNames = new Set<string>();
  for (const decl of program.body) {
    if (decl.kind === "ClassDeclaration") {
      classNames.add(decl.name.name);
    }
  }

  for (const decl of program.body) {
    if (decl.kind !== "InterfaceDeclaration") {
      continue;
    }
    if (decl.typeParams.length > 0) {
      continue;
    }
    if (byLocal.has(decl.name.name) || genericInterfaces.has(decl.name.name)) {
      diagnostics.error(
        `Duplicate interface '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }
    if (structs.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as a struct`,
        decl.name.span,
        "E0330",
      );
      continue;
    }
    if (enums.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as an enum`,
        decl.name.span,
        "E0330",
      );
      continue;
    }
    if (classNames.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as a class`,
        decl.name.span,
        "E0330",
      );
      continue;
    }
    byLocal.set(decl.name.name, decl);
    declarations.push(decl);
  }

  const interfaces = new Map<string, InterfaceDef>();
  for (const decl of declarations) {
    const mangled = mangleSymbol(moduleId, decl.name.name);
    interfaces.set(decl.name.name, {
      name: mangled,
      localName: decl.name.name,
      bases: [],
      methods: [],
      baseItableOffsets: new Map([[mangled, 0]]),
      indexType: null,
      decl,
      exported: decl.exported,
    });
  }

  const prevActive = activeInterfaces;
  activeInterfaces = interfaces;

  const visiting = new Set<string>();
  const done = new Set<string>();

  const finishInterface = (localName: string): InterfaceDef | null => {
    if (done.has(localName)) {
      return interfaces.get(localName) ?? null;
    }
    if (visiting.has(localName)) {
      const decl = byLocal.get(localName)!;
      diagnostics.error(
        `Inheritance cycle involving interface '${localName}'`,
        decl.name.span,
        "E0373",
      );
      return null;
    }
    visiting.add(localName);
    const decl = byLocal.get(localName)!;
    const mangled = mangleSymbol(moduleId, localName);

    const bases: InterfaceDef[] = [];
    for (const baseType of decl.bases) {
      let base: InterfaceDef | null = null;
      if (baseType.namespace) {
        const ns = activeNamespaces.get(baseType.namespace);
        if (!ns || !ns.interfaces.has(baseType.name)) {
          diagnostics.error(
            `Unknown interface '${baseType.namespace}.${baseType.name}'`,
            baseType.span,
            "E0104",
          );
          visiting.delete(localName);
          return null;
        }
        base = ns.interfaces.get(baseType.name)!;
      } else if (byLocal.has(baseType.name)) {
        base = finishInterface(baseType.name);
        if (!base) {
          visiting.delete(localName);
          return null;
        }
      } else if (interfaces.has(baseType.name)) {
        base = interfaces.get(baseType.name)!;
      } else {
        diagnostics.error(
          `Unknown interface '${baseType.name}'`,
          baseType.span,
          "E0104",
        );
        visiting.delete(localName);
        return null;
      }
      bases.push(base);
    }

    const methods: InterfaceMethodDef[] = [];
    const baseItableOffsets = new Map<string, number>();
    baseItableOffsets.set(mangled, 0);
    const seenNames = new Set<string>();
    let ok = true;

    for (const base of bases) {
      baseItableOffsets.set(base.name, methods.length);
      for (const [baseName, offset] of base.baseItableOffsets) {
        if (!baseItableOffsets.has(baseName)) {
          baseItableOffsets.set(baseName, methods.length + offset);
        }
      }
      for (const method of base.methods) {
        if (seenNames.has(method.name)) {
          // Diamond / overlapping base methods: require identical signature; skip duplicate slot.
          const existing = methods.find((m) => m.name === method.name)!;
          if (
            existing.params.length !== method.params.length ||
            !existing.params.every((p, i) =>
              typesEqual(p, method.params[i]!),
            ) ||
            (existing.returnType === "void") !==
              (method.returnType === "void") ||
            (existing.returnType !== "void" &&
              method.returnType !== "void" &&
              !typesEqual(existing.returnType, method.returnType))
          ) {
            diagnostics.error(
              `Interface '${localName}' inherits incompatible definitions of method '${method.name}'`,
              decl.name.span,
              "E0374",
            );
            ok = false;
          }
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
        diagnostics.error(
          `Duplicate method '${method.name.name}' in interface '${localName}'`,
          method.name.span,
          "E0329",
        );
        ok = false;
        continue;
      }
      seenNames.add(method.name.name);

      const params: ValueType[] = [];
      let paramsOk = true;
      for (const param of method.params) {
        const paramType = resolveAnnotation(
          param.typeAnnotation,
          structs,
          enums,
          diagnostics,
        );
        if (paramType === null) {
          paramsOk = false;
          continue;
        }
        params.push(paramType);
      }
      const returnType = resolveReturnType(
        method.returnType,
        structs,
        enums,
        diagnostics,
      );
      if (returnType === undefined || !paramsOk) {
        ok = false;
        continue;
      }
      methods.push({
        name: method.name.name,
        params,
        returnType,
        itableSlot: methods.length,
      });
    }

    visiting.delete(localName);
    done.add(localName);

    if (!ok) {
      interfaces.delete(localName);
      return null;
    }

    let indexType: ValueType | null = null;
    if (decl.indexSignature) {
      indexType = resolveAnnotation(
        decl.indexSignature.valueType,
        structs,
        enums,
        diagnostics,
      );
      if (indexType === null) {
        interfaces.delete(localName);
        return null;
      }
      if (
        !assertMapValueType(
          indexType,
          decl.indexSignature.valueType.span,
          diagnostics,
        )
      ) {
        interfaces.delete(localName);
        return null;
      }
    }

    const def: InterfaceDef = {
      name: mangled,
      localName,
      bases,
      methods,
      baseItableOffsets,
      indexType,
      decl,
      exported: decl.exported,
    };
    interfaces.set(localName, def);
    interfacesByMangled.set(mangled, def);
    return def;
  };

  for (const decl of declarations) {
    finishInterface(decl.name.name);
  }

  activeInterfaces = prevActive;
  return interfaces;
}

function collectClasses(
  program: Program,
  moduleId: string,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  interfaces: Map<string, InterfaceDef>,
  diagnostics: DiagnosticCollector,
  genericClasses: Map<string, GenericClassTemplate>,
): Map<string, ClassDef> {
  const declarations: ClassDeclaration[] = [];
  const byLocal = new Map<string, ClassDeclaration>();

  for (const decl of program.body) {
    if (decl.kind !== "ClassDeclaration") {
      continue;
    }
    if (decl.name.name === BUILTIN_ERROR_LOCAL_NAME) {
      diagnostics.error(
        `Cannot redefine builtin class '${BUILTIN_ERROR_LOCAL_NAME}'`,
        decl.name.span,
        "E0382",
      );
      continue;
    }
    if (decl.typeParams.length > 0) {
      continue;
    }
    if (byLocal.has(decl.name.name) || genericClasses.has(decl.name.name)) {
      diagnostics.error(
        `Duplicate class '${decl.name.name}'`,
        decl.name.span,
        "E0328",
      );
      continue;
    }
    if (structs.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as a struct`,
        decl.name.span,
        "E0330",
      );
      continue;
    }
    if (enums.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as an enum`,
        decl.name.span,
        "E0330",
      );
      continue;
    }
    if (interfaces.has(decl.name.name)) {
      diagnostics.error(
        `Name '${decl.name.name}' is already used as an interface`,
        decl.name.span,
        "E0330",
      );
      continue;
    }
    byLocal.set(decl.name.name, decl);
    declarations.push(decl);
  }

  // Placeholder map so resolveAnnotation can see class names mid-build.
  const classes = new Map<string, ClassDef>();
  classes.set(BUILTIN_ERROR_LOCAL_NAME, createBuiltinErrorClassDef());
  for (const decl of declarations) {
    const mangled = mangleSymbol(moduleId, decl.name.name);
    classes.set(decl.name.name, {
      name: mangled,
      localName: decl.name.name,
      isAbstract: decl.isAbstract,
      superclass: null,
      implementedInterfaces: [],
      instanceFields: [],
      staticFields: [],
      instanceMethods: [],
      staticMethods: [],
      constructorParams: [],
      constructorDecl: null,
      constructorMangledName: mangleSymbol(
        moduleId,
        `${decl.name.name}__constructor`,
      ),
      vtableGlobalName: `${mangled}__vtable`,
      decl,
      exported: decl.exported,
    });
  }

  // Temporarily expose for resolveAnnotation / superclass resolution within module.
  const prevActive = activeClasses;
  const prevInterfaces = activeInterfaces;
  activeClasses = classes;
  activeInterfaces = interfaces;

  const visiting = new Set<string>();
  const done = new Set<string>();

  const finishClass = (localName: string): ClassDef | null => {
    if (done.has(localName)) {
      return classes.get(localName) ?? null;
    }
    if (visiting.has(localName)) {
      const decl = byLocal.get(localName)!;
      diagnostics.error(
        `Inheritance cycle involving class '${localName}'`,
        decl.name.span,
        "E0350",
      );
      return null;
    }
    visiting.add(localName);
    const decl = byLocal.get(localName)!;
    const mangled = mangleSymbol(moduleId, localName);

    let superclass: ClassDef | null = null;
    if (decl.superclass) {
      if (decl.superclass.namespace) {
        const ns = activeNamespaces.get(decl.superclass.namespace);
        if (!ns || !ns.classes.has(decl.superclass.name)) {
          diagnostics.error(
            `Unknown superclass '${decl.superclass.namespace}.${decl.superclass.name}'`,
            decl.superclass.span,
            "E0104",
          );
          visiting.delete(localName);
          return null;
        }
        superclass = ns.classes.get(decl.superclass.name)!;
      } else if (byLocal.has(decl.superclass.name)) {
        superclass = finishClass(decl.superclass.name);
        if (!superclass) {
          visiting.delete(localName);
          return null;
        }
      } else if (classes.has(decl.superclass.name)) {
        superclass = classes.get(decl.superclass.name)!;
      } else {
        diagnostics.error(
          `Unknown superclass '${decl.superclass.name}'`,
          decl.superclass.span,
          "E0104",
        );
        visiting.delete(localName);
        return null;
      }
    }

    const implementedInterfaces: InterfaceDef[] = [];
    const seenIfaces = new Set<string>();
    for (const ifaceType of decl.implementsTypes) {
      let iface: InterfaceDef | undefined;
      if (ifaceType.namespace) {
        const ns = activeNamespaces.get(ifaceType.namespace);
        iface = ns?.interfaces.get(ifaceType.name);
        if (!iface) {
          diagnostics.error(
            `Unknown interface '${ifaceType.namespace}.${ifaceType.name}'`,
            ifaceType.span,
            "E0104",
          );
          visiting.delete(localName);
          return null;
        }
      } else {
        iface = interfaces.get(ifaceType.name);
        if (!iface) {
          diagnostics.error(
            `Unknown interface '${ifaceType.name}'`,
            ifaceType.span,
            "E0104",
          );
          visiting.delete(localName);
          return null;
        }
      }
      if (seenIfaces.has(iface.name)) {
        diagnostics.error(
          `Duplicate interface '${iface.localName}' in implements list`,
          ifaceType.span,
          "E0329",
        );
        continue;
      }
      seenIfaces.add(iface.name);
      implementedInterfaces.push(iface);
    }

    const instanceFields: ClassFieldDef[] = superclass
      ? [...superclass.instanceFields]
      : [];
    const staticFields: ClassFieldDef[] = [];
    const fieldNames = new Set(instanceFields.map((f) => f.name));
    const staticNames = new Set<string>();
    const methodNames = new Set<string>();

    let constructorDecl: ConstructorDeclaration | null = null;
    const ownMethods: ClassMethod[] = [];
    let ok = true;

    for (const member of decl.members) {
      if (member.kind === "ConstructorDeclaration") {
        if (constructorDecl) {
          diagnostics.error(
            `Duplicate constructor in class '${localName}'`,
            member.span,
            "E0351",
          );
          ok = false;
          continue;
        }
        constructorDecl = member;
        continue;
      }
      if (member.kind === "ClassField") {
        if (member.isStatic) {
          if (
            staticNames.has(member.name.name) ||
            methodNames.has(member.name.name)
          ) {
            diagnostics.error(
              `Duplicate member '${member.name.name}' in class '${localName}'`,
              member.name.span,
              "E0329",
            );
            ok = false;
            continue;
          }
          staticNames.add(member.name.name);
          const fieldType = resolveAnnotation(
            member.typeAnnotation,
            structs,
            enums,
            diagnostics,
          );
          if (fieldType === null) {
            ok = false;
            continue;
          }
          staticFields.push({
            name: member.name.name,
            type: fieldType,
            visibility: member.visibility,
            isReadonly: member.isReadonly,
            isStatic: true,
            declaringClass: mangled,
            fieldIndex: -1,
            initializer: member.initializer,
          });
        } else {
          if (fieldNames.has(member.name.name)) {
            diagnostics.error(
              `Duplicate field '${member.name.name}' in class '${localName}'`,
              member.name.span,
              "E0329",
            );
            ok = false;
            continue;
          }
          if (member.initializer) {
            diagnostics.error(
              "Instance field initializers are not supported; initialize in the constructor",
              member.initializer.span,
              "E0352",
            );
            ok = false;
          }
          fieldNames.add(member.name.name);
          const fieldType = resolveAnnotation(
            member.typeAnnotation,
            structs,
            enums,
            diagnostics,
          );
          if (fieldType === null) {
            ok = false;
            continue;
          }
          instanceFields.push({
            name: member.name.name,
            type: fieldType,
            visibility: member.visibility,
            isReadonly: member.isReadonly,
            isStatic: false,
            declaringClass: mangled,
            fieldIndex: instanceFields.length + 1, // +1 for ObjectHeader
            initializer: null,
          });
        }
        continue;
      }

      // ClassMethod
      if (
        methodNames.has(member.name.name) ||
        staticNames.has(member.name.name)
      ) {
        diagnostics.error(
          `Duplicate member '${member.name.name}' in class '${localName}'`,
          member.name.span,
          "E0329",
        );
        ok = false;
        continue;
      }
      methodNames.add(member.name.name);
      if (member.typeParams.length > 0) {
        if (!validateTypeParamList(member.typeParams, diagnostics)) {
          ok = false;
        }
        // Generic methods are specialized at call sites; skip concrete signature collection.
        continue;
      }
      if (member.isAbstract && !decl.isAbstract) {
        diagnostics.error(
          `Abstract method '${member.name.name}' is only allowed in abstract classes`,
          member.name.span,
          "E0353",
        );
        ok = false;
      }
      if (member.isAbstract && member.isStatic) {
        diagnostics.error(
          `Static method '${member.name.name}' cannot be abstract`,
          member.name.span,
          "E0353",
        );
        ok = false;
      }
      ownMethods.push(member);
    }

    // Re-index instance fields (prefix from base may already have indices).
    for (let i = 0; i < instanceFields.length; i += 1) {
      const f = instanceFields[i]!;
      instanceFields[i] = { ...f, fieldIndex: i + 1 };
    }

    const baseMethods = superclass ? [...superclass.instanceMethods] : [];
    const instanceMethods: ClassMethodDef[] = baseMethods.map((m) => ({
      ...m,
    }));
    const staticMethods: ClassMethodDef[] = [];
    const slotByName = new Map(instanceMethods.map((m, i) => [m.name, i]));

    for (const method of ownMethods) {
      const params: ValueType[] = [];
      let paramsOk = true;
      for (const param of method.params) {
        const paramType = resolveAnnotation(
          param.typeAnnotation,
          structs,
          enums,
          diagnostics,
        );
        if (paramType === null) {
          paramsOk = false;
          continue;
        }
        params.push(paramType);
      }
      const returnType = resolveReturnType(
        method.returnType,
        structs,
        enums,
        diagnostics,
      );
      if (returnType === undefined || !paramsOk) {
        ok = false;
        continue;
      }

      const mangledMethod = mangleSymbol(
        moduleId,
        `${localName}__${method.name.name}`,
      );

      if (method.isStatic) {
        staticMethods.push({
          name: method.name.name,
          mangledName: mangledMethod,
          params,
          returnType,
          visibility: method.visibility,
          isStatic: true,
          isAbstract: false,
          vtableSlot: -1,
          implementingClass: mangled,
          decl: method,
        });
        continue;
      }

      const existingSlot = slotByName.get(method.name.name);
      if (existingSlot !== undefined) {
        const base = instanceMethods[existingSlot]!;
        if (
          base.params.length !== params.length ||
          !base.params.every((p, i) => typesEqual(p, params[i]!)) ||
          (base.returnType === "void") !== (returnType === "void") ||
          (base.returnType !== "void" &&
            returnType !== "void" &&
            !typesEqual(base.returnType, returnType))
        ) {
          diagnostics.error(
            `Method '${method.name.name}' overrides with incompatible signature`,
            method.name.span,
            "E0354",
          );
          ok = false;
          continue;
        }
        instanceMethods[existingSlot] = {
          name: method.name.name,
          mangledName: mangledMethod,
          params,
          returnType,
          visibility: method.visibility,
          isStatic: false,
          isAbstract: method.isAbstract,
          vtableSlot: existingSlot,
          implementingClass: mangled,
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
          visibility: method.visibility,
          isStatic: false,
          isAbstract: method.isAbstract,
          vtableSlot: slot,
          implementingClass: mangled,
          decl: method,
        });
      }
    }

    if (!decl.isAbstract) {
      for (const m of instanceMethods) {
        if (m.isAbstract) {
          diagnostics.error(
            `Non-abstract class '${localName}' must implement abstract method '${m.name}'`,
            decl.name.span,
            "E0355",
          );
          ok = false;
        }
      }
    }

    // Check interface compliance.
    for (const iface of implementedInterfaces) {
      for (const req of iface.methods) {
        const provided = instanceMethods.find((m) => m.name === req.name);
        if (!provided) {
          diagnostics.error(
            `Class '${localName}' does not implement method '${req.name}' required by interface '${iface.localName}'`,
            decl.name.span,
            "E0371",
          );
          ok = false;
          continue;
        }
        if (provided.visibility !== "public") {
          diagnostics.error(
            `Method '${req.name}' implementing interface '${iface.localName}' must be public`,
            provided.decl?.name.span ?? decl.name.span,
            "E0372",
          );
          ok = false;
        }
        if (
          provided.params.length !== req.params.length ||
          !provided.params.every((p, i) => typesEqual(p, req.params[i]!)) ||
          (provided.returnType === "void") !== (req.returnType === "void") ||
          (provided.returnType !== "void" &&
            req.returnType !== "void" &&
            !typesEqual(provided.returnType, req.returnType))
        ) {
          diagnostics.error(
            `Method '${req.name}' has incompatible signature for interface '${iface.localName}'`,
            provided.decl?.name.span ?? decl.name.span,
            "E0372",
          );
          ok = false;
        }
      }
    }

    const constructorParams: ValueType[] = [];
    if (constructorDecl) {
      for (const param of constructorDecl.params) {
        const paramType = resolveAnnotation(
          param.typeAnnotation,
          structs,
          enums,
          diagnostics,
        );
        if (paramType === null) {
          ok = false;
          continue;
        }
        constructorParams.push(paramType);
      }
    } else if (superclass && superclass.constructorParams.length > 0) {
      diagnostics.error(
        `Class '${localName}' must declare a constructor that calls super(...)`,
        decl.name.span,
        "E0356",
      );
      ok = false;
    }

    visiting.delete(localName);
    done.add(localName);

    if (!ok) {
      classes.delete(localName);
      return null;
    }

    const def: ClassDef = {
      name: mangled,
      localName,
      isAbstract: decl.isAbstract,
      superclass,
      implementedInterfaces,
      instanceFields,
      staticFields,
      instanceMethods,
      staticMethods,
      constructorParams,
      constructorDecl,
      constructorMangledName: mangleSymbol(
        moduleId,
        `${localName}__constructor`,
      ),
      vtableGlobalName: `${mangled}__vtable`,
      decl,
      exported: decl.exported,
    };
    classes.set(localName, def);
    classesByMangled.set(mangled, def);
    return def;
  };

  for (const decl of declarations) {
    finishClass(decl.name.name);
  }

  activeClasses = prevActive;
  activeInterfaces = prevInterfaces;
  return classes;
}

export function typeToString(type: ValueType | "void"): string {
  if (type === "void") {
    return "void";
  }
  return advancedTypeToString(type);
}

export function typesEqual(a: ValueType, b: ValueType): boolean {
  return advancedTypesEqual(a, b);
}

/** True if `from` can be assigned to a binding of type `to` (includes class/interface upcasts). */
export function isAssignable(from: ValueType, to: ValueType): boolean {
  return advancedIsAssignable(from, to, baseIsAssignable);
}

function baseIsAssignable(
  from: ExtendedValueType,
  to: ExtendedValueType,
): boolean {
  if (advancedTypesEqual(from, to)) {
    return true;
  }
  if (
    typeof from === "object" &&
    typeof to === "object" &&
    from.kind === "class" &&
    to.kind === "class"
  ) {
    let current: ClassDef | undefined =
      classesByMangled.get(from.name) ?? findClassByMangled(from.name);
    while (current) {
      if (current.name === to.name) {
        return true;
      }
      current = current.superclass ?? undefined;
    }
  }
  if (
    typeof from === "object" &&
    typeof to === "object" &&
    from.kind === "class" &&
    to.kind === "interface"
  ) {
    const cls =
      classesByMangled.get(from.name) ?? findClassByMangled(from.name);
    const iface =
      interfacesByMangled.get(to.name) ?? findInterfaceByMangled(to.name);
    if (cls && iface && classSatisfiesInterface(cls, iface)) {
      return true;
    }
  }
  if (
    typeof from === "object" &&
    typeof to === "object" &&
    from.kind === "interface" &&
    to.kind === "interface"
  ) {
    const fromIface =
      interfacesByMangled.get(from.name) ?? findInterfaceByMangled(from.name);
    if (fromIface && fromIface.baseItableOffsets.has(to.name)) {
      return true;
    }
  }
  // Map / interface with index signature
  if (isMapType(from) && typeof to === "object" && to.kind === "interface") {
    const iface =
      interfacesByMangled.get(to.name) ?? findInterfaceByMangled(to.name);
    if (
      iface?.indexType &&
      advancedIsAssignable(from.valueType, iface.indexType, baseIsAssignable)
    ) {
      return true;
    }
  }
  return false;
}

export {
  typeCategory,
  typeKind,
  isValueCategory,
  isCompileTimeOnlyCategory,
  type TypeCategory,
  type TypeKind,
  type ClassifiableType,
} from "./types/category.js";
export { isReferenceCategory } from "./types/category.js";
import { isReferenceCategory } from "./types/category.js";

export function isArrayType(type: ValueType): type is ArrayValueType {
  return typeof type === "object" && type.kind === "array";
}

export function isTupleType(type: ValueType): type is TupleValueType {
  return typeof type === "object" && type.kind === "tuple";
}

export function isStructType(type: ValueType): type is StructValueType {
  return typeof type === "object" && type.kind === "struct";
}

export function isClassType(type: ValueType): type is ClassValueType {
  return typeof type === "object" && type.kind === "class";
}

/** True when `type` is the builtin Error class or a subclass. */
export function isErrorType(type: ValueType): boolean {
  if (typeof type !== "object" || type.kind !== "class") {
    return false;
  }
  if (type.name === BUILTIN_ERROR_MANGLED) {
    return true;
  }
  let current: ClassDef | undefined =
    classesByMangled.get(type.name) ?? findClassByMangled(type.name);
  while (current) {
    if (current.localName === BUILTIN_ERROR_LOCAL_NAME) {
      return true;
    }
    current = current.superclass ?? undefined;
  }
  return false;
}

export function isThrowableType(type: ValueType): boolean {
  return isErrorType(type);
}

export function isInterfaceType(type: ValueType): type is InterfaceValueType {
  return typeof type === "object" && type.kind === "interface";
}

export function isEnumType(type: ValueType): type is EnumValueType {
  return typeof type === "object" && type.kind === "enum";
}

export function isNumericType(type: ValueType): type is PrimitiveValueType {
  return typeof type === "string" && NUMERIC_PRIMITIVES.has(type);
}

/** Scalars that can be coerced to string via sn_*_to_string for `+`. */
function isStringConcatScalar(type: ValueType): boolean {
  return (
    type === "i32" ||
    type === "i64" ||
    type === "f32" ||
    type === "f64" ||
    type === "bool" ||
    type === "char"
  );
}

function isTemplateConvertible(type: ValueType): boolean {
  if (type === "string") {
    return true;
  }
  if (isStringConcatScalar(type)) {
    return true;
  }
  if (isLiteralType(type)) {
    return (
      type.literalKind === "string" ||
      type.literalKind === "number" ||
      type.literalKind === "boolean"
    );
  }
  if (isEnumType(type)) {
    return true;
  }
  if (isArrayType(type)) {
    return true;
  }
  return false;
}

/** Map / index-signature values must be pointer-sized reference types (runtime void** ABI). */
function assertMapValueType(
  valueType: ValueType,
  span: SourceSpan,
  diagnostics: DiagnosticCollector,
): boolean {
  if (isReferenceCategory(valueType)) {
    return true;
  }
  diagnostics.error(
    `Map values must be reference types (string, class, array, map, or function), got '${typeToString(valueType)}'`,
    span,
    "E0410",
  );
  return false;
}

/** Types accepted by the `print` builtin (matches codegen emitPrintValue). */
function isPrintableType(type: ValueType): boolean {
  if (
    type === "i32" ||
    type === "i64" ||
    type === "f32" ||
    type === "f64" ||
    type === "bool" ||
    type === "char" ||
    type === "string"
  ) {
    return true;
  }
  if (isEnumType(type)) {
    return true;
  }
  if (isLiteralType(type)) {
    return true;
  }
  if (isArrayType(type)) {
    return isPrintableType(type.element as ValueType);
  }
  if (isUnionType(type)) {
    return flattenUnion(type).every((arm) => isPrintableType(arm as ValueType));
  }
  return false;
}

export function isIntegerType(type: ValueType): boolean {
  return type === "i32" || type === "i64";
}

function classSatisfiesInterface(cls: ClassDef, iface: InterfaceDef): boolean {
  let current: ClassDef | null = cls;
  while (current) {
    for (const impl of current.implementedInterfaces) {
      if (impl.name === iface.name || impl.baseItableOffsets.has(iface.name)) {
        return true;
      }
    }
    current = current.superclass;
  }
  return false;
}

/**
 * Convert a type annotation to a value type.
 * Named types become struct or enum types when `namedKinds` is provided.
 * Qualified names use `namespace.name` as the lookup key in `namedKinds`.
 */
export function annotationToValueType(
  ann: TypeAnnotation,
  namedKinds?: ReadonlyMap<string, "struct" | "enum" | "class" | "interface">,
): ValueType | null {
  switch (ann.kind) {
    case "PrimitiveType":
      if (ann.name === "void") {
        return null;
      }
      return ann.name;
    case "NamedType": {
      const key = ann.namespace ? `${ann.namespace}.${ann.name}` : ann.name;
      const kind = namedKinds?.get(key) ?? "struct";
      return { kind, name: key };
    }
    case "ArrayType": {
      const element = annotationToValueType(ann.element, namedKinds);
      if (element === null) {
        return null;
      }
      return { kind: "array", element };
    }
    case "TupleType": {
      const elements: ValueType[] = [];
      for (const el of ann.elements) {
        const vt = annotationToValueType(el, namedKinds);
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
        const vt = annotationToValueType(t, namedKinds);
        if (vt === null) {
          return null;
        }
        arms.push(vt);
      }
      return makeUnion(arms) as ValueType;
    }
    case "IntersectionType": {
      const arms: ValueType[] = [];
      for (const t of ann.types) {
        const vt = annotationToValueType(t, namedKinds);
        if (vt === null) {
          return null;
        }
        arms.push(vt);
      }
      return makeIntersection(arms) as ValueType;
    }
    case "LiteralType":
      return {
        kind: "literal",
        value: ann.value,
        literalKind: ann.literalKind,
      };
    case "ObjectType": {
      const fields = [];
      for (const f of ann.fields) {
        const ft = annotationToValueType(f.typeAnnotation, namedKinds);
        if (ft === null) {
          return null;
        }
        fields.push({ name: f.name.name, type: ft, readonly: f.readonly });
      }
      let indexType: ValueType | null = null;
      if (ann.indexSignature) {
        indexType = annotationToValueType(
          ann.indexSignature.valueType,
          namedKinds,
        );
        if (indexType === null) {
          return null;
        }
      }
      return {
        kind: "object",
        name: objectShapeName(fields, indexType),
        fields,
        indexType,
      };
    }
    case "FunctionType": {
      const params: ValueType[] = [];
      for (const p of ann.params) {
        const vt = annotationToValueType(p, namedKinds);
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
      const returnType = annotationToValueType(ann.returnType, namedKinds);
      if (returnType === null) {
        return null;
      }
      return { kind: "function", params, returnType };
    }
    default:
      return null;
  }
}

function resolveAnnotation(
  ann: TypeAnnotation,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  switch (ann.kind) {
    case "PrimitiveType": {
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
    case "ArrayType": {
      const element = resolveAnnotation(
        ann.element,
        structs,
        enums,
        diagnostics,
      );
      if (element === null) {
        return null;
      }
      return { kind: "array", element };
    }
    case "TupleType": {
      const elements: ValueType[] = [];
      for (const el of ann.elements) {
        const vt = resolveAnnotation(el, structs, enums, diagnostics);
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
        const vt = resolveAnnotation(t, structs, enums, diagnostics);
        if (vt === null) {
          return null;
        }
        arms.push(vt);
      }
      return makeUnion(arms) as ValueType;
    }
    case "IntersectionType": {
      const arms: ValueType[] = [];
      for (const t of ann.types) {
        const vt = resolveAnnotation(t, structs, enums, diagnostics);
        if (vt === null) {
          return null;
        }
        arms.push(vt);
      }
      return makeIntersection(arms) as ValueType;
    }
    case "LiteralType":
      return {
        kind: "literal",
        value: ann.value,
        literalKind: ann.literalKind,
      };
    case "ObjectType":
      return resolveObjectType(ann, structs, enums, diagnostics);
    case "KeyofType": {
      const inner = resolveAnnotation(ann.type, structs, enums, diagnostics);
      if (inner === null) {
        return null;
      }
      // Expand struct/class to object-like for keyof
      const expanded = expandForKeyof(inner, structs);
      const keys = keyofType(expanded ?? inner);
      if (keys === null) {
        diagnostics.error(
          `keyof cannot be applied to type '${typeToString(inner)}'`,
          ann.span,
          "E0391",
        );
        return null;
      }
      return keys as ValueType;
    }
    case "TypeofType": {
      return resolveTypeofType(ann.expression, structs, enums, diagnostics);
    }
    case "ConditionalType": {
      const check = resolveAnnotation(
        ann.checkType,
        structs,
        enums,
        diagnostics,
      );
      const ext = resolveAnnotation(
        ann.extendsType,
        structs,
        enums,
        diagnostics,
      );
      if (check === null || ext === null) {
        return null;
      }
      if (isAssignable(check, ext)) {
        return resolveAnnotation(ann.trueType, structs, enums, diagnostics);
      }
      return resolveAnnotation(ann.falseType, structs, enums, diagnostics);
    }
    case "MappedType": {
      const constraint = resolveAnnotation(
        ann.constraint,
        structs,
        enums,
        diagnostics,
      );
      if (constraint === null) {
        return null;
      }
      const keysType =
        isUnionType(constraint) || isLiteralType(constraint)
          ? constraint
          : keyofType(expandForKeyof(constraint, structs) ?? constraint);
      if (keysType === null) {
        diagnostics.error(
          "Mapped type constraint must yield string keys",
          ann.span,
          "E0392",
        );
        return null;
      }
      const keyLits: string[] = [];
      const collect = (t: ValueType): boolean => {
        if (isLiteralType(t) && t.literalKind === "string") {
          keyLits.push(String(t.value));
          return true;
        }
        if (isUnionType(t)) {
          return t.arms.every((a) => collect(a as ValueType));
        }
        return false;
      };
      if (!collect(keysType as ValueType)) {
        diagnostics.error(
          "Mapped type constraint must be string literal keys",
          ann.span,
          "E0392",
        );
        return null;
      }
      const mapped = expandMappedType(
        keyLits,
        (key) => {
          const prev = activeTypeParams;
          activeTypeParams = new Map(prev);
          activeTypeParams.set(ann.typeParam.name, {
            kind: "typeParam",
            name: ann.typeParam.name,
            constraintName: null,
            constraintKind: null,
            constraintArms: [],
          });
          // Substitute K with literal in value type via temporary: resolve with NamedType K
          // by binding K as a literal through a hack — resolve value with subst
          const subst = new Map([
            [
              ann.typeParam.name,
              {
                kind: "LiteralType" as const,
                value: key,
                literalKind: "string" as const,
                span: ann.span,
              },
            ],
          ]);
          const valueAnn = substituteAnnotation(ann.type, subst);
          const result = resolveAnnotation(
            valueAnn,
            structs,
            enums,
            diagnostics,
          );
          activeTypeParams = prev;
          return result;
        },
        ann.readonly,
      );
      return mapped as ValueType | null;
    }
    case "IndexedAccessType": {
      const obj = resolveAnnotation(
        ann.objectType,
        structs,
        enums,
        diagnostics,
      );
      const idx = resolveAnnotation(ann.indexType, structs, enums, diagnostics);
      if (obj === null || idx === null) {
        return null;
      }
      const result = indexedAccess(expandForKeyof(obj, structs) ?? obj, idx);
      if (result === null) {
        diagnostics.error(
          `Index signature type cannot be resolved for '${typeToString(obj)}[${typeToString(idx)}]'`,
          ann.span,
          "E0393",
        );
        return null;
      }
      return result as ValueType;
    }
    case "FunctionType": {
      const params: ValueType[] = [];
      for (const p of ann.params) {
        const vt = resolveAnnotation(p, structs, enums, diagnostics);
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
      const returnType = resolveAnnotation(
        ann.returnType,
        structs,
        enums,
        diagnostics,
      );
      if (returnType === null) {
        return null;
      }
      return { kind: "function", params, returnType };
    }
    case "NamedType":
      return resolveNamedType(ann, structs, enums, diagnostics);
  }
}

function expandForKeyof(
  type: ValueType,
  structs: Map<string, StructDef>,
): ValueType | null {
  if (isObjectType(type)) {
    return type;
  }
  if (isStructType(type)) {
    const def =
      [...structs.values()].find((s) => s.name === type.name) ??
      [...specializedStructs.values()].find((s) => s.name === type.name) ??
      [...syntheticObjectStructs.values()].find((s) => s.name === type.name);
    if (!def) {
      return null;
    }
    return {
      kind: "object",
      name: type.name,
      fields: def.fields.map((f) => ({
        name: f.name,
        type: f.type,
        readonly: false,
      })),
      indexType: null,
    };
  }
  return null;
}

function resolveObjectType(
  ann: Extract<TypeAnnotation, { kind: "ObjectType" }>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  const fields: { name: string; type: ValueType; readonly: boolean }[] = [];
  for (const f of ann.fields) {
    const ft = resolveAnnotation(f.typeAnnotation, structs, enums, diagnostics);
    if (ft === null) {
      return null;
    }
    fields.push({ name: f.name.name, type: ft, readonly: f.readonly });
  }
  let indexType: ValueType | null = null;
  if (ann.indexSignature) {
    indexType = resolveAnnotation(
      ann.indexSignature.valueType,
      structs,
      enums,
      diagnostics,
    );
    if (indexType === null) {
      return null;
    }
    if (
      !assertMapValueType(
        indexType,
        ann.indexSignature.valueType.span,
        diagnostics,
      )
    ) {
      return null;
    }
  }
  // Pure index signature object → map type
  if (fields.length === 0 && indexType) {
    return { kind: "map", valueType: indexType };
  }
  const name = objectShapeName(fields, indexType);
  const mangled = mangleSymbol(activeModuleId, name);
  if (!syntheticObjectStructs.has(name) && !structs.has(name)) {
    const def: StructDef = {
      name: mangled,
      fields: fields.map((f) => ({ name: f.name, type: f.type })),
      methods: [],
      decl: {
        kind: "StructDeclaration",
        exported: false,
        name: { kind: "Identifier", name, span: ann.span },
        typeParams: [],
        fields: fields.map((f) => ({
          kind: "StructField" as const,
          name: { kind: "Identifier" as const, name: f.name, span: ann.span },
          typeAnnotation: valueTypeToLocalAnnotation(f.type),
          span: ann.span,
        })),
        methods: [],
        span: ann.span,
      },
      exported: false,
    };
    syntheticObjectStructs.set(name, def);
    structs.set(name, def);
  }
  return {
    kind: "object",
    name: mangled,
    fields,
    indexType,
  };
}

function resolveTypeofType(
  expression: Expression,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (
    expression.kind === "CallExpression" &&
    expression.callee.kind === "Identifier"
  ) {
    const sig = activeFunctions.get(expression.callee.name);
    if (!sig) {
      diagnostics.error(
        `Unknown function '${expression.callee.name}' in typeof type query`,
        expression.span,
        "E0394",
      );
      return null;
    }
    if (sig.returnType === "void") {
      diagnostics.error(
        "'typeof' of a void function is not a value type",
        expression.span,
        "E0394",
      );
      return null;
    }
    return sig.returnType;
  }
  if (expression.kind === "Identifier") {
    const sig = activeFunctions.get(expression.name);
    if (sig && sig.returnType !== "void" && sig.params.length === 0) {
      // Bare identifier referring to a zero-arg function type is unusual; treat as error
    }
    diagnostics.error(
      `'typeof ${expression.name}' in a type position only supports call expressions (e.g. typeof foo())`,
      expression.span,
      "E0394",
    );
    return null;
  }
  diagnostics.error(
    "'typeof' type query supports call expressions only",
    expression.span,
    "E0394",
  );
  return null;
}

function resolveNamedType(
  ann: Extract<TypeAnnotation, { kind: "NamedType" }>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  // Type parameter in scope (template body).
  if (
    ann.namespace === null &&
    ann.typeArgs.length === 0 &&
    activeTypeParams.has(ann.name)
  ) {
    return activeTypeParams.get(ann.name)!;
  }

  // Type alias (non-generic)
  if (
    ann.namespace === null &&
    ann.typeArgs.length === 0 &&
    activeTypeAliases.has(ann.name)
  ) {
    return expandTypeAlias(
      activeTypeAliases.get(ann.name)!,
      [],
      structs,
      enums,
      diagnostics,
      ann.span,
    );
  }

  // Generic instantiation: Foo<T, U>
  if (ann.typeArgs.length > 0) {
    return resolveGenericNamedType(ann, structs, enums, diagnostics);
  }

  if (ann.namespace) {
    const ns = activeNamespaces.get(ann.namespace);
    if (!ns) {
      diagnostics.error(
        `Unknown namespace '${ann.namespace}'`,
        ann.span,
        "E0406",
      );
      return null;
    }
    if (ns.typeAliases.has(ann.name)) {
      return expandTypeAlias(
        ns.typeAliases.get(ann.name)!,
        [],
        structs,
        enums,
        diagnostics,
        ann.span,
      );
    }
    if (ns.enums.has(ann.name)) {
      return { kind: "enum", name: ns.enums.get(ann.name)!.name };
    }
    if (ns.structs.has(ann.name)) {
      return { kind: "struct", name: ns.structs.get(ann.name)!.name };
    }
    if (ns.classes.has(ann.name)) {
      return { kind: "class", name: ns.classes.get(ann.name)!.name };
    }
    if (ns.interfaces.has(ann.name)) {
      const iface = ns.interfaces.get(ann.name)!;
      if (iface.indexType && iface.methods.length === 0) {
        return { kind: "map", valueType: iface.indexType };
      }
      return { kind: "interface", name: iface.name };
    }
    diagnostics.error(
      `Unknown type '${ann.namespace}.${ann.name}'`,
      ann.span,
      "E0104",
    );
    return null;
  }
  if (enums.has(ann.name)) {
    return { kind: "enum", name: enums.get(ann.name)!.name };
  }
  if (structs.has(ann.name)) {
    return { kind: "struct", name: structs.get(ann.name)!.name };
  }
  if (specializedStructs.has(ann.name)) {
    return { kind: "struct", name: specializedStructs.get(ann.name)!.name };
  }
  if (syntheticObjectStructs.has(ann.name)) {
    return {
      kind: "object",
      name: syntheticObjectStructs.get(ann.name)!.name,
      fields: syntheticObjectStructs
        .get(ann.name)!
        .fields.map((f) => ({ name: f.name, type: f.type, readonly: false })),
      indexType: null,
    };
  }
  if (activeClasses.has(ann.name)) {
    return { kind: "class", name: activeClasses.get(ann.name)!.name };
  }
  if (specializedClasses.has(ann.name)) {
    return { kind: "class", name: specializedClasses.get(ann.name)!.name };
  }
  if (activeInterfaces.has(ann.name)) {
    const iface = activeInterfaces.get(ann.name)!;
    if (iface.indexType && iface.methods.length === 0) {
      return { kind: "map", valueType: iface.indexType };
    }
    return { kind: "interface", name: iface.name };
  }
  if (specializedInterfaces.has(ann.name)) {
    return {
      kind: "interface",
      name: specializedInterfaces.get(ann.name)!.name,
    };
  }
  if (
    activeGenericStructs.has(ann.name) ||
    activeGenericClasses.has(ann.name) ||
    activeGenericInterfaces.has(ann.name) ||
    activeGenericTypeAliases.has(ann.name)
  ) {
    diagnostics.error(
      `Generic type '${ann.name}' requires type arguments`,
      ann.span,
      "E0382",
    );
    return null;
  }
  diagnostics.error(`Unknown type '${ann.name}'`, ann.span, "E0104");
  return null;
}

function expandTypeAlias(
  alias: TypeAliasDef,
  typeArgs: TypeAnnotation[],
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  span: SourceSpan,
): ValueType | null {
  const key = `${alias.localName}<${typeArgs.length}>`;
  if (aliasExpandStack.includes(alias.localName)) {
    diagnostics.error(
      `Circular type alias '${alias.localName}'`,
      span,
      "E0395",
    );
    return null;
  }
  aliasExpandStack.push(alias.localName);
  const decl = alias.decl;
  if (decl.typeParams.length !== typeArgs.length) {
    diagnostics.error(
      `Type alias '${alias.localName}' expects ${decl.typeParams.length} type argument(s), got ${typeArgs.length}`,
      span,
      "E0381",
    );
    aliasExpandStack.pop();
    return null;
  }
  const subst = buildSubst(decl.typeParams, typeArgs);
  const expanded = substituteAnnotation(decl.type, subst);
  const result = resolveAnnotation(expanded, structs, enums, diagnostics);
  aliasExpandStack.pop();
  void key;
  return result;
}

function resolveGenericNamedType(
  ann: Extract<TypeAnnotation, { kind: "NamedType" }>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  const resolvedArgs: TypeAnnotation[] = [];
  for (const arg of ann.typeArgs) {
    const vt = resolveAnnotation(arg, structs, enums, diagnostics);
    if (vt === null) {
      return null;
    }
    resolvedArgs.push(
      arg.kind === "NamedType" && activeTypeParams.has(arg.name)
        ? valueTypeToLocalAnnotation(vt)
        : arg,
    );
  }

  // Generic type alias
  if (activeGenericTypeAliases.has(ann.name)) {
    const decl = activeGenericTypeAliases.get(ann.name)!;
    const aliasDef: TypeAliasDef = {
      name: mangleSymbol(activeModuleId, ann.name),
      localName: ann.name,
      decl,
      exported: decl.exported,
    };
    return expandTypeAlias(
      aliasDef,
      resolvedArgs,
      structs,
      enums,
      diagnostics,
      ann.span,
    );
  }

  const structTpl = activeGenericStructs.get(ann.name);
  if (structTpl) {
    return instantiateGenericStruct(
      structTpl,
      resolvedArgs,
      ann.span,
      structs,
      enums,
      diagnostics,
    );
  }
  const classTpl = activeGenericClasses.get(ann.name);
  if (classTpl) {
    return instantiateGenericClass(
      classTpl,
      resolvedArgs,
      ann.span,
      structs,
      enums,
      diagnostics,
    );
  }
  const ifaceTpl = activeGenericInterfaces.get(ann.name);
  if (ifaceTpl) {
    return instantiateGenericInterface(
      ifaceTpl,
      resolvedArgs,
      ann.span,
      structs,
      enums,
      diagnostics,
    );
  }

  diagnostics.error(`Unknown generic type '${ann.name}'`, ann.span, "E0104");
  return null;
}

function resolveReturnType(
  ann: TypeAnnotation,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ReturnType | undefined {
  if (ann.kind === "PrimitiveType" && ann.name === "void") {
    return "void";
  }
  const value = resolveAnnotation(ann, structs, enums, diagnostics);
  if (value === null) {
    return undefined;
  }
  return value;
}

function bindTypeParams(
  typeParams: readonly TypeParameter[],
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): Map<string, TypeParamValueType> | null {
  const map = new Map<string, TypeParamValueType>();
  for (const tp of typeParams) {
    let constraintName: string | null = null;
    let constraintKind: "interface" | "class" | null = null;
    const constraintArms: { kind: "interface" | "class"; name: string }[] = [];
    if (tp.constraint) {
      const c = resolveAnnotation(tp.constraint, structs, enums, diagnostics);
      if (c === null) {
        return null;
      }
      if (isInterfaceType(c)) {
        constraintName = c.name;
        constraintKind = "interface";
        constraintArms.push({ kind: "interface", name: c.name });
      } else if (isClassType(c)) {
        constraintName = c.name;
        constraintKind = "class";
        constraintArms.push({ kind: "class", name: c.name });
      } else if (isIntersectionType(c)) {
        for (const arm of c.arms) {
          if (typeof arm === "object" && arm.kind === "interface") {
            constraintArms.push({ kind: "interface", name: arm.name });
          } else if (typeof arm === "object" && arm.kind === "class") {
            constraintArms.push({ kind: "class", name: arm.name });
          } else if (!(typeof arm === "object" && arm.kind === "object")) {
            diagnostics.error(
              `Type parameter constraint intersection arms must be classes, interfaces, or object types`,
              tp.constraint.span,
              "E0383",
            );
            return null;
          }
        }
        if (constraintArms.length === 1) {
          constraintName = constraintArms[0]!.name;
          constraintKind = constraintArms[0]!.kind;
        }
      } else if (isObjectType(c)) {
        // Structural constraint OK
      } else {
        diagnostics.error(
          `Type parameter constraint must be a class, interface, intersection, or object type`,
          tp.constraint.span,
          "E0383",
        );
        return null;
      }
    }
    map.set(tp.name.name, {
      kind: "typeParam",
      name: tp.name.name,
      constraintName,
      constraintKind,
      constraintArms,
    });
  }
  return map;
}

function checkConstraints(
  typeParams: readonly TypeParameter[],
  typeArgs: readonly TypeAnnotation[],
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  span: SourceSpan,
): boolean {
  for (let i = 0; i < typeParams.length; i += 1) {
    const tp = typeParams[i]!;
    if (!tp.constraint) {
      continue;
    }
    const argType = resolveAnnotation(
      typeArgs[i]!,
      structs,
      enums,
      diagnostics,
    );
    const constraintType = resolveAnnotation(
      tp.constraint,
      structs,
      enums,
      diagnostics,
    );
    if (argType === null || constraintType === null) {
      return false;
    }
    if (!isAssignable(argType, constraintType)) {
      diagnostics.error(
        `Type '${typeToString(argType)}' does not satisfy constraint '${typeToString(constraintType)}'`,
        span,
        "E0384",
      );
      return false;
    }
  }
  return true;
}

function instantiateGenericStruct(
  tpl: GenericStructTemplate,
  typeArgs: TypeAnnotation[],
  span: SourceSpan,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (
    !checkTypeArgArity(
      tpl.decl.name.name,
      tpl.decl.typeParams,
      typeArgs,
      span,
      diagnostics,
    )
  ) {
    return null;
  }
  if (
    !checkConstraints(
      tpl.decl.typeParams,
      typeArgs,
      structs,
      enums,
      diagnostics,
      span,
    )
  ) {
    return null;
  }
  const instanceLocal = mangleInstance(tpl.decl.name.name, typeArgs);
  instantiationCollector.typeRewrites.set(span.start.offset, instanceLocal);
  instantiationCollector.add({
    kind: "struct",
    instanceLocalName: instanceLocal,
    moduleId: tpl.moduleId,
    modulePath: tpl.modulePath,
    templateLocalName: tpl.decl.name.name,
    typeArgs,
  });

  if (specializedStructs.has(instanceLocal)) {
    return {
      kind: "struct",
      name: specializedStructs.get(instanceLocal)!.name,
    };
  }

  const prev = activeTypeParams;
  activeTypeParams = new Map();
  const fields: StructFieldDef[] = [];
  const methods: StructMethodDef[] = [];
  const subst = buildSubst(tpl.decl.typeParams, typeArgs);
  const specializedDecl = specializeStructDecl(tpl.decl, instanceLocal, subst);

  for (const field of specializedDecl.fields) {
    const fieldType = resolveAnnotation(
      field.typeAnnotation,
      structs,
      enums,
      diagnostics,
    );
    if (fieldType === null) {
      activeTypeParams = prev;
      return null;
    }
    fields.push({ name: field.name.name, type: fieldType });
  }
  for (const method of specializedDecl.methods) {
    if (method.typeParams.length > 0) {
      continue;
    }
    const params: ValueType[] = [];
    for (const param of method.params) {
      const pt = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (pt === null) {
        activeTypeParams = prev;
        return null;
      }
      params.push(pt);
    }
    const returnType = resolveReturnType(
      method.returnType,
      structs,
      enums,
      diagnostics,
    );
    if (returnType === undefined) {
      activeTypeParams = prev;
      return null;
    }
    methods.push({
      name: method.name.name,
      mangledName: mangleSymbol(
        tpl.moduleId,
        `${instanceLocal}__${method.name.name}`,
      ),
      params,
      returnType,
      decl: method,
    });
  }
  activeTypeParams = prev;

  const def: StructDef = {
    name: mangleSymbol(tpl.moduleId, instanceLocal),
    fields,
    methods,
    decl: specializedDecl,
    exported: tpl.decl.exported,
  };
  specializedStructs.set(instanceLocal, def);
  structs.set(instanceLocal, def);
  return { kind: "struct", name: def.name };
}

function instantiateGenericClass(
  tpl: GenericClassTemplate,
  typeArgs: TypeAnnotation[],
  span: SourceSpan,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (
    !checkTypeArgArity(
      tpl.decl.name.name,
      tpl.decl.typeParams,
      typeArgs,
      span,
      diagnostics,
    )
  ) {
    return null;
  }
  if (
    !checkConstraints(
      tpl.decl.typeParams,
      typeArgs,
      structs,
      enums,
      diagnostics,
      span,
    )
  ) {
    return null;
  }
  const instanceLocal = mangleInstance(tpl.decl.name.name, typeArgs);
  instantiationCollector.typeRewrites.set(span.start.offset, instanceLocal);
  instantiationCollector.add({
    kind: "class",
    instanceLocalName: instanceLocal,
    moduleId: tpl.moduleId,
    modulePath: tpl.modulePath,
    templateLocalName: tpl.decl.name.name,
    typeArgs,
  });

  if (specializedClasses.has(instanceLocal)) {
    return { kind: "class", name: specializedClasses.get(instanceLocal)!.name };
  }

  // Build a minimal ClassDef for typechecking (fields/methods with substituted types).
  const subst = new Map<string, TypeAnnotation>();
  for (let i = 0; i < tpl.decl.typeParams.length; i += 1) {
    subst.set(tpl.decl.typeParams[i]!.name.name, typeArgs[i]!);
  }
  const sub = (ann: TypeAnnotation): TypeAnnotation =>
    substituteAnnotation(ann, subst);

  const instanceFields: ClassFieldDef[] = [];
  const staticFields: ClassFieldDef[] = [];
  const instanceMethods: ClassMethodDef[] = [];
  const staticMethods: ClassMethodDef[] = [];
  let fieldIndex = 1;
  let constructorParams: ValueType[] = [];
  let constructorDecl: ConstructorDeclaration | null = null;

  for (const member of tpl.decl.members) {
    if (member.kind === "ClassField") {
      const fieldType = resolveAnnotation(
        sub(member.typeAnnotation),
        structs,
        enums,
        diagnostics,
      );
      if (fieldType === null) {
        return null;
      }
      const fieldDef: ClassFieldDef = {
        name: member.name.name,
        type: fieldType,
        visibility: member.visibility,
        isReadonly: member.isReadonly,
        isStatic: member.isStatic,
        declaringClass: mangleSymbol(tpl.moduleId, instanceLocal),
        fieldIndex: member.isStatic ? -1 : fieldIndex++,
        initializer: member.initializer,
      };
      if (member.isStatic) {
        staticFields.push(fieldDef);
      } else {
        instanceFields.push(fieldDef);
      }
    } else if (member.kind === "ConstructorDeclaration") {
      constructorDecl = member;
      constructorParams = [];
      for (const p of member.params) {
        const pt = resolveAnnotation(
          sub(p.typeAnnotation),
          structs,
          enums,
          diagnostics,
        );
        if (pt === null) {
          return null;
        }
        constructorParams.push(pt);
      }
    } else if (
      member.kind === "ClassMethod" &&
      member.typeParams.length === 0
    ) {
      const params: ValueType[] = [];
      for (const p of member.params) {
        const pt = resolveAnnotation(
          sub(p.typeAnnotation),
          structs,
          enums,
          diagnostics,
        );
        if (pt === null) {
          return null;
        }
        params.push(pt);
      }
      const returnType = resolveReturnType(
        sub(member.returnType),
        structs,
        enums,
        diagnostics,
      );
      if (returnType === undefined) {
        return null;
      }
      const methodDef: ClassMethodDef = {
        name: member.name.name,
        mangledName: mangleSymbol(
          tpl.moduleId,
          `${instanceLocal}__${member.name.name}`,
        ),
        params,
        returnType,
        visibility: member.visibility,
        isStatic: member.isStatic,
        isAbstract: member.isAbstract,
        vtableSlot: member.isStatic ? -1 : instanceMethods.length,
        implementingClass: mangleSymbol(tpl.moduleId, instanceLocal),
        decl: member,
      };
      if (member.isStatic) {
        staticMethods.push(methodDef);
      } else {
        instanceMethods.push(methodDef);
      }
    }
  }

  const def: ClassDef = {
    name: mangleSymbol(tpl.moduleId, instanceLocal),
    localName: instanceLocal,
    isAbstract: tpl.decl.isAbstract,
    superclass: null,
    implementedInterfaces: [],
    instanceFields,
    staticFields,
    instanceMethods,
    staticMethods,
    constructorParams,
    constructorDecl,
    constructorMangledName: mangleSymbol(
      tpl.moduleId,
      `${instanceLocal}__constructor`,
    ),
    vtableGlobalName: `${mangleSymbol(tpl.moduleId, instanceLocal)}__vtable`,
    decl: tpl.decl,
    exported: tpl.decl.exported,
  };
  specializedClasses.set(instanceLocal, def);
  activeClasses.set(instanceLocal, def);
  classesByMangled.set(def.name, def);
  return { kind: "class", name: def.name };
}

function instantiateGenericInterface(
  tpl: GenericInterfaceTemplate,
  typeArgs: TypeAnnotation[],
  span: SourceSpan,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (
    !checkTypeArgArity(
      tpl.decl.name.name,
      tpl.decl.typeParams,
      typeArgs,
      span,
      diagnostics,
    )
  ) {
    return null;
  }
  if (
    !checkConstraints(
      tpl.decl.typeParams,
      typeArgs,
      structs,
      enums,
      diagnostics,
      span,
    )
  ) {
    return null;
  }
  const instanceLocal = mangleInstance(tpl.decl.name.name, typeArgs);
  instantiationCollector.typeRewrites.set(span.start.offset, instanceLocal);
  instantiationCollector.add({
    kind: "interface",
    instanceLocalName: instanceLocal,
    moduleId: tpl.moduleId,
    modulePath: tpl.modulePath,
    templateLocalName: tpl.decl.name.name,
    typeArgs,
  });

  if (specializedInterfaces.has(instanceLocal)) {
    return {
      kind: "interface",
      name: specializedInterfaces.get(instanceLocal)!.name,
    };
  }

  const subst = new Map<string, TypeAnnotation>();
  for (let i = 0; i < tpl.decl.typeParams.length; i += 1) {
    subst.set(tpl.decl.typeParams[i]!.name.name, typeArgs[i]!);
  }
  const sub = (ann: TypeAnnotation): TypeAnnotation =>
    substituteAnnotation(ann, subst);

  const methods: InterfaceMethodDef[] = [];
  for (const method of tpl.decl.methods) {
    const params: ValueType[] = [];
    for (const p of method.params) {
      const pt = resolveAnnotation(
        sub(p.typeAnnotation),
        structs,
        enums,
        diagnostics,
      );
      if (pt === null) {
        return null;
      }
      params.push(pt);
    }
    const returnType = resolveReturnType(
      sub(method.returnType),
      structs,
      enums,
      diagnostics,
    );
    if (returnType === undefined) {
      return null;
    }
    methods.push({
      name: method.name.name,
      params,
      returnType,
      itableSlot: methods.length,
    });
  }

  const mangled = mangleSymbol(tpl.moduleId, instanceLocal);
  let indexType: ValueType | null = null;
  if (tpl.decl.indexSignature) {
    const substMap = buildSubst(tpl.decl.typeParams, typeArgs);
    const valueAnn = substituteAnnotation(
      tpl.decl.indexSignature.valueType,
      substMap,
    );
    indexType = resolveAnnotation(valueAnn, structs, enums, diagnostics);
  }
  const def: InterfaceDef = {
    name: mangled,
    localName: instanceLocal,
    bases: [],
    methods,
    baseItableOffsets: new Map([[mangled, 0]]),
    indexType,
    decl: {
      ...tpl.decl,
      name: {
        kind: "Identifier",
        name: instanceLocal,
        span: tpl.decl.name.span,
      },
      typeParams: [],
    },
    exported: tpl.decl.exported,
  };
  specializedInterfaces.set(instanceLocal, def);
  activeInterfaces.set(instanceLocal, def);
  interfacesByMangled.set(mangled, def);
  return { kind: "interface", name: def.name };
}

function checkGenericFunctionTemplate(
  fn: FunctionDeclaration,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  const bound = bindTypeParams(fn.typeParams, structs, enums, diagnostics);
  if (!bound) {
    return;
  }
  const prev = activeTypeParams;
  activeTypeParams = bound;
  checkFunction(fn, functions, structs, enums, diagnostics);
  activeTypeParams = prev;
}

function checkGenericStructTemplate(
  decl: StructDeclaration,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  const bound = bindTypeParams(decl.typeParams, structs, enums, diagnostics);
  if (!bound) {
    return;
  }
  const prev = activeTypeParams;
  activeTypeParams = bound;
  // Resolve field types under type params to validate.
  for (const field of decl.fields) {
    resolveAnnotation(field.typeAnnotation, structs, enums, diagnostics);
  }
  for (const method of decl.methods) {
    if (method.typeParams.length > 0) {
      const methodBound = bindTypeParams(
        method.typeParams,
        structs,
        enums,
        diagnostics,
      );
      if (!methodBound) {
        continue;
      }
      activeTypeParams = new Map([...bound, ...methodBound]);
    }
    for (const p of method.params) {
      resolveAnnotation(p.typeAnnotation, structs, enums, diagnostics);
    }
    resolveReturnType(method.returnType, structs, enums, diagnostics);
    const scope = new Map<string, Binding>();
    for (const p of method.params) {
      const pt = resolveAnnotation(
        p.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (pt) {
        scope.set(p.name.name, { type: pt, mutable: false });
      }
    }
    const returnType = resolveReturnType(
      method.returnType,
      structs,
      enums,
      diagnostics,
    );
    if (returnType !== undefined) {
      memberContext = {
        thisType: {
          kind: "typeParam",
          name: "Self",
          constraintName: null,
          constraintKind: null,
          constraintArms: [],
        },
        enclosingClass: null,
        enclosingStruct: null,
        isConstructor: false,
        isStatic: false,
      };
      // Use a synthetic struct this-type via type param — for template check, bind this as opaque.
      // Better: treat this as having the template's fields. Skip full this checking for MVP of methods.
      for (const stmt of method.body) {
        checkStatement(
          stmt,
          scope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          0,
          0,
        );
      }
    }
    activeTypeParams = bound;
  }
  memberContext = null;
  activeTypeParams = prev;
}

function checkGenericClassTemplate(
  decl: ClassDeclaration,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  const bound = bindTypeParams(decl.typeParams, structs, enums, diagnostics);
  if (!bound) {
    return;
  }
  const prev = activeTypeParams;
  activeTypeParams = bound;
  for (const member of decl.members) {
    if (member.kind === "ClassField") {
      resolveAnnotation(member.typeAnnotation, structs, enums, diagnostics);
    } else if (member.kind === "ConstructorDeclaration") {
      for (const p of member.params) {
        resolveAnnotation(p.typeAnnotation, structs, enums, diagnostics);
      }
    } else if (member.kind === "ClassMethod") {
      let methodParams = bound;
      if (member.typeParams.length > 0) {
        const mb = bindTypeParams(
          member.typeParams,
          structs,
          enums,
          diagnostics,
        );
        if (mb) {
          methodParams = new Map([...bound, ...mb]);
        }
      }
      activeTypeParams = methodParams;
      for (const p of member.params) {
        resolveAnnotation(p.typeAnnotation, structs, enums, diagnostics);
      }
      resolveReturnType(member.returnType, structs, enums, diagnostics);
      activeTypeParams = bound;
    }
  }
  activeTypeParams = prev;
}

function localNameFromMangled(mangled: string): string {
  if (activeModuleId !== "" && mangled.startsWith(`${activeModuleId}__`)) {
    return mangled.slice(activeModuleId.length + 2);
  }
  return mangled;
}

/**
 * Convert a value type to a type annotation using local (un-module-mangled) names
 * so resolveAnnotation / monomorphize mangling work under compileFile.
 */
function valueTypeToLocalAnnotation(type: ValueType): TypeAnnotation {
  const span = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };
  if (typeof type === "string") {
    return valueTypeToAnnotation(type);
  }
  switch (type.kind) {
    case "array":
      return {
        kind: "ArrayType",
        element: valueTypeToLocalAnnotation(type.element),
        span,
      };
    case "tuple":
      return {
        kind: "TupleType",
        elements: type.elements.map((e) => valueTypeToLocalAnnotation(e)),
        span,
      };
    case "typeParam":
      return valueTypeToAnnotation(type);
    case "union":
      return {
        kind: "UnionType",
        types: type.arms.map((a) => valueTypeToLocalAnnotation(a as ValueType)),
        span,
      };
    case "intersection":
      return {
        kind: "IntersectionType",
        types: type.arms.map((a) => valueTypeToLocalAnnotation(a as ValueType)),
        span,
      };
    case "literal":
      return {
        kind: "LiteralType",
        value: type.value,
        literalKind: type.literalKind,
        span,
      };
    case "object":
      return {
        kind: "ObjectType",
        fields: type.fields.map((f) => ({
          kind: "ObjectTypeField" as const,
          readonly: f.readonly,
          name: { kind: "Identifier" as const, name: f.name, span },
          typeAnnotation: valueTypeToLocalAnnotation(f.type as ValueType),
          span,
        })),
        indexSignature: type.indexType
          ? {
              kind: "ObjectIndexSignature" as const,
              keyName: { kind: "Identifier" as const, name: "key", span },
              keyType: {
                kind: "PrimitiveType" as const,
                name: "string" as const,
                span,
              },
              valueType: valueTypeToLocalAnnotation(
                type.indexType as ValueType,
              ),
              span,
            }
          : null,
        span,
      };
    case "map":
      return {
        kind: "ObjectType",
        fields: [],
        indexSignature: {
          kind: "ObjectIndexSignature",
          keyName: { kind: "Identifier", name: "key", span },
          keyType: { kind: "PrimitiveType", name: "string", span },
          valueType: valueTypeToLocalAnnotation(type.valueType as ValueType),
          span,
        },
        span,
      };
    case "class": {
      const cls =
        classesByMangled.get(type.name) ??
        findClassByMangled(type.name) ??
        specializedClasses.get(localNameFromMangled(type.name));
      const local = cls?.localName ?? localNameFromMangled(type.name);
      return {
        kind: "NamedType",
        namespace: null,
        name: local,
        typeArgs: [],
        span,
      };
    }
    case "interface": {
      const iface =
        interfacesByMangled.get(type.name) ??
        findInterfaceByMangled(type.name) ??
        specializedInterfaces.get(localNameFromMangled(type.name));
      const local = iface?.localName ?? localNameFromMangled(type.name);
      return {
        kind: "NamedType",
        namespace: null,
        name: local,
        typeArgs: [],
        span,
      };
    }
    case "struct": {
      const local = localNameFromMangled(type.name);
      const def =
        specializedStructs.get(local) ??
        [...specializedStructs.values()].find((d) => d.name === type.name);
      const name = def?.decl.name.name ?? local;
      return { kind: "NamedType", namespace: null, name, typeArgs: [], span };
    }
    case "enum":
      return {
        kind: "NamedType",
        namespace: null,
        name: localNameFromMangled(type.name),
        typeArgs: [],
        span,
      };
    case "function": {
      const returnAnn =
        type.returnType === "void"
          ? ({ kind: "PrimitiveType", name: "void", span } as const)
          : valueTypeToLocalAnnotation(type.returnType as ValueType);
      return {
        kind: "FunctionType",
        params: type.params.map((p) =>
          valueTypeToLocalAnnotation(p as ValueType),
        ),
        returnType: returnAnn,
        span,
      };
    }
  }
}

function inferTypeArgs(
  typeParams: readonly TypeParameter[],
  paramAnns: readonly TypeAnnotation[],
  argTypes: readonly ValueType[],
): TypeAnnotation[] | null {
  const partial = inferTypeArgsPartial(typeParams, paramAnns, argTypes);
  if (!partial) {
    return null;
  }
  if (partial.some((a) => a === null)) {
    return null;
  }
  return partial as TypeAnnotation[];
}

/** Like inferTypeArgs but allows unsolved params as null slots. */
function inferTypeArgsPartial(
  typeParams: readonly TypeParameter[],
  paramAnns: readonly TypeAnnotation[],
  argTypes: readonly ValueType[],
): (TypeAnnotation | null)[] | null {
  const solutions = new Map<string, ValueType>();
  const unify = (ann: TypeAnnotation, concrete: ValueType): boolean => {
    if (ann.kind === "PrimitiveType") {
      return typeof concrete === "string" && concrete === ann.name;
    }
    if (ann.kind === "ArrayType") {
      if (typeof concrete !== "object" || concrete.kind !== "array") {
        return false;
      }
      return unify(ann.element, concrete.element);
    }
    if (ann.kind === "FunctionType") {
      if (typeof concrete !== "object" || concrete.kind !== "function") {
        return false;
      }
      if (ann.params.length !== concrete.params.length) {
        return false;
      }
      for (let i = 0; i < ann.params.length; i += 1) {
        if (!unify(ann.params[i]!, concrete.params[i]! as ValueType)) {
          return false;
        }
      }
      if (
        ann.returnType.kind === "PrimitiveType" &&
        ann.returnType.name === "void"
      ) {
        return concrete.returnType === "void";
      }
      if (concrete.returnType === "void") {
        return false;
      }
      return unify(ann.returnType, concrete.returnType as ValueType);
    }
    if (
      ann.kind === "NamedType" &&
      ann.namespace === null &&
      ann.typeArgs.length === 0
    ) {
      const isParam = typeParams.some((tp) => tp.name.name === ann.name);
      if (isParam) {
        const existing = solutions.get(ann.name);
        if (existing && !typesEqual(existing, concrete)) {
          return false;
        }
        solutions.set(ann.name, concrete);
        return true;
      }
    }
    return true;
  };

  for (let i = 0; i < paramAnns.length; i += 1) {
    if (!unify(paramAnns[i]!, argTypes[i]!)) {
      return null;
    }
  }
  return typeParams.map((tp) => {
    const sol = solutions.get(tp.name.name);
    return sol ? valueTypeToLocalAnnotation(sol) : null;
  });
}

function checkGenericFunctionCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  tpl: GenericFunctionTemplate,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
  expectedType: ValueType | null,
): ValueType | null {
  const mapped = mapCallArgumentsToSlots(
    expr.args,
    "function",
    tpl.decl.name.name,
    tpl.decl.params,
    expr.span,
    diagnostics,
  );
  if (!mapped) {
    return null;
  }

  const providedAnns: TypeAnnotation[] = [];
  const providedTypes: ValueType[] = [];
  for (let i = 0; i < tpl.decl.params.length; i += 1) {
    const slot = mapped.slots[i];
    if (slot === undefined) {
      continue;
    }
    const t = checkExpression(
      slot,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    );
    if (!t) {
      return null;
    }
    providedAnns.push(tpl.decl.params[i]!.typeAnnotation);
    providedTypes.push(t);
  }

  let typeArgs = expr.typeArgs;
  if (typeArgs.length === 0) {
    const inferred = inferTypeArgs(
      tpl.decl.typeParams,
      providedAnns,
      providedTypes,
    );
    if (!inferred && expectedType && tpl.decl.returnType.kind === "NamedType") {
      const fromReturn = inferTypeArgs(
        tpl.decl.typeParams,
        [tpl.decl.returnType],
        [expectedType],
      );
      if (fromReturn) {
        typeArgs = fromReturn;
      }
    } else if (inferred) {
      typeArgs = inferred;
    }
  }

  if (typeArgs.length === 0) {
    diagnostics.error(
      `Cannot infer type arguments for '${tpl.decl.name.name}'`,
      expr.span,
      "E0385",
    );
    return null;
  }
  if (
    !checkTypeArgArity(
      tpl.decl.name.name,
      tpl.decl.typeParams,
      typeArgs,
      expr.span,
      diagnostics,
    )
  ) {
    return null;
  }

  // Resolve type args; if any remain type params, we're checking a template body — don't mono yet.
  const resolvedArgTypes: ValueType[] = [];
  let hasTypeParamArg = false;
  for (const arg of typeArgs) {
    const vt = resolveAnnotation(arg, structs, enums, diagnostics);
    if (vt === null) {
      return null;
    }
    if (typeof vt === "object" && vt.kind === "typeParam") {
      hasTypeParamArg = true;
    }
    resolvedArgTypes.push(vt);
  }

  if (!hasTypeParamArg) {
    if (
      !checkConstraints(
        tpl.decl.typeParams,
        typeArgs,
        structs,
        enums,
        diagnostics,
        expr.span,
      )
    ) {
      return null;
    }
    if (!tpl.decl.isExtern) {
      const instanceLocal = mangleFunctionInstance(
        tpl.decl.name.name,
        typeArgs,
      );
      instantiationCollector.callRewrites.set(
        expr.span.start.offset,
        instanceLocal,
      );
      instantiationCollector.add({
        kind: "function",
        instanceLocalName: instanceLocal,
        moduleId: tpl.moduleId,
        modulePath: tpl.modulePath,
        templateLocalName: tpl.decl.name.name,
        typeArgs,
      });
    }
  }

  const subst = new Map<string, TypeAnnotation>();
  for (let i = 0; i < tpl.decl.typeParams.length; i += 1) {
    subst.set(tpl.decl.typeParams[i]!.name.name, typeArgs[i]!);
  }
  const sub = (ann: TypeAnnotation): TypeAnnotation =>
    substituteAnnotation(ann, subst);

  const paramTypes: ValueType[] = [];
  for (const param of tpl.decl.params) {
    const expected = resolveAnnotation(
      sub(param.typeAnnotation),
      structs,
      enums,
      diagnostics,
    );
    if (expected === null) {
      return null;
    }
    paramTypes.push(expected);
  }

  if (
    !checkDeclarationCallArgs(
      expr,
      "function",
      tpl.decl.name.name,
      tpl.decl.params,
      paramTypes,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
      (defaultExpr) => substituteExpression(defaultExpr, subst),
    )
  ) {
    return null;
  }

  const returnType = resolveReturnType(
    sub(tpl.decl.returnType),
    structs,
    enums,
    diagnostics,
  );
  if (returnType === undefined) {
    return null;
  }
  if (returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(
        `Void function '${tpl.decl.name.name}' cannot be used as a value`,
        expr.span,
        "E0309",
      );
    }
    return null;
  }
  void resolvedArgTypes;
  return returnType;
}

function checkFunction(
  fn: FunctionDeclaration,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  if (fn.isExtern || !fn.body) {
    return;
  }

  const scope = new Map<string, Binding>();
  const returnType = resolveReturnType(
    fn.returnType,
    structs,
    enums,
    diagnostics,
  );
  if (returnType === undefined) {
    return;
  }

  const isExtension = fn.params[0]?.isReceiver === true;
  const prevMemberContext = memberContext;
  if (isExtension) {
    const receiverType = resolveAnnotation(
      fn.params[0]!.typeAnnotation,
      structs,
      enums,
      diagnostics,
    );
    if (receiverType === null) {
      return;
    }
    memberContext = {
      thisType: receiverType,
      enclosingClass: null,
      enclosingStruct: null,
      isConstructor: false,
      isStatic: false,
    };
  }

  for (const param of fn.params) {
    if (param.isReceiver) {
      // Receiver is accessed via `this` expression, not as a named binding.
      continue;
    }
    const paramType = resolveAnnotation(
      param.typeAnnotation,
      structs,
      enums,
      diagnostics,
    );
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
      defSpan: param.name.span,
      defFile: activeModulePath,
      bindingKind: "parameter",
    });
  }

  const paramTypes: ValueType[] = [];
  for (const param of fn.params) {
    const paramType = resolveAnnotation(
      param.typeAnnotation,
      structs,
      enums,
      diagnostics,
    );
    if (paramType) {
      paramTypes.push(paramType);
    }
  }
  if (paramTypes.length === fn.params.length) {
    checkParameterDefaultValues(
      fn.params,
      paramTypes,
      new Map(),
      functions,
      structs,
      enums,
      diagnostics,
    );
  }

  for (const stmt of fn.body) {
    checkStatement(
      stmt,
      scope,
      functions,
      structs,
      enums,
      returnType,
      diagnostics,
      0,
      0,
    );
  }

  if (activeSemantic && activeModulePath) {
    const bindings: ScopeBindingInfo[] = [];
    for (const [name, binding] of scope) {
      const kind =
        binding.bindingKind === "parameter"
          ? "parameter"
          : binding.bindingKind === "const"
            ? "constant"
            : "variable";
      bindings.push({
        name,
        detail: typeToString(binding.type),
        kind,
      });
    }
    activeSemantic.recordScope({
      file: activeModulePath,
      startOffset: fn.span.start.offset,
      endOffset: fn.span.end.offset,
      bindings,
    });
  }

  if (returnType !== "void") {
    const last = fn.body[fn.body.length - 1];
    if (
      !bodyReturnsValue(fn.body) &&
      (!last || last.kind !== "ReturnStatement" || last.value === null)
    ) {
      diagnostics.error(
        `Function '${fn.name.name}' must end with a return statement`,
        fn.name.span,
        "E0312",
      );
    }
  }

  memberContext = prevMemberContext;
}

function checkStructMethods(
  def: StructDef,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  for (const method of def.methods) {
    memberContext = {
      thisType: { kind: "struct", name: def.name },
      enclosingClass: null,
      enclosingStruct: def,
      isConstructor: false,
      isStatic: false,
    };
    const scope = new Map<string, Binding>();
    for (const param of method.decl.params) {
      const paramType = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
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
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    checkParameterDefaultValues(
      method.decl.params,
      method.params,
      new Map(),
      functions,
      structs,
      enums,
      diagnostics,
    );
    for (const stmt of method.decl.body) {
      checkStatement(
        stmt,
        scope,
        functions,
        structs,
        enums,
        method.returnType,
        diagnostics,
        0,
        0,
      );
    }
    if (method.returnType !== "void") {
      const last = method.decl.body[method.decl.body.length - 1];
      if (
        !bodyReturnsValue(method.decl.body) &&
        (!last || last.kind !== "ReturnStatement" || last.value === null)
      ) {
        diagnostics.error(
          `Method '${method.name}' must end with a return statement`,
          method.decl.name.span,
          "E0312",
        );
      }
    }
  }
  memberContext = null;
}

function checkClassMembers(
  def: ClassDef,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  for (const field of def.staticFields) {
    if (field.initializer) {
      const inferred = checkExpression(
        field.initializer,
        new Map(),
        functions,
        structs,
        enums,
        diagnostics,
        false,
        field.type,
      );
      if (
        inferred &&
        !valueMatchesBinding(field.initializer, inferred, field.type)
      ) {
        diagnostics.error(
          typeMismatchMessage(field.type, inferred),
          field.initializer.span,
          "E0303",
        );
      }
    }
  }

  if (def.constructorDecl) {
    memberContext = {
      thisType: { kind: "class", name: def.name },
      enclosingClass: def,
      enclosingStruct: null,
      isConstructor: true,
      isStatic: false,
    };
    const scope = new Map<string, Binding>();
    for (const param of def.constructorDecl.params) {
      const paramType = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
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
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    checkParameterDefaultValues(
      def.constructorDecl.params,
      def.constructorParams,
      new Map(),
      functions,
      structs,
      enums,
      diagnostics,
    );

    const body = def.constructorDecl.body;
    if (def.superclass) {
      const first = body[0];
      const isSuperCall =
        first?.kind === "ExpressionStatement" &&
        first.expression.kind === "CallExpression" &&
        first.expression.callee.kind === "SuperExpression";
      if (!isSuperCall) {
        diagnostics.error(
          `Constructor of '${def.localName}' must call super(...) as its first statement`,
          def.constructorDecl.span,
          "E0357",
        );
      }
    }

    for (let i = 0; i < body.length; i += 1) {
      const stmt = body[i]!;
      if (
        i > 0 &&
        stmt.kind === "ExpressionStatement" &&
        stmt.expression.kind === "CallExpression" &&
        stmt.expression.callee.kind === "SuperExpression"
      ) {
        diagnostics.error(
          "'super' call must be the first statement in the constructor",
          stmt.span,
          "E0357",
        );
      }
      checkStatement(
        stmt,
        scope,
        functions,
        structs,
        enums,
        "void",
        diagnostics,
        0,
        0,
      );
    }
    memberContext = null;
  } else if (def.superclass) {
    // Synthesized constructor: require base to have zero-arg constructor.
    if (def.superclass.constructorParams.length > 0) {
      // Already diagnosed during collect.
    }
  }

  for (const method of [...def.instanceMethods, ...def.staticMethods]) {
    if (
      !method.decl ||
      method.isAbstract ||
      method.implementingClass !== def.name
    ) {
      continue;
    }
    memberContext = {
      thisType: { kind: "class", name: def.name },
      enclosingClass: def,
      enclosingStruct: null,
      isConstructor: false,
      isStatic: method.isStatic,
    };
    const scope = new Map<string, Binding>();
    for (const param of method.decl.params) {
      const paramType = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
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
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    checkParameterDefaultValues(
      method.decl.params,
      method.params,
      new Map(),
      functions,
      structs,
      enums,
      diagnostics,
    );
    const body = method.decl.body ?? [];
    for (const stmt of body) {
      checkStatement(
        stmt,
        scope,
        functions,
        structs,
        enums,
        method.returnType,
        diagnostics,
        0,
        0,
      );
    }
    if (method.returnType !== "void") {
      const last = body[body.length - 1];
      if (
        !bodyReturnsValue(body) &&
        (!last || last.kind !== "ReturnStatement" || last.value === null)
      ) {
        diagnostics.error(
          `Method '${method.name}' must end with a return statement`,
          method.decl.name.span,
          "E0312",
        );
      }
    }
  }

  // Check generic method templates with type params in scope.
  for (const member of def.decl.members) {
    if (
      member.kind !== "ClassMethod" ||
      member.typeParams.length === 0 ||
      member.isAbstract
    ) {
      continue;
    }
    const bound = bindTypeParams(
      member.typeParams,
      structs,
      enums,
      diagnostics,
    );
    if (!bound) {
      continue;
    }
    const prev = activeTypeParams;
    activeTypeParams = bound;
    memberContext = {
      thisType: { kind: "class", name: def.name },
      enclosingClass: def,
      enclosingStruct: null,
      isConstructor: false,
      isStatic: member.isStatic,
    };
    const scope = new Map<string, Binding>();
    for (const param of member.params) {
      const paramType = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (paramType === null) {
        continue;
      }
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    const returnType = resolveReturnType(
      member.returnType,
      structs,
      enums,
      diagnostics,
    );
    if (returnType !== undefined && member.body) {
      for (const stmt of member.body) {
        checkStatement(
          stmt,
          scope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          0,
          0,
        );
      }
    }
    activeTypeParams = prev;
  }
  memberContext = null;
}

function findClassByMangled(typeName: string): ClassDef | undefined {
  const fromMap = classesByMangled.get(typeName);
  if (fromMap) {
    return fromMap;
  }
  for (const def of activeClasses.values()) {
    if (def.name === typeName) {
      return def;
    }
  }
  for (const ns of activeNamespaces.values()) {
    for (const def of ns.classes.values()) {
      if (def.name === typeName) {
        return def;
      }
    }
  }
  return undefined;
}

function findInterfaceByMangled(typeName: string): InterfaceDef | undefined {
  const fromMap = interfacesByMangled.get(typeName);
  if (fromMap) {
    return fromMap;
  }
  for (const def of activeInterfaces.values()) {
    if (def.name === typeName) {
      return def;
    }
  }
  for (const ns of activeNamespaces.values()) {
    for (const def of ns.interfaces.values()) {
      if (def.name === typeName) {
        return def;
      }
    }
  }
  return undefined;
}

function findClassByLocal(
  name: string,
  namespace: string | null,
): ClassDef | undefined {
  if (namespace) {
    return activeNamespaces.get(namespace)?.classes.get(name);
  }
  return activeClasses.get(name) ?? specializedClasses.get(name);
}

function makeNarrowingResolver(
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): TypeAnnResolver {
  return (ann) => resolveAnnotation(ann, structs, enums, diagnostics);
}

/** Constant integer index from `n` or `-n` literals; null if not a compile-time constant. */
function constantIndexValue(expr: Expression): number | null {
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

/** Expression shapes allowed as switch case labels when const-resolved. */
function constantInitializerExpr(expr: Expression): Expression | null {
  if (
    expr.kind === "IntegerLiteral" ||
    expr.kind === "FloatLiteral" ||
    expr.kind === "BooleanLiteral" ||
    expr.kind === "StringLiteral" ||
    expr.kind === "CharLiteral"
  ) {
    return expr;
  }
  if (
    expr.kind === "UnaryExpression" &&
    expr.operator === "-" &&
    expr.operand.kind === "IntegerLiteral"
  ) {
    return expr;
  }
  if (expr.kind === "MemberExpression" && expr.object.kind === "Identifier") {
    return expr;
  }
  return null;
}

function resolveSwitchCaseConstantExpr(
  expr: Expression,
  scope: Map<string, Binding>,
): Expression | null {
  const direct = constantInitializerExpr(expr);
  if (direct) {
    return direct;
  }
  if (expr.kind === "Identifier") {
    const binding = scope.get(expr.name);
    if (binding && !binding.mutable && binding.constantExpr) {
      return binding.constantExpr;
    }
  }
  return null;
}

function switchCaseKey(
  expr: Expression,
  scope: Map<string, Binding>,
  enums: Map<string, EnumDef>,
): string | null {
  const resolved = resolveSwitchCaseConstantExpr(expr, scope);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "IntegerLiteral") {
    return `i32:${resolved.value}`;
  }
  if (resolved.kind === "FloatLiteral") {
    return `f64:${resolved.value}`;
  }
  if (resolved.kind === "BooleanLiteral") {
    return `bool:${resolved.value}`;
  }
  if (resolved.kind === "StringLiteral") {
    return `string:${resolved.value}`;
  }
  if (resolved.kind === "CharLiteral") {
    return `char:${resolved.value}`;
  }
  if (
    resolved.kind === "UnaryExpression" &&
    resolved.operator === "-" &&
    resolved.operand.kind === "IntegerLiteral"
  ) {
    return `i32:${-resolved.operand.value}`;
  }
  if (
    resolved.kind === "MemberExpression" &&
    resolved.object.kind === "Identifier"
  ) {
    if (enums.has(resolved.object.name)) {
      return `enum:${resolved.object.name}:${resolved.property.name}`;
    }
  }
  return null;
}

function switchCaseDisplay(expr: Expression): string {
  if (expr.kind === "IntegerLiteral") {
    return String(expr.value);
  }
  if (expr.kind === "FloatLiteral") {
    return String(expr.value);
  }
  if (expr.kind === "BooleanLiteral") {
    return String(expr.value);
  }
  if (expr.kind === "StringLiteral") {
    return JSON.stringify(expr.value);
  }
  if (expr.kind === "CharLiteral") {
    return JSON.stringify(expr.value);
  }
  if (
    expr.kind === "UnaryExpression" &&
    expr.operator === "-" &&
    expr.operand.kind === "IntegerLiteral"
  ) {
    return String(-expr.operand.value);
  }
  if (expr.kind === "MemberExpression" && expr.object.kind === "Identifier") {
    return `${expr.object.name}.${expr.property.name}`;
  }
  if (expr.kind === "Identifier") {
    return expr.name;
  }
  return "?";
}

function checkDestructuringDeclaration(
  stmt: Extract<Statement, { kind: "VariableDeclaration" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): boolean {
  const pattern = stmt.binding;
  if (pattern.kind !== "ArrayBindingPattern") {
    return false;
  }
  if (!stmt.initializer) {
    diagnostics.error(
      "Destructuring declarations must have an initializer",
      pattern.span,
      "E0102",
    );
    return false;
  }

  let annotated: ValueType | null = null;
  if (stmt.typeAnnotation) {
    annotated = resolveAnnotation(
      stmt.typeAnnotation,
      structs,
      enums,
      diagnostics,
    );
    if (annotated === null) {
      return false;
    }
  }

  const inferred = checkExpression(
    stmt.initializer,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
    false,
    annotated,
  );
  if (!inferred) {
    return false;
  }

  let tupleType: TupleValueType | null = null;
  if (annotated) {
    if (!isTupleType(annotated)) {
      diagnostics.error(
        `Destructuring requires a tuple type, got '${typeToString(annotated)}'`,
        stmt.typeAnnotation?.span ?? pattern.span,
        "E0303",
      );
      return false;
    }
    if (!initializerMatchesAnnotation(stmt.initializer, inferred, annotated)) {
      diagnostics.error(
        typeMismatchMessage(annotated, inferred),
        stmt.initializer.span,
        "E0303",
      );
      return false;
    }
    tupleType = annotated;
  } else if (isTupleType(inferred)) {
    tupleType = inferred;
  } else {
    diagnostics.error(
      `Destructuring requires a tuple, got '${typeToString(inferred)}'`,
      stmt.initializer.span,
      "E0303",
    );
    return false;
  }

  if (pattern.elements.length !== tupleType.elements.length) {
    diagnostics.error(
      `Destructuring pattern has ${pattern.elements.length} element(s), but tuple has ${tupleType.elements.length}`,
      pattern.span,
      "E0330",
    );
    return false;
  }

  const mutable = stmt.mutability === "let";
  for (let i = 0; i < pattern.elements.length; i += 1) {
    const el = pattern.elements[i]!;
    if (!el.name) {
      continue;
    }
    if (scope.has(el.name.name)) {
      diagnostics.error(
        `Variable '${el.name.name}' is already declared`,
        el.name.span,
        "E0301",
      );
      return false;
    }
    scope.set(el.name.name, {
      type: tupleType.elements[i]!,
      mutable,
    });
  }
  return false;
}

/** Returns true when every path through the statement list exits (return/break/continue). */
function checkStatements(
  stmts: Statement[],
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  returnType: ReturnType,
  diagnostics: DiagnosticCollector,
  loopDepth: number,
  switchDepth: number,
): boolean {
  let exits = false;
  for (const s of stmts) {
    if (exits) {
      // Still typecheck unreachable code for errors, but don't apply further CFA
      checkStatement(
        s,
        scope,
        functions,
        structs,
        enums,
        returnType,
        diagnostics,
        loopDepth,
        switchDepth,
      );
      continue;
    }
    exits = checkStatement(
      s,
      scope,
      functions,
      structs,
      enums,
      returnType,
      diagnostics,
      loopDepth,
      switchDepth,
    );
  }
  return exits;
}

/** True when the statement list contains a returning value (return with value or throw). */
function bodyReturnsValue(statements: Statement[]): boolean {
  for (const stmt of statements) {
    if (stmt.kind === "ReturnStatement" && stmt.value !== null) {
      return true;
    }
    if (stmt.kind === "ThrowStatement") {
      return true;
    }
    if (stmt.kind === "TryStatement") {
      if (bodyReturnsValue(stmt.tryBlock)) {
        return true;
      }
      if (stmt.catchClause && bodyReturnsValue(stmt.catchClause.body)) {
        return true;
      }
    }
    if (stmt.kind === "IfStatement") {
      const thenReturns = bodyReturnsValue(stmt.consequent);
      const elseReturns = stmt.alternate
        ? Array.isArray(stmt.alternate)
          ? bodyReturnsValue(stmt.alternate)
          : bodyReturnsValue([stmt.alternate])
        : false;
      if (thenReturns && elseReturns) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Typecheck a statement. Returns true if this statement unconditionally exits
 * the current block (return / break / continue, or if both branches exit).
 */
function checkStatement(
  stmt: Statement,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  returnType: ReturnType,
  diagnostics: DiagnosticCollector,
  loopDepth: number,
  switchDepth: number,
): boolean {
  switch (stmt.kind) {
    case "VariableDeclaration": {
      if (stmt.binding.kind === "ArrayBindingPattern") {
        return checkDestructuringDeclaration(
          stmt,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
        );
      }

      const name = stmt.binding;
      if (scope.has(name.name)) {
        diagnostics.error(
          `Variable '${name.name}' is already declared`,
          name.span,
          "E0301",
        );
        return false;
      }

      let annotated: ValueType | null = null;
      if (stmt.typeAnnotation) {
        annotated = resolveAnnotation(
          stmt.typeAnnotation,
          structs,
          enums,
          diagnostics,
        );
        if (annotated === null) {
          return false;
        }
      }

      if (stmt.initializer === null) {
        if (!annotated) {
          diagnostics.error(
            `Variable '${name.name}' requires a type annotation when not initialized`,
            name.span,
            "E0303",
          );
          return false;
        }
        scope.set(name.name, {
          type: annotated,
          mutable: stmt.mutability === "let",
          defSpan: name.span,
          defFile: activeModulePath,
          bindingKind: stmt.mutability === "const" ? "const" : "let",
        });
        if (activeSemantic && activeModulePath) {
          activeSemantic.recordType(
            activeModulePath,
            name.span,
            typeToString(annotated),
          );
          activeSemantic.recordDeclaration(activeModulePath, name.span);
        }
        return false;
      }

      const inferred = checkExpression(
        stmt.initializer,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        false,
        annotated,
      );
      if (!inferred) {
        return false;
      }

      let bindingType: ValueType = inferred;
      if (annotated) {
        if (
          !initializerMatchesAnnotation(stmt.initializer, inferred, annotated)
        ) {
          diagnostics.error(
            typeMismatchMessage(annotated, inferred),
            stmt.initializer.span,
            "E0303",
          );
          return false;
        }
        bindingType = annotated;
      }

      const binding: Binding = {
        type: bindingType,
        mutable: stmt.mutability === "let",
        defSpan: name.span,
        defFile: activeModulePath,
        bindingKind: stmt.mutability === "const" ? "const" : "let",
      };
      if (stmt.mutability === "const" && stmt.initializer) {
        const constantExpr = constantInitializerExpr(stmt.initializer);
        if (constantExpr) {
          scope.set(name.name, { ...binding, constantExpr });
        } else {
          scope.set(name.name, binding);
        }
      } else {
        scope.set(name.name, binding);
      }
      if (activeSemantic && activeModulePath) {
        activeSemantic.recordType(
          activeModulePath,
          name.span,
          typeToString(bindingType),
        );
        activeSemantic.recordDeclaration(activeModulePath, name.span);
      }
      return false;
    }
    case "AssignmentStatement": {
      checkAssignment(stmt, scope, functions, structs, enums, diagnostics);
      return false;
    }
    case "UpdateStatement": {
      const binding = scope.get(stmt.name.name);
      const modVal = binding ? null : activeValues.get(stmt.name.name);
      if (!binding && !modVal) {
        diagnostics.error(
          `Undefined variable '${stmt.name.name}'`,
          stmt.name.span,
          "E0304",
        );
        return false;
      }
      const targetType = binding?.type ?? modVal!.type;
      const mutable = binding ? binding.mutable : modVal!.mutability === "let";
      if (!mutable) {
        diagnostics.error(
          `Cannot assign to const variable '${stmt.name.name}'`,
          stmt.name.span,
          "E0305",
        );
        return false;
      }
      if (!isNumericType(targetType)) {
        diagnostics.error(
          `Operator '${stmt.operator}' requires a numeric variable, got '${typeToString(targetType)}'`,
          stmt.name.span,
          "E0306",
        );
      }
      return false;
    }
    case "ExpressionStatement": {
      checkExpression(
        stmt.expression,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        true,
      );
      return false;
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
        return true;
      }

      if (stmt.value === null) {
        diagnostics.error(
          `Function must return a value of type '${typeToString(returnType)}'`,
          stmt.span,
          "E0314",
        );
        return true;
      }

      const valueType = checkExpression(
        stmt.value,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        false,
        returnType,
      );
      if (!valueType) {
        return true;
      }
      if (!valueMatchesBinding(stmt.value, valueType, returnType)) {
        diagnostics.error(
          typeMismatchMessage(returnType, valueType),
          stmt.value.span,
          "E0303",
        );
      }
      return true;
    }
    case "IfStatement": {
      const resolveAnn = makeNarrowingResolver(structs, enums, diagnostics);
      const condType = checkExpression(
        stmt.condition,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (condType && condType !== "bool") {
        diagnostics.error(
          `If condition must be 'bool', got '${typeToString(condType)}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      const thenFacts = extractNarrowingFacts(stmt.condition, resolveAnn);
      const elseFacts = extractFalseNarrowingFacts(stmt.condition, resolveAnn);
      const thenScope = applyNarrowingFacts(scope, thenFacts) as Map<
        string,
        Binding
      >;
      const elseScope = applyNarrowingFacts(scope, elseFacts) as Map<
        string,
        Binding
      >;

      const thenExits = checkStatements(
        stmt.consequent,
        thenScope,
        functions,
        structs,
        enums,
        returnType,
        diagnostics,
        loopDepth,
        switchDepth,
      );

      let elseExits = false;
      if (stmt.alternate === null) {
        elseExits = false;
      } else if (Array.isArray(stmt.alternate)) {
        elseExits = checkStatements(
          stmt.alternate,
          elseScope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth,
        );
      } else {
        elseExits = checkStatement(
          stmt.alternate,
          elseScope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth,
        );
      }

      // Post-if CFA: if one branch exits, apply the other branch's facts to the continuing scope
      if (thenExits && !elseExits) {
        mutateScopeWithFacts(scope, elseFacts);
      } else if (elseExits && !thenExits) {
        mutateScopeWithFacts(scope, thenFacts);
      }

      return thenExits && elseExits;
    }
    case "WhileStatement": {
      const resolveAnn = makeNarrowingResolver(structs, enums, diagnostics);
      const condType = checkExpression(
        stmt.condition,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (condType && condType !== "bool") {
        diagnostics.error(
          `While condition must be 'bool', got '${typeToString(condType)}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      const bodyFacts = extractNarrowingFacts(stmt.condition, resolveAnn);
      const bodyScope = applyNarrowingFacts(scope, bodyFacts) as Map<
        string,
        Binding
      >;
      checkStatements(
        stmt.body,
        bodyScope,
        functions,
        structs,
        enums,
        returnType,
        diagnostics,
        loopDepth + 1,
        switchDepth,
      );
      return false;
    }
    case "ForStatement": {
      if (stmt.initializer) {
        checkStatement(
          stmt.initializer,
          scope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth,
        );
      }
      if (stmt.condition) {
        const condType = checkExpression(
          stmt.condition,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
        );
        if (condType && condType !== "bool") {
          diagnostics.error(
            `For condition must be 'bool', got '${typeToString(condType)}'`,
            stmt.condition.span,
            "E0316",
          );
        }
      }
      if (stmt.update) {
        checkStatement(
          stmt.update,
          scope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth,
        );
      }
      checkStatements(
        stmt.body,
        scope,
        functions,
        structs,
        enums,
        returnType,
        diagnostics,
        loopDepth + 1,
        switchDepth,
      );
      return false;
    }
    case "ForInStatement": {
      const iterableType = checkExpression(
        stmt.iterable,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!iterableType) {
        return false;
      }
      if (!isArrayType(iterableType)) {
        diagnostics.error(
          `For-in iterable must be an array, got '${typeToString(iterableType)}'`,
          stmt.iterable.span,
          "E0318",
        );
        return false;
      }

      if (scope.has(stmt.name.name)) {
        diagnostics.error(
          `Variable '${stmt.name.name}' is already declared`,
          stmt.name.span,
          "E0301",
        );
        return false;
      }

      const mutable = stmt.mutability === "let";
      scope.set(stmt.name.name, {
        type: iterableType.element,
        mutable,
      });

      checkStatements(
        stmt.body,
        scope,
        functions,
        structs,
        enums,
        returnType,
        diagnostics,
        loopDepth + 1,
        switchDepth,
      );

      scope.delete(stmt.name.name);
      return false;
    }
    case "SwitchStatement": {
      const discriminantType = checkExpression(
        stmt.discriminant,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!discriminantType) {
        return false;
      }
      if (!supportsEquality(discriminantType)) {
        diagnostics.error(
          `Switch expression type '${typeToString(discriminantType)}' does not support switch`,
          stmt.discriminant.span,
          "E0335",
        );
        return false;
      }

      const seenCases = new Set<string>();
      let hasDefault = false;

      for (const switchCase of stmt.cases) {
        if (switchCase.isDefault) {
          if (hasDefault) {
            diagnostics.error(
              "Duplicate default case",
              switchCase.span,
              "E0337",
            );
            continue;
          }
          hasDefault = true;
          checkStatements(
            switchCase.body,
            scope,
            functions,
            structs,
            enums,
            returnType,
            diagnostics,
            loopDepth,
            switchDepth + 1,
          );
          continue;
        }

        const test = switchCase.test;
        if (!test) {
          continue;
        }

        if (!resolveSwitchCaseConstantExpr(test, scope)) {
          diagnostics.error(
            "Switch case label must be a compile-time constant",
            test.span,
            "E0322",
          );
        }

        const caseType = checkExpression(
          test,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
        );
        if (caseType) {
          if (!isAssignable(caseType, discriminantType)) {
            diagnostics.error(
              `Switch case type ${typeToString(caseType)} is not compatible with switch expression type ${typeToString(discriminantType)}`,
              test.span,
              "E0335",
            );
          }
        }

        const key = switchCaseKey(test, scope, enums);
        if (key) {
          if (seenCases.has(key)) {
            diagnostics.error(
              `Duplicate switch case: ${switchCaseDisplay(test)}`,
              test.span,
              "E0336",
            );
          } else {
            seenCases.add(key);
          }
        }

        checkStatements(
          switchCase.body,
          scope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth + 1,
        );
      }
      return false;
    }
    case "BreakStatement": {
      if (loopDepth === 0 && switchDepth === 0) {
        diagnostics.error(
          "'break' used outside of a loop or switch",
          stmt.span,
          "E0317",
        );
      }
      return true;
    }
    case "ContinueStatement": {
      if (loopDepth === 0) {
        diagnostics.error(
          "'continue' used outside of a loop",
          stmt.span,
          "E0317",
        );
      }
      return true;
    }
    case "ThrowStatement": {
      const thrown = checkExpression(
        stmt.expression,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!thrown || !isThrowableType(thrown)) {
        diagnostics.error(
          `Cannot throw value of type '${thrown ? typeToString(thrown) : "unknown"}'; expected Error or a subtype`,
          stmt.expression.span,
          "E0380",
        );
      }
      return true;
    }
    case "TryStatement": {
      if (!stmt.catchClause && !stmt.finallyBlock) {
        diagnostics.error(
          "try must have catch and/or finally",
          stmt.span,
          "E0381",
        );
        return false;
      }
      checkStatements(
        stmt.tryBlock,
        scope,
        functions,
        structs,
        enums,
        returnType,
        diagnostics,
        loopDepth,
        switchDepth,
      );
      if (stmt.catchClause) {
        const catchScope = new Map(scope);
        catchScope.set(stmt.catchClause.parameter.name, {
          type: { kind: "class", name: BUILTIN_ERROR_MANGLED },
          mutable: false,
        });
        checkStatements(
          stmt.catchClause.body,
          catchScope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth,
        );
      }
      if (stmt.finallyBlock) {
        checkStatements(
          stmt.finallyBlock,
          scope,
          functions,
          structs,
          enums,
          returnType,
          diagnostics,
          loopDepth,
          switchDepth,
        );
      }
      return false;
    }
  }
}

function checkAssignment(
  stmt: Extract<Statement, { kind: "AssignmentStatement" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  if (stmt.target.kind === "Identifier") {
    const binding = scope.get(stmt.target.name);
    const modVal = binding ? null : activeValues.get(stmt.target.name);
    if (!binding && !modVal) {
      diagnostics.error(
        `Undefined variable '${stmt.target.name}'`,
        stmt.target.span,
        "E0304",
      );
      return;
    }
    const targetType = binding?.type ?? modVal!.type;
    const mutable = binding ? binding.mutable : modVal!.mutability === "let";
    if (!mutable) {
      diagnostics.error(
        `Cannot assign to const variable '${stmt.target.name}'`,
        stmt.target.span,
        "E0305",
      );
      return;
    }

    if (stmt.operator === "+=" || stmt.operator === "-=") {
      if (!isNumericType(targetType)) {
        diagnostics.error(
          `Operator '${stmt.operator}' requires a numeric variable, got '${typeToString(targetType)}'`,
          stmt.target.span,
          "E0306",
        );
        return;
      }
    }

    const valueType = checkExpression(
      stmt.value,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    );
    if (!valueType) {
      return;
    }
    if (!valueMatchesBinding(stmt.value, valueType, targetType)) {
      diagnostics.error(
        typeMismatchMessage(targetType, valueType),
        stmt.value.span,
        "E0303",
      );
    }
    return;
  }

  if (stmt.target.kind === "MemberExpression") {
    const fieldType = checkMemberLvalue(
      stmt.target,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    );
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

    const valueType = checkExpression(
      stmt.value,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    );
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

  // Index assignment: arr[i] = value / map[key] = value — allowed even if container is const
  const objectType = checkExpression(
    stmt.target.object,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
  );
  const indexType = checkExpression(
    stmt.target.index,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
  );
  if (!objectType || !indexType) {
    return;
  }
  if (
    isMapType(objectType) ||
    (isObjectType(objectType) && objectType.indexType)
  ) {
    if (
      indexType !== "string" &&
      !(isLiteralType(indexType) && indexType.literalKind === "string")
    ) {
      diagnostics.error(
        `Map index must be a string, got '${typeToString(indexType)}'`,
        stmt.target.index.span,
        "E0320",
      );
      return;
    }
    const elementType = (
      isMapType(objectType) ? objectType.valueType : objectType.indexType
    ) as ValueType;
    if (stmt.operator === "+=" || stmt.operator === "-=") {
      diagnostics.error(
        `Operator '${stmt.operator}' is not supported on map elements`,
        stmt.target.span,
        "E0306",
      );
      return;
    }
    const valueType = checkExpression(
      stmt.value,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    );
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
    return;
  }
  if (!isArrayType(objectType) && !isTupleType(objectType)) {
    diagnostics.error(
      `Cannot index into type '${typeToString(objectType)}'`,
      stmt.target.object.span,
      "E0319",
    );
    return;
  }
  if (!isIntegerType(indexType)) {
    diagnostics.error(
      `${isTupleType(objectType) ? "Tuple" : "Array"} index must be an integer, got '${typeToString(indexType)}'`,
      stmt.target.index.span,
      "E0320",
    );
    return;
  }

  let elementType: ValueType;
  if (isTupleType(objectType)) {
    const constIndex = constantIndexValue(stmt.target.index);
    if (constIndex === null) {
      diagnostics.error(
        "Tuple element assignment requires a constant index",
        stmt.target.index.span,
        "E0333",
      );
      return;
    }
    if (constIndex < 0 || constIndex >= objectType.elements.length) {
      diagnostics.error(
        `Tuple index ${constIndex} is out of bounds.\nTuple contains ${objectType.elements.length} elements.`,
        stmt.target.index.span,
        "E0332",
      );
      return;
    }
    elementType = objectType.elements[constIndex]!;
  } else {
    elementType = objectType.element;
  }

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

  const valueType = checkExpression(
    stmt.value,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
  );
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

/** Resolve the field type of a member lvalue (allows const struct/class field mutation). */
function checkMemberLvalue(
  expr: Extract<Expression, { kind: "MemberExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  // Static class field: ClassName.field
  if (expr.object.kind === "Identifier" && !scope.has(expr.object.name)) {
    const classDef = activeClasses.get(expr.object.name);
    if (classDef) {
      const field = classDef.staticFields.find(
        (f) => f.name === expr.property.name,
      );
      if (!field) {
        diagnostics.error(
          `Unknown static field '${expr.property.name}' on class '${classDef.localName}'`,
          expr.property.span,
          "E0324",
        );
        return null;
      }
      if (
        !canAccessMember(
          field.visibility,
          field.declaringClass,
          diagnostics,
          expr.property.span,
        )
      ) {
        return null;
      }
      if (field.isReadonly) {
        diagnostics.error(
          `Cannot assign to readonly field '${field.name}'`,
          expr.property.span,
          "E0358",
        );
        return null;
      }
      return field.type;
    }
  }

  const objectType = checkExpression(
    expr.object,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
  );
  if (!objectType) {
    return null;
  }

  if (isStructType(objectType)) {
    const def =
      findStructByTypeName(structs, objectType.name) ??
      findStructInNamespaces(objectType.name);
    if (!def) {
      diagnostics.error(
        `Unknown struct '${objectType.name}'`,
        expr.object.span,
        "E0104",
      );
      return null;
    }
    const field = def.fields.find((f) => f.name === expr.property.name);
    if (!field) {
      diagnostics.error(
        `Unknown field '${expr.property.name}' on struct '${def.decl.name.name}'`,
        expr.property.span,
        "E0324",
      );
      return null;
    }
    return field.type;
  }

  if (isClassType(objectType)) {
    const def = findClassByMangled(objectType.name);
    if (!def) {
      diagnostics.error(
        `Unknown class '${objectType.name}'`,
        expr.object.span,
        "E0104",
      );
      return null;
    }
    const field = def.instanceFields.find((f) => f.name === expr.property.name);
    if (!field) {
      diagnostics.error(
        `Unknown field '${expr.property.name}' on class '${def.localName}'`,
        expr.property.span,
        "E0324",
      );
      return null;
    }
    if (
      !canAccessMember(
        field.visibility,
        field.declaringClass,
        diagnostics,
        expr.property.span,
      )
    ) {
      return null;
    }
    if (
      field.isReadonly &&
      !(
        memberContext?.isConstructor &&
        memberContext.enclosingClass?.name === field.declaringClass
      )
    ) {
      diagnostics.error(
        `Cannot assign to readonly field '${field.name}'`,
        expr.property.span,
        "E0358",
      );
      return null;
    }
    return field.type;
  }

  if (isInterfaceType(objectType)) {
    diagnostics.error(
      `Interfaces have no fields; use a method call`,
      expr.property.span,
      "E0375",
    );
    return null;
  }

  diagnostics.error(
    `Cannot assign to field of type '${typeToString(objectType)}'`,
    expr.object.span,
    "E0331",
  );
  return null;
}

function canAccessMember(
  visibility: Visibility,
  declaringClassMangled: string,
  diagnostics: DiagnosticCollector,
  span: SourceSpan,
): boolean {
  if (visibility === "public") {
    return true;
  }
  if (memberContext?.enclosingClass?.name === declaringClassMangled) {
    return true;
  }
  diagnostics.error("Cannot access private member", span, "E0359");
  return false;
}

function findStructByTypeName(
  structs: Map<string, StructDef>,
  typeName: string,
): StructDef | undefined {
  for (const def of structs.values()) {
    if (def.name === typeName) {
      return def;
    }
  }
  for (const def of specializedStructs.values()) {
    if (def.name === typeName) {
      return def;
    }
  }
  return undefined;
}

function findStructInNamespaces(typeName: string): StructDef | undefined {
  for (const ns of activeNamespaces.values()) {
    for (const def of ns.structs.values()) {
      if (def.name === typeName) {
        return def;
      }
    }
  }
  return undefined;
}

/**
 * Resolve `ns.fn(...)` calls. Returns `undefined` if this is not a namespace call
 * (so the caller can fall through to array method checking).
 */
function checkNamespaceCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null | undefined {
  if (expr.callee.kind !== "MemberExpression") {
    return undefined;
  }
  if (expr.callee.object.kind !== "Identifier") {
    return undefined;
  }
  const nsName = expr.callee.object.name;
  if (!activeNamespaces.has(nsName) || scope.has(nsName)) {
    return undefined;
  }

  const ns = activeNamespaces.get(nsName)!;
  const sig = ns.functions.get(expr.callee.property.name);
  if (!sig) {
    const prop = expr.callee.property.name;
    let existsButPrivate = false;
    for (const symbols of allModuleSymbols.values()) {
      if (symbols.moduleId === ns.moduleId && symbols.functions.has(prop)) {
        existsButPrivate = true;
        break;
      }
    }
    diagnostics.error(
      existsButPrivate
        ? `Module "${ns.moduleId}" does not export "${prop}".`
        : `Unknown function '${nsName}.${prop}'`,
      expr.callee.property.span,
      existsButPrivate ? "E0408" : "E0307",
    );
    return null;
  }

  if (
    !checkDeclarationCallArgs(
      expr,
      "function",
      `${nsName}.${sig.name}`,
      sig.decl.params,
      sig.params,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    )
  ) {
    return null;
  }

  if (activeSemantic && activeModulePath) {
    activeSemantic.recordMemberDefinition(
      activeModulePath,
      expr.callee.property.span,
      {
        file: sig.modulePath,
        span: sig.decl.name.span,
      },
    );
  }

  if (sig.returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(
        `Void function '${nsName}.${sig.name}' cannot be used as a value`,
        expr.span,
        "E0309",
      );
    }
    return null;
  }

  return sig.returnType;
}

type CalleeLabelKind = "function" | "method" | "constructor";

interface MappedCallSlots {
  readonly slots: (Expression | undefined)[];
  readonly namedIndices: ReadonlySet<number>;
  readonly providedCount: number;
}

function calleeLabel(kind: CalleeLabelKind, name: string): string {
  if (kind === "function") {
    return `Function '${name}'`;
  }
  if (kind === "method") {
    return `Method '${name}'`;
  }
  return `Constructor of '${name}'`;
}

function mapCallArgumentsToSlots(
  callArgs: readonly CallArgument[],
  kind: CalleeLabelKind,
  calleeName: string,
  params: readonly Parameter[],
  callSpan: SourceSpan,
  diagnostics: DiagnosticCollector,
): MappedCallSlots | null {
  const n = params.length;
  const slots: (Expression | undefined)[] = Array.from(
    { length: n },
    () => undefined,
  );
  const namedIndices = new Set<number>();
  let nextPositional = 0;
  let sawNamed = false;
  let providedCount = 0;

  for (const arg of callArgs) {
    if (arg.kind === "NamedArgument") {
      sawNamed = true;
      const idx = params.findIndex((p) => p.name.name === arg.name.name);
      if (idx < 0) {
        diagnostics.error(
          `${calleeLabel(kind, calleeName)} has no parameter named '${arg.name.name}'.`,
          arg.name.span,
          "E0316",
        );
        return null;
      }
      if (slots[idx] !== undefined) {
        diagnostics.error(
          `Argument '${arg.name.name}' was provided more than once.`,
          arg.name.span,
          "E0317",
        );
        return null;
      }
      slots[idx] = arg.value;
      namedIndices.add(idx);
      providedCount += 1;
      continue;
    }

    if (sawNamed) {
      diagnostics.error(
        "Positional arguments must come before named arguments",
        arg.span,
        "E0102",
      );
      return null;
    }
    if (nextPositional >= n) {
      diagnostics.error(
        `${calleeLabel(kind, calleeName)} expects ${n} argument(s), got ${callArgs.length}`,
        callSpan,
        "E0315",
      );
      return null;
    }
    const paramName = params[nextPositional]!.name.name;
    if (slots[nextPositional] !== undefined) {
      diagnostics.error(
        `Argument '${paramName}' was provided more than once.`,
        arg.span,
        "E0317",
      );
      return null;
    }
    slots[nextPositional] = arg;
    providedCount += 1;
    nextPositional += 1;
  }

  return { slots, namedIndices, providedCount };
}

function fillDefaultArgumentSlots(
  mapped: MappedCallSlots,
  kind: CalleeLabelKind,
  calleeName: string,
  params: readonly Parameter[],
  callSpan: SourceSpan,
  diagnostics: DiagnosticCollector,
  rewriteDefault?: (expr: Expression) => Expression,
): Expression[] | null {
  const resolved: Expression[] = [];
  for (let i = 0; i < params.length; i += 1) {
    const existing = mapped.slots[i];
    if (existing !== undefined) {
      resolved.push(existing);
      continue;
    }
    const defaultValue = params[i]!.defaultValue;
    if (defaultValue) {
      resolved.push(
        rewriteDefault ? rewriteDefault(defaultValue) : defaultValue,
      );
      continue;
    }
    diagnostics.error(
      `${calleeLabel(kind, calleeName)} expects ${params.length} argument(s), got ${mapped.providedCount}`,
      callSpan,
      "E0315",
    );
    return null;
  }
  return resolved;
}

function rewriteCallArgs(
  target: { args: readonly CallArgument[] },
  resolved: Expression[],
): void {
  (target as { args: CallArgument[] }).args = resolved;
}

/**
 * Map named/positional args, fill defaults, typecheck, and rewrite to positional Expression[].
 * Used when the callee resolves to a declaration with Parameter[].
 */
function checkDeclarationCallArgs(
  target: { args: CallArgument[]; span: SourceSpan },
  kind: CalleeLabelKind,
  calleeName: string,
  params: readonly Parameter[],
  paramTypes: readonly ValueType[],
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  rewriteDefault?: (expr: Expression) => Expression,
): boolean {
  const mapped = mapCallArgumentsToSlots(
    target.args,
    kind,
    calleeName,
    params,
    target.span,
    diagnostics,
  );
  if (!mapped) {
    return false;
  }
  const resolved = fillDefaultArgumentSlots(
    mapped,
    kind,
    calleeName,
    params,
    target.span,
    diagnostics,
    rewriteDefault,
  );
  if (!resolved) {
    return false;
  }

  for (let i = 0; i < resolved.length; i += 1) {
    const arg = resolved[i]!;
    const expected = paramTypes[i]!;
    const argType = checkExpression(
      arg,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
      false,
      expected,
    );
    if (!argType) {
      return false;
    }
    if (!valueMatchesBinding(arg, argType, expected)) {
      if (mapped.namedIndices.has(i)) {
        diagnostics.error(
          `Argument '${params[i]!.name.name}' expects ${typeToString(expected)}, got ${typeToString(argType)}.`,
          arg.span,
          "E0303",
        );
      } else {
        diagnostics.error(
          typeMismatchMessage(expected, argType),
          arg.span,
          "E0303",
        );
      }
      return false;
    }
  }

  rewriteCallArgs(target, resolved);
  return true;
}

function checkParameterDefaultValues(
  params: readonly Parameter[],
  paramTypes: readonly ValueType[],
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
): void {
  for (let i = 0; i < params.length; i += 1) {
    const param = params[i]!;
    if (!param.defaultValue) {
      continue;
    }
    const expected = paramTypes[i];
    if (!expected) {
      continue;
    }
    const defaultType = checkExpression(
      param.defaultValue,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
      false,
      expected,
    );
    if (!defaultType) {
      continue;
    }
    if (!valueMatchesBinding(param.defaultValue, defaultType, expected)) {
      diagnostics.error(
        `Default value of type ${typeToString(defaultType)} is not assignable to parameter type ${typeToString(expected)}.`,
        param.defaultValue.span,
        "E0303",
      );
    }
  }
}

function findInterfaceMethodParams(
  def: InterfaceDef,
  methodName: string,
): Parameter[] | null {
  for (const method of def.decl.methods) {
    if (method.name.name === methodName) {
      return method.params;
    }
  }
  for (const base of def.bases) {
    const found = findInterfaceMethodParams(base, methodName);
    if (found) {
      return found;
    }
  }
  return null;
}

function rejectNamedArgsOnFunctionValue(
  args: readonly CallArgument[],
  diagnostics: DiagnosticCollector,
): boolean {
  for (const arg of args) {
    if (arg.kind === "NamedArgument") {
      diagnostics.error(
        "Named arguments require a direct function reference",
        arg.span,
        "E0318",
      );
      return false;
    }
  }
  return true;
}

function recordStructMemberCompletions(
  def: StructDef,
  objectSpan: SourceSpan,
): void {
  if (!activeSemantic || !activeModulePath) {
    return;
  }
  const items: ScopeBindingInfo[] = [
    ...def.fields.map((f) => ({
      name: f.name,
      detail: typeToString(f.type),
      kind: "field" as const,
    })),
    ...def.methods.map((m) => ({
      name: m.name,
      detail: typeToString({
        kind: "function",
        params: m.params,
        returnType: m.returnType,
      }),
      kind: "method" as const,
    })),
  ];
  activeSemantic.recordMemberCompletions(activeModulePath, objectSpan, items);
}

function recordClassMemberCompletions(
  def: ClassDef,
  objectSpan: SourceSpan,
): void {
  if (!activeSemantic || !activeModulePath) {
    return;
  }
  const items: ScopeBindingInfo[] = [
    ...def.instanceFields.map((f) => ({
      name: f.name,
      detail: typeToString(f.type),
      kind: "field" as const,
    })),
    ...def.instanceMethods.map((m) => ({
      name: m.name,
      detail: typeToString({
        kind: "function",
        params: m.params,
        returnType: m.returnType,
      }),
      kind: "method" as const,
    })),
  ];
  activeSemantic.recordMemberCompletions(activeModulePath, objectSpan, items);
}

function checkExpression(
  expr: Expression,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall = false,
  expectedType: ValueType | null = null,
): ValueType | null {
  const result = checkExpressionInner(
    expr,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
    allowVoidCall,
    expectedType,
  );
  if (result !== null && activeSemantic && activeModulePath) {
    activeSemantic.recordType(
      activeModulePath,
      expr.span,
      typeToString(result),
    );
  }
  return result;
}

function checkExpressionInner(
  expr: Expression,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall = false,
  expectedType: ValueType | null = null,
): ValueType | null {
  switch (expr.kind) {
    case "IntegerLiteral":
      if (
        expectedType &&
        isLiteralType(expectedType) &&
        expectedType.literalKind === "number"
      ) {
        return { kind: "literal", value: expr.value, literalKind: "number" };
      }
      if (expectedType && isUnionType(expectedType)) {
        const lit: LiteralValueType = {
          kind: "literal",
          value: expr.value,
          literalKind: "number",
        };
        if (isAssignable(lit, expectedType)) {
          return lit;
        }
      }
      return "i32";
    case "FloatLiteral":
      return "f64";
    case "BooleanLiteral":
      return "bool";
    case "StringLiteral":
      if (
        expectedType &&
        isLiteralType(expectedType) &&
        expectedType.literalKind === "string"
      ) {
        return { kind: "literal", value: expr.value, literalKind: "string" };
      }
      if (expectedType && isUnionType(expectedType)) {
        const lit: LiteralValueType = {
          kind: "literal",
          value: expr.value,
          literalKind: "string",
        };
        if (isAssignable(lit, expectedType)) {
          return lit;
        }
      }
      return "string";
    case "TemplateLiteral": {
      for (const part of expr.expressions) {
        const partType = checkExpression(
          part,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
        );
        if (!partType) {
          return null;
        }
        if (!isTemplateConvertible(partType)) {
          diagnostics.error(
            `Cannot interpolate value of type '${typeToString(partType)}' in template literal`,
            part.span,
            "E0401",
          );
        }
      }
      return "string";
    }
    case "CharLiteral":
      return "char";
    case "NullLiteral":
      return "null";
    case "StructLiteral": {
      let def: StructDef | undefined;
      let template = activeGenericStructs.get(expr.name.name);
      if (expr.namespace) {
        const ns = activeNamespaces.get(expr.namespace.name);
        if (!ns) {
          diagnostics.error(
            `Unknown namespace '${expr.namespace.name}'`,
            expr.namespace.span,
            "E0406",
          );
          return null;
        }
        def = ns.structs.get(expr.name.name);
        if (!def) {
          diagnostics.error(
            `Unknown struct '${expr.namespace.name}.${expr.name.name}'`,
            expr.name.span,
            "E0104",
          );
          return null;
        }
      } else if (template || expr.typeArgs.length > 0) {
        if (!template) {
          diagnostics.error(
            `Unknown generic struct '${expr.name.name}'`,
            expr.name.span,
            "E0104",
          );
          return null;
        }
        let typeArgs = expr.typeArgs;
        if (
          typeArgs.length === 0 &&
          expectedType &&
          isStructType(expectedType)
        ) {
          // Cannot easily reverse-mangle; require explicit args or field inference.
        }
        if (typeArgs.length === 0) {
          // Infer from field initializers against template field types.
          const fieldArgTypes: ValueType[] = [];
          const fieldAnns: TypeAnnotation[] = [];
          for (const field of template.decl.fields) {
            const init = expr.fields.find(
              (f) => f.name.name === field.name.name,
            );
            if (!init) {
              continue;
            }
            const vt = checkExpression(
              init.value,
              scope,
              functions,
              structs,
              enums,
              diagnostics,
            );
            if (!vt) {
              return null;
            }
            fieldArgTypes.push(vt);
            fieldAnns.push(field.typeAnnotation);
          }
          const inferred = inferTypeArgs(
            template.decl.typeParams,
            fieldAnns,
            fieldArgTypes,
          );
          if (!inferred) {
            diagnostics.error(
              `Cannot infer type arguments for '${expr.name.name}'`,
              expr.span,
              "E0385",
            );
            return null;
          }
          typeArgs = inferred;
        }
        const instantiated = instantiateGenericStruct(
          template,
          typeArgs,
          expr.span,
          structs,
          enums,
          diagnostics,
        );
        if (!instantiated || !isStructType(instantiated)) {
          return null;
        }
        instantiationCollector.structLiteralRewrites.set(
          expr.span.start.offset,
          mangleInstance(template.decl.name.name, typeArgs),
        );
        def =
          specializedStructs.get(
            mangleInstance(template.decl.name.name, typeArgs),
          ) ?? structs.get(mangleInstance(template.decl.name.name, typeArgs));
        if (!def) {
          return null;
        }
      } else {
        def =
          structs.get(expr.name.name) ?? specializedStructs.get(expr.name.name);
        if (!def) {
          if (activeGenericStructs.has(expr.name.name)) {
            diagnostics.error(
              `Generic type '${expr.name.name}' requires type arguments`,
              expr.name.span,
              "E0382",
            );
            return null;
          }
          diagnostics.error(
            `Unknown struct '${expr.name.name}'`,
            expr.name.span,
            "E0104",
          );
          return null;
        }
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
            `Unknown field '${init.name.name}' on struct '${def.decl.name.name}'`,
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
          enums,
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
            `Missing field '${field.name}' in struct literal for '${def.decl.name.name}'`,
            expr.span,
            "E0332",
          );
          return null;
        }
      }

      return { kind: "struct", name: def.name };
    }
    case "ArrayLiteral": {
      if (expectedType && isTupleType(expectedType)) {
        if (expr.elements.length !== expectedType.elements.length) {
          diagnostics.error(
            `Tuple literal has ${expr.elements.length} element(s), but type '${typeToString(expectedType)}' expects ${expectedType.elements.length}`,
            expr.span,
            "E0331",
          );
          return null;
        }
        for (let i = 0; i < expr.elements.length; i += 1) {
          const expectedEl = expectedType.elements[i]!;
          const t = checkExpression(
            expr.elements[i]!,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
            false,
            expectedEl,
          );
          if (!t) {
            return null;
          }
          if (!valueMatchesBinding(expr.elements[i]!, t, expectedEl)) {
            diagnostics.error(
              typeMismatchMessage(expectedEl, t),
              expr.elements[i]!.span,
              "E0303",
            );
            return null;
          }
        }
        return expectedType;
      }

      if (expr.elements.length === 0) {
        if (expectedType && isArrayType(expectedType)) {
          return expectedType;
        }
        if (
          expectedType &&
          isTupleType(expectedType) &&
          expectedType.elements.length === 0
        ) {
          return expectedType;
        }
        diagnostics.error(
          "Empty array literal requires a type annotation",
          expr.span,
          "E0321",
        );
        return null;
      }

      const elementTypes: ValueType[] = [];
      for (const element of expr.elements) {
        const expectedElement =
          expectedType && isArrayType(expectedType)
            ? expectedType.element
            : null;
        const t = checkExpression(
          element,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
          false,
          expectedElement,
        );
        if (!t) {
          return null;
        }
        const bound =
          expectedElement && valueMatchesBinding(element, t, expectedElement)
            ? expectedElement
            : t;
        if (
          expectedElement &&
          !valueMatchesBinding(element, t, expectedElement)
        ) {
          diagnostics.error(
            typeMismatchMessage(expectedElement, t),
            element.span,
            "E0303",
          );
          return null;
        }
        elementTypes.push(bound);
      }

      const first = elementTypes[0]!;
      const homogeneous = elementTypes.every((t) => typesEqual(t, first));
      if (!homogeneous) {
        return { kind: "tuple", elements: elementTypes };
      }

      // Homogeneous → array (unless somehow expected was already handled as tuple above)
      return { kind: "array", element: first };
    }
    case "IndexExpression": {
      const objectType = checkExpression(
        expr.object,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      const indexType = checkExpression(
        expr.index,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!objectType || !indexType) {
        return null;
      }
      let resolvedObjectType: ValueType = objectType;
      if (expr.optional) {
        if (objectType === "null") {
          return "null";
        }
        if (isUnionType(objectType) && includesNull(objectType)) {
          resolvedObjectType = stripNull(objectType) as ValueType;
        }
      }
      const wrapOptional = (result: ValueType): ValueType =>
        expr.optional ? (makeUnion([result, "null"]) as ValueType) : result;

      if (
        isMapType(resolvedObjectType) ||
        (isObjectType(resolvedObjectType) && resolvedObjectType.indexType)
      ) {
        if (
          indexType !== "string" &&
          !(isLiteralType(indexType) && indexType.literalKind === "string")
        ) {
          diagnostics.error(
            `Map index must be a string, got '${typeToString(indexType)}'`,
            expr.index.span,
            "E0320",
          );
          return null;
        }
        return wrapOptional(
          (isMapType(resolvedObjectType)
            ? resolvedObjectType.valueType
            : resolvedObjectType.indexType) as ValueType,
        );
      }
      if (isTupleType(resolvedObjectType)) {
        if (!isIntegerType(indexType)) {
          diagnostics.error(
            `Tuple index must be an integer, got '${typeToString(indexType)}'`,
            expr.index.span,
            "E0320",
          );
          return null;
        }
        const constIndex = constantIndexValue(expr.index);
        if (constIndex !== null) {
          if (
            constIndex < 0 ||
            constIndex >= resolvedObjectType.elements.length
          ) {
            diagnostics.error(
              `Tuple index ${constIndex} is out of bounds.\nTuple contains ${resolvedObjectType.elements.length} elements.`,
              expr.index.span,
              "E0332",
            );
            return null;
          }
          return wrapOptional(resolvedObjectType.elements[constIndex]!);
        }
        return wrapOptional(
          makeUnion(resolvedObjectType.elements) as ValueType,
        );
      }
      if (!isArrayType(resolvedObjectType)) {
        diagnostics.error(
          `Cannot index into type '${typeToString(resolvedObjectType)}'`,
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
      return wrapOptional(resolvedObjectType.element);
    }
    case "MemberExpression": {
      // ns.Enum.Variant
      if (
        expr.object.kind === "MemberExpression" &&
        expr.object.object.kind === "Identifier" &&
        activeNamespaces.has(expr.object.object.name) &&
        !scope.has(expr.object.object.name)
      ) {
        const ns = activeNamespaces.get(expr.object.object.name)!;
        const enumDef = ns.enums.get(expr.object.property.name);
        if (enumDef) {
          if (!enumDef.variants.has(expr.property.name)) {
            diagnostics.error(
              `Unknown variant '${expr.property.name}' on enum '${expr.object.object.name}.${enumDef.decl.name.name}'`,
              expr.property.span,
              "E0324",
            );
            return null;
          }
          return { kind: "enum", name: enumDef.name };
        }
      }

      // Enum variant access: Direction.Up (type name, not a local binding)
      if (
        expr.object.kind === "Identifier" &&
        enums.has(expr.object.name) &&
        !scope.has(expr.object.name)
      ) {
        const def = enums.get(expr.object.name)!;
        if (!def.variants.has(expr.property.name)) {
          diagnostics.error(
            `Unknown variant '${expr.property.name}' on enum '${def.decl.name.name}'`,
            expr.property.span,
            "E0324",
          );
          return null;
        }
        return { kind: "enum", name: def.name };
      }

      // Static class field: ClassName.field
      if (expr.object.kind === "Identifier" && !scope.has(expr.object.name)) {
        const classDef =
          activeClasses.get(expr.object.name) ??
          (activeNamespaces.has(expr.object.name) ? undefined : undefined);
        const localClass = activeClasses.get(expr.object.name);
        if (localClass) {
          const field = localClass.staticFields.find(
            (f) => f.name === expr.property.name,
          );
          if (field) {
            if (
              !canAccessMember(
                field.visibility,
                field.declaringClass,
                diagnostics,
                expr.property.span,
              )
            ) {
              return null;
            }
            return field.type;
          }
        }
      }

      // Bare namespace member used as a value (not a call)
      if (
        expr.object.kind === "Identifier" &&
        activeNamespaces.has(expr.object.name) &&
        !scope.has(expr.object.name)
      ) {
        const ns = activeNamespaces.get(expr.object.name)!;
        const nsVal = ns.values.get(expr.property.name);
        if (nsVal) {
          if (activeSemantic && activeModulePath) {
            activeSemantic.recordDefinition(activeModulePath, expr.property.span, {
              file: nsVal.modulePath,
              span: nsVal.span,
            });
            activeSemantic.recordType(
              activeModulePath,
              expr.span,
              typeToString(nsVal.type),
            );
          }
          return nsVal.type;
        }
        const classDef = ns.classes.get(expr.property.name);
        if (classDef) {
          diagnostics.error(
            `Class '${expr.object.name}.${expr.property.name}' cannot be used as a value; use 'new'`,
            expr.span,
            "E0407",
          );
          return null;
        }
        diagnostics.error(
          `Namespace member '${expr.object.name}.${expr.property.name}' cannot be used as a value`,
          expr.span,
          "E0407",
        );
        return null;
      }

      const objectType = checkExpression(
        expr.object,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!objectType) {
        return null;
      }
      let resolvedObjectType: ValueType = objectType;
      if (isUnionType(objectType) || objectType === "null") {
        if (expr.optional) {
          if (objectType === "null") {
            return "null";
          }
          resolvedObjectType = stripNull(objectType) as ValueType;
        } else {
          const typeStr = typeToString(objectType);
          const mayBeNull = includesNull(objectType) || objectType === "null";
          let message = `Cannot access property '${expr.property.name}' on type '${typeStr}'.`;
          if (mayBeNull && expr.object.kind === "Identifier") {
            message += `\n'${expr.object.name}' may be null.`;
          } else if (mayBeNull) {
            message += `\nValue may be null.`;
          }
          diagnostics.error(message, expr.span, "E0397");
          return null;
        }
      }
      const wrapOptionalMember = (result: ValueType): ValueType =>
        expr.optional ? (makeUnion([result, "null"]) as ValueType) : result;
      if (isObjectType(resolvedObjectType)) {
        const field = resolvedObjectType.fields.find(
          (f) => f.name === expr.property.name,
        );
        if (!field) {
          diagnostics.error(
            `Unknown field '${expr.property.name}' on object type`,
            expr.property.span,
            "E0324",
          );
          return null;
        }
        return wrapOptionalMember(field.type as ValueType);
      }
      if (isStructType(resolvedObjectType)) {
        const def =
          findStructByTypeName(structs, resolvedObjectType.name) ??
          findStructInNamespaces(resolvedObjectType.name);
        if (!def) {
          diagnostics.error(
            `Unknown struct '${resolvedObjectType.name}'`,
            expr.object.span,
            "E0104",
          );
          return null;
        }
        recordStructMemberCompletions(def, expr.object.span);
        const field = def.fields.find((f) => f.name === expr.property.name);
        if (!field) {
          diagnostics.error(
            `Unknown field '${expr.property.name}' on struct '${def.decl.name.name}'`,
            expr.property.span,
            "E0324",
          );
          return null;
        }
        const fieldDecl = def.decl.fields.find(
          (f) => f.name.name === field.name,
        );
        if (activeSemantic && activeModulePath && fieldDecl) {
          const defFile =
            modulePathOwningMangled("struct", def.name) ?? activeModulePath;
          activeSemantic.recordMemberDefinition(
            activeModulePath,
            expr.property.span,
            {
              file: defFile,
              span: fieldDecl.name.span,
            },
          );
        }
        return wrapOptionalMember(field.type);
      }
      if (isClassType(resolvedObjectType)) {
        const def = findClassByMangled(resolvedObjectType.name);
        if (!def) {
          diagnostics.error(
            `Unknown class '${resolvedObjectType.name}'`,
            expr.object.span,
            "E0104",
          );
          return null;
        }
        recordClassMemberCompletions(def, expr.object.span);
        const field = def.instanceFields.find(
          (f) => f.name === expr.property.name,
        );
        if (!field) {
          diagnostics.error(
            `Unknown field '${expr.property.name}' on class '${def.localName}'`,
            expr.property.span,
            "E0324",
          );
          return null;
        }
        if (
          !canAccessMember(
            field.visibility,
            field.declaringClass,
            diagnostics,
            expr.property.span,
          )
        ) {
          return null;
        }
        const fieldDecl = def.decl.members.find(
          (m) => m.kind === "ClassField" && m.name.name === field.name,
        );
        if (
          activeSemantic &&
          activeModulePath &&
          fieldDecl &&
          fieldDecl.kind === "ClassField"
        ) {
          const defFile =
            modulePathOwningMangled("class", def.name) ?? activeModulePath;
          activeSemantic.recordMemberDefinition(
            activeModulePath,
            expr.property.span,
            {
              file: defFile,
              span: fieldDecl.name.span,
            },
          );
        }
        return wrapOptionalMember(field.type);
      }
      if (isInterfaceType(resolvedObjectType)) {
        diagnostics.error(
          `Interfaces have no fields; use a method call`,
          expr.property.span,
          "E0375",
        );
        return null;
      }
      if (expr.property.name === "length") {
        if (resolvedObjectType === "string") {
          return wrapOptionalMember("i32");
        }
        if (
          isArrayType(resolvedObjectType) ||
          isTupleType(resolvedObjectType)
        ) {
          return wrapOptionalMember("i32");
        }
        diagnostics.error(
          `Property 'length' is only available on arrays, tuples, and strings, got '${typeToString(resolvedObjectType)}'`,
          expr.span,
          "E0323",
        );
        return null;
      }
      diagnostics.error(
        `Unknown property '${expr.property.name}'`,
        expr.property.span,
        "E0324",
      );
      return null;
    }
    case "ThisExpression": {
      if (lambdaDepth > 0) {
        diagnostics.error(
          "Lambdas cannot capture 'this'; use a local binding instead",
          expr.span,
          "E0397",
        );
        return null;
      }
      if (!memberContext || memberContext.isStatic) {
        diagnostics.error(
          "'this' is only allowed in instance methods, constructors, and extension methods",
          expr.span,
          "E0360",
        );
        return null;
      }
      return memberContext.thisType;
    }
    case "SuperExpression": {
      diagnostics.error(
        "'super' can only be called as super(...)",
        expr.span,
        "E0361",
      );
      return null;
    }
    case "NewExpression": {
      let classDef = findClassByLocal(
        expr.className.name,
        expr.namespace?.name ?? null,
      );
      const classTpl =
        expr.namespace == null
          ? activeGenericClasses.get(expr.className.name)
          : undefined;

      if (!classDef && classTpl) {
        let typeArgs = expr.typeArgs;
        if (typeArgs.length === 0) {
          // Infer from constructor args.
          const ctor = classTpl.decl.members.find(
            (m) => m.kind === "ConstructorDeclaration",
          );
          if (!ctor || ctor.kind !== "ConstructorDeclaration") {
            diagnostics.error(
              `Cannot infer type arguments for '${expr.className.name}' without a constructor`,
              expr.span,
              "E0385",
            );
            return null;
          }
          const mapped = mapCallArgumentsToSlots(
            expr.args,
            "constructor",
            expr.className.name,
            ctor.params,
            expr.span,
            diagnostics,
          );
          if (!mapped) {
            return null;
          }
          const providedAnns: TypeAnnotation[] = [];
          const providedTypes: ValueType[] = [];
          for (let i = 0; i < ctor.params.length; i += 1) {
            const slot = mapped.slots[i];
            if (slot === undefined) {
              continue;
            }
            const t = checkExpression(
              slot,
              scope,
              functions,
              structs,
              enums,
              diagnostics,
            );
            if (!t) {
              return null;
            }
            providedAnns.push(ctor.params[i]!.typeAnnotation);
            providedTypes.push(t);
          }
          const inferred = inferTypeArgs(
            classTpl.decl.typeParams,
            providedAnns,
            providedTypes,
          );
          if (!inferred) {
            diagnostics.error(
              `Cannot infer type arguments for '${expr.className.name}'`,
              expr.span,
              "E0385",
            );
            return null;
          }
          typeArgs = inferred;
          // Re-check will use typeArgs below — args already typed.
          const instantiated = instantiateGenericClass(
            classTpl,
            typeArgs,
            expr.span,
            structs,
            enums,
            diagnostics,
          );
          if (!instantiated || !isClassType(instantiated)) {
            return null;
          }
          instantiationCollector.newRewrites.set(
            expr.span.start.offset,
            mangleInstance(classTpl.decl.name.name, typeArgs),
          );
          classDef = specializedClasses.get(
            mangleInstance(classTpl.decl.name.name, typeArgs),
          );
          if (!classDef) {
            return null;
          }
          const ctorParams = classDef.constructorDecl?.params ?? ctor.params;
          if (
            !checkDeclarationCallArgs(
              expr,
              "constructor",
              classDef.localName,
              ctorParams,
              classDef.constructorParams,
              scope,
              functions,
              structs,
              enums,
              diagnostics,
            )
          ) {
            return null;
          }
          return { kind: "class", name: classDef.name };
        }
        const instantiated = instantiateGenericClass(
          classTpl,
          typeArgs,
          expr.span,
          structs,
          enums,
          diagnostics,
        );
        if (!instantiated || !isClassType(instantiated)) {
          return null;
        }
        instantiationCollector.newRewrites.set(
          expr.span.start.offset,
          mangleInstance(classTpl.decl.name.name, typeArgs),
        );
        classDef = specializedClasses.get(
          mangleInstance(classTpl.decl.name.name, typeArgs),
        );
      }

      if (!classDef) {
        const label = expr.namespace
          ? `${expr.namespace.name}.${expr.className.name}`
          : expr.className.name;
        const iface =
          expr.namespace == null
            ? activeInterfaces.get(expr.className.name)
            : activeNamespaces
                .get(expr.namespace.name)
                ?.interfaces.get(expr.className.name);
        if (iface) {
          diagnostics.error(
            `Cannot construct interface '${iface.localName}'`,
            expr.className.span,
            "E0376",
          );
          return null;
        }
        diagnostics.error(
          `Unknown class '${label}'`,
          expr.className.span,
          "E0104",
        );
        return null;
      }
      if (classDef.isAbstract) {
        diagnostics.error(
          `Cannot construct abstract class '${classDef.localName}'`,
          expr.className.span,
          "E0362",
        );
        return null;
      }
      const ctorParams = classDef.constructorDecl?.params ?? null;
      if (
        ctorParams &&
        ctorParams.length === classDef.constructorParams.length
      ) {
        if (
          !checkDeclarationCallArgs(
            expr,
            "constructor",
            classDef.localName,
            ctorParams,
            classDef.constructorParams,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
          )
        ) {
          return null;
        }
      } else {
        if (!rejectNamedArgsOnFunctionValue(expr.args, diagnostics)) {
          return null;
        }
        if (expr.args.length !== classDef.constructorParams.length) {
          diagnostics.error(
            `Constructor of '${classDef.localName}' expects ${classDef.constructorParams.length} argument(s), got ${expr.args.length}`,
            expr.span,
            "E0315",
          );
          return null;
        }
        for (let i = 0; i < expr.args.length; i += 1) {
          const arg = expr.args[i]! as Expression;
          const expected = classDef.constructorParams[i]!;
          const argType = checkExpression(
            arg,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
          );
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
      }
      return { kind: "class", name: classDef.name };
    }
    case "Identifier": {
      const binding = scope.get(expr.name);
      if (binding) {
        if (
          activeSemantic &&
          activeModulePath &&
          binding.defSpan &&
          binding.defFile
        ) {
          activeSemantic.recordDefinition(activeModulePath, expr.span, {
            file: binding.defFile,
            span: binding.defSpan,
          });
        }
        return binding.type;
      }
      const modVal = activeValues.get(expr.name);
      if (modVal) {
        if (activeSemantic && activeModulePath) {
          activeSemantic.recordDefinition(activeModulePath, expr.span, {
            file: modVal.modulePath,
            span: modVal.span,
          });
          activeSemantic.recordType(
            activeModulePath,
            expr.span,
            typeToString(modVal.type),
          );
        }
        return modVal.type;
      }
      const sig = functions.get(expr.name);
      if (sig) {
        if (activeSemantic && activeModulePath) {
          activeSemantic.recordDefinition(activeModulePath, expr.span, {
            file: sig.modulePath,
            span: sig.decl.name.span,
          });
        }
        return {
          kind: "function",
          params: sig.params,
          returnType: sig.returnType,
        };
      }
      // Namespace-imported functions are only available as ns.fn member access.
      diagnostics.error(
        `Undefined variable '${expr.name}'`,
        expr.span,
        "E0304",
      );
      return null;
    }
    case "NonNullExpression": {
      const operandType = checkExpression(
        expr.expression,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!operandType) {
        return null;
      }
      if (!includesNull(operandType) && operandType !== "null") {
        diagnostics.error(
          `Non-null assertion '!' has no effect on non-nullable type '${typeToString(operandType)}'`,
          expr.span,
          "E0399",
        );
      }
      return stripNull(operandType) as ValueType;
    }
    case "NullCoalescingExpression": {
      const leftType = checkExpression(
        expr.left,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      const rightType = checkExpression(
        expr.right,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!leftType || !rightType) {
        return null;
      }
      const inner = stripNull(leftType) as ValueType;
      if (!isAssignable(rightType, inner)) {
        diagnostics.error(
          typeMismatchMessage(inner, rightType),
          expr.span,
          "E0303",
        );
        return null;
      }
      return inner as ValueType;
    }
    case "UnaryExpression": {
      const operand = checkExpression(
        expr.operand,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
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
    case "TypeofExpression": {
      const operand = checkExpression(
        expr.operand,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!operand) {
        return null;
      }
      const tag = typeofTagForType(operand);
      if (tag === null && isUnionType(operand)) {
        // typeof on a union is still string at runtime
        return "string";
      }
      if (tag === null) {
        diagnostics.error(
          `typeof is not supported for type '${typeToString(operand)}'`,
          expr.span,
          "E0396",
        );
        return null;
      }
      return "string";
    }
    case "IsExpression": {
      const valueType = checkExpression(
        expr.value,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!valueType) {
        return null;
      }
      const targetType = resolveAnnotation(
        expr.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (targetType === null) {
        return null;
      }
      return "bool";
    }
    case "BinaryExpression": {
      if (expr.operator === "&&" || expr.operator === "||") {
        const left = checkExpression(
          expr.left,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
        );
        if (!left) {
          return null;
        }
        if (left !== "bool") {
          diagnostics.error(
            `Operator '${expr.operator}' requires two bool operands, got '${typeToString(left)}' and '...'`,
            expr.span,
            "E0306",
          );
          return null;
        }
        // Right side of && sees true-facts from left
        const resolveAnn = makeNarrowingResolver(structs, enums, diagnostics);
        const rightScope =
          expr.operator === "&&"
            ? (applyNarrowingFacts(
                scope,
                extractNarrowingFacts(expr.left, resolveAnn),
              ) as Map<string, Binding>)
            : scope;
        const right = checkExpression(
          expr.right,
          rightScope,
          functions,
          structs,
          enums,
          diagnostics,
        );
        if (!right) {
          return null;
        }
        if (right !== "bool") {
          diagnostics.error(
            `Operator '${expr.operator}' requires two bool operands, got '${typeToString(left)}' and '${typeToString(right)}'`,
            expr.span,
            "E0306",
          );
          return null;
        }
        return "bool";
      }

      const left = checkExpression(
        expr.left,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      const right = checkExpression(
        expr.right,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!left || !right) {
        return null;
      }

      if (
        expr.operator === "==" ||
        expr.operator === "!=" ||
        expr.operator === "<" ||
        expr.operator === "<=" ||
        expr.operator === ">" ||
        expr.operator === ">="
      ) {
        return checkComparison(
          expr.operator,
          left,
          right,
          expr.span,
          diagnostics,
        );
      }

      if (expr.operator === "+") {
        if (left === "string" && right === "string") {
          return "string";
        }
        if (
          (left === "string" && isStringConcatScalar(right)) ||
          (right === "string" && isStringConcatScalar(left))
        ) {
          return "string";
        }
        if (isNumericType(left) && typesEqual(left, right)) {
          return left;
        }
        diagnostics.error(
          `Operator '+' requires two string (or string + scalar) or two matching numeric operands, got '${typeToString(left)}' and '${typeToString(right)}'`,
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
    case "LambdaExpression":
      return checkLambdaExpression(
        expr,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        expectedType,
      );
    case "CallExpression": {
      if (expr.callee.kind === "SuperExpression") {
        if (
          !memberContext?.isConstructor ||
          !memberContext.enclosingClass?.superclass
        ) {
          diagnostics.error(
            "'super' can only be called from a subclass constructor",
            expr.span,
            "E0361",
          );
          return null;
        }
        const base = memberContext.enclosingClass.superclass;
        const ctorParams = base.constructorDecl?.params ?? null;
        if (ctorParams && ctorParams.length === base.constructorParams.length) {
          if (
            !checkDeclarationCallArgs(
              expr,
              "constructor",
              base.localName,
              ctorParams,
              base.constructorParams,
              scope,
              functions,
              structs,
              enums,
              diagnostics,
            )
          ) {
            return null;
          }
        } else {
          if (!rejectNamedArgsOnFunctionValue(expr.args, diagnostics)) {
            return null;
          }
          if (expr.args.length !== base.constructorParams.length) {
            diagnostics.error(
              `super(...) expects ${base.constructorParams.length} argument(s), got ${expr.args.length}`,
              expr.span,
              "E0315",
            );
            return null;
          }
          for (let i = 0; i < expr.args.length; i += 1) {
            const arg = expr.args[i]! as Expression;
            const expected = base.constructorParams[i]!;
            const argType = checkExpression(
              arg,
              scope,
              functions,
              structs,
              enums,
              diagnostics,
              false,
              expected,
            );
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
        }
        if (!allowVoidCall) {
          diagnostics.error(
            "'super' cannot be used as a value",
            expr.span,
            "E0309",
          );
        }
        return null;
      }

      if (expr.callee.kind === "MemberExpression") {
        if (
          expr.callee.object.kind === "Identifier" &&
          expr.callee.object.name === "console"
        ) {
          const prop = expr.callee.property.name;
          if (
            prop === "log" ||
            prop === "error" ||
            prop === "warn" ||
            prop === "readLine"
          ) {
            if (prop === "readLine") {
              if (expr.args.length !== 0) {
                diagnostics.error(
                  "'console.readLine' expects no arguments",
                  expr.span,
                  "E0315",
                );
                return null;
              }
              return "string";
            }
            if (!allowVoidCall) {
              diagnostics.error(
                `'console.${prop}' cannot be used as a value`,
                expr.span,
                "E0309",
              );
              return null;
            }
            if (expr.args.length === 0) {
              diagnostics.error(
                `'console.${prop}' requires at least one argument`,
                expr.span,
                "E0308",
              );
              return null;
            }
            for (const arg of expr.args) {
              if (arg.kind === "NamedArgument") {
                diagnostics.error(
                  `Named arguments are not supported for 'console.${prop}'`,
                  arg.span,
                  "E0318",
                );
                return null;
              }
              const argType = checkExpression(
                arg,
                scope,
                functions,
                structs,
                enums,
                diagnostics,
              );
              if (!argType) {
                return null;
              }
              if (!isPrintableType(argType)) {
                diagnostics.error(
                  `Cannot print value of type '${typeToString(argType)}'`,
                  arg.span,
                  "E0333",
                );
                return null;
              }
            }
            return null;
          }
        }
        const nsCall = checkNamespaceCall(
          expr,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
          allowVoidCall,
        );
        if (nsCall !== undefined) {
          return nsCall;
        }
        return checkMethodCall(
          expr,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
          allowVoidCall,
        );
      }

      if (expr.callee.kind === "Identifier" && expr.callee.name === "print") {
        if (!allowVoidCall) {
          diagnostics.error(
            "'print' cannot be used as a value",
            expr.span,
            "E0309",
          );
          return null;
        }
        if (expr.args.length === 0) {
          diagnostics.error(
            "'print' requires at least one argument",
            expr.span,
            "E0308",
          );
          return null;
        }
        for (const arg of expr.args) {
          if (arg.kind === "NamedArgument") {
            diagnostics.error(
              "Named arguments are not supported for 'print'",
              arg.span,
              "E0318",
            );
            return null;
          }
          const argType = checkExpression(
            arg,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
          );
          if (!argType) {
            return null;
          }
          if (!isPrintableType(argType)) {
            diagnostics.error(
              `Cannot print value of type '${typeToString(argType)}'`,
              arg.span,
              "E0333",
            );
            return null;
          }
        }
        return null;
      }

      if (
        expr.callee.kind === "Identifier" &&
        expr.callee.name === "createMap"
      ) {
        if (expr.args.length !== 0) {
          diagnostics.error(
            "'createMap' expects no arguments",
            expr.span,
            "E0315",
          );
          return null;
        }
        if (expectedType && isMapType(expectedType)) {
          return expectedType;
        }
        if (
          expectedType &&
          isObjectType(expectedType) &&
          expectedType.indexType
        ) {
          return { kind: "map", valueType: expectedType.indexType };
        }
        if (
          expectedType &&
          typeof expectedType === "object" &&
          expectedType.kind === "interface"
        ) {
          const iface = findInterfaceByMangled(expectedType.name);
          if (iface?.indexType && iface.methods.length === 0) {
            return { kind: "map", valueType: iface.indexType };
          }
        }
        return { kind: "map", valueType: "string" };
      }

      if (expr.callee.kind === "Identifier") {
        const sig = functions.get(expr.callee.name);
        if (!sig) {
          const genericTpl = activeGenericFunctions.get(expr.callee.name);
          if (genericTpl) {
            return checkGenericFunctionCall(
              expr,
              genericTpl,
              scope,
              functions,
              structs,
              enums,
              diagnostics,
              allowVoidCall,
              expectedType,
            );
          }
          // Fall through to value-call if the identifier is a function-typed variable.
          const binding = scope.get(expr.callee.name);
          if (!binding || !isFunctionType(binding.type)) {
            diagnostics.error(
              `Unknown function '${expr.callee.name}'`,
              expr.callee.span,
              "E0307",
            );
            return null;
          }
          if (
            activeSemantic &&
            activeModulePath &&
            binding.defSpan &&
            binding.defFile
          ) {
            activeSemantic.recordDefinition(
              activeModulePath,
              expr.callee.span,
              {
                file: binding.defFile,
                span: binding.defSpan,
              },
            );
          }
          return checkFunctionValueCall(
            expr,
            binding.type,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
            allowVoidCall,
          );
        }

        if (activeSemantic && activeModulePath) {
          activeSemantic.recordDefinition(activeModulePath, expr.callee.span, {
            file: sig.modulePath,
            span: sig.decl.name.span,
          });
          activeSemantic.recordType(
            activeModulePath,
            expr.callee.span,
            typeToString({
              kind: "function",
              params: sig.params,
              returnType: sig.returnType,
            }),
          );
        }

        if (
          !checkDeclarationCallArgs(
            expr,
            "function",
            sig.name,
            sig.decl.params,
            sig.params,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
          )
        ) {
          return null;
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

      // Indirect call through an arbitrary callable expression.
      const calleeType = checkExpression(
        expr.callee,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
      if (!calleeType) {
        return null;
      }
      if (!isFunctionType(calleeType)) {
        diagnostics.error(
          `Cannot call value of type '${typeToString(calleeType)}'`,
          expr.callee.span,
          "E0307",
        );
        return null;
      }
      return checkFunctionValueCall(
        expr,
        calleeType,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      );
    }
  }
}

function checkFunctionValueCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  fnType: FunctionValueType,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null {
  if (!rejectNamedArgsOnFunctionValue(expr.args, diagnostics)) {
    return null;
  }
  if (expr.args.length !== fnType.params.length) {
    diagnostics.error(
      `Function value expects ${fnType.params.length} argument(s), got ${expr.args.length}`,
      expr.span,
      "E0315",
    );
    return null;
  }
  for (let i = 0; i < expr.args.length; i += 1) {
    const arg = expr.args[i]! as Expression;
    const expected = fnType.params[i]! as ValueType;
    const argType = checkExpression(
      arg,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
      false,
      expected,
    );
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
  if (fnType.returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(
        "Void function cannot be used as a value",
        expr.span,
        "E0309",
      );
    }
    return null;
  }
  return fnType.returnType as ValueType;
}

function checkLambdaExpression(
  expr: Extract<Expression, { kind: "LambdaExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  expectedType: ValueType | null,
): ValueType | null {
  const expectedFn =
    expectedType && isFunctionType(expectedType) ? expectedType : null;

  if (expectedFn && expr.params.length !== expectedFn.params.length) {
    diagnostics.error(
      `Lambda expects ${expectedFn.params.length} parameter(s), got ${expr.params.length}`,
      expr.span,
      "E0315",
    );
    return null;
  }

  const paramTypes: ValueType[] = [];
  const childScope = new Map(scope);
  const selfBound = new Set<string>();

  for (let i = 0; i < expr.params.length; i += 1) {
    const param = expr.params[i]!;
    selfBound.add(param.name.name);
    let paramType: ValueType | null = null;
    if (param.typeAnnotation) {
      paramType = resolveAnnotation(
        param.typeAnnotation,
        structs,
        enums,
        diagnostics,
      );
      if (paramType === null) {
        return null;
      }
      if (expectedFn) {
        const expectedParam = expectedFn.params[i]! as ValueType;
        if (!typesEqual(paramType, expectedParam)) {
          diagnostics.error(
            typeMismatchMessage(expectedParam, paramType),
            param.typeAnnotation.span,
            "E0303",
          );
          return null;
        }
      }
    } else if (expectedFn) {
      paramType = expectedFn.params[i]! as ValueType;
    } else {
      diagnostics.error(
        `Parameter '${param.name.name}' requires a type annotation or a contextual function type`,
        param.name.span,
        "E0398",
      );
      return null;
    }
    paramTypes.push(paramType);
    if (childScope.has(param.name.name)) {
      // Shadow outer binding inside the lambda.
    }
    childScope.set(param.name.name, { type: paramType, mutable: false });
  }

  let declaredReturn: ReturnType | null = null;
  if (expr.returnType) {
    const resolved = resolveReturnType(
      expr.returnType,
      structs,
      enums,
      diagnostics,
    );
    if (resolved === undefined) {
      return null;
    }
    declaredReturn = resolved;
    if (expectedFn) {
      const er = expectedFn.returnType;
      if ((er === "void") !== (declaredReturn === "void")) {
        diagnostics.error(
          `Expected return type '${typeToString(er as ValueType | "void")}', got '${typeToString(declaredReturn)}'`,
          expr.returnType.span,
          "E0303",
        );
      } else if (
        er !== "void" &&
        declaredReturn !== "void" &&
        !typesEqual(declaredReturn, er as ValueType)
      ) {
        diagnostics.error(
          typeMismatchMessage(er as ValueType, declaredReturn),
          expr.returnType.span,
          "E0303",
        );
      }
    }
  } else if (expectedFn) {
    declaredReturn = expectedFn.returnType as ReturnType;
  }

  lambdaDepth += 1;
  let bodyReturn: ReturnType | null = null;

  if (expr.body.kind === "expression") {
    const expectedBody =
      declaredReturn && declaredReturn !== "void" ? declaredReturn : null;
    const bodyType = checkExpression(
      expr.body.expression,
      childScope,
      functions,
      structs,
      enums,
      diagnostics,
      false,
      expectedBody,
    );
    if (!bodyType) {
      lambdaDepth -= 1;
      return null;
    }
    bodyReturn = bodyType;
    if (declaredReturn === "void") {
      diagnostics.error(
        "Expression-bodied lambda cannot have return type 'void'",
        expr.body.expression.span,
        "E0313",
      );
      lambdaDepth -= 1;
      return null;
    }
    if (declaredReturn) {
      if (
        !valueMatchesBinding(expr.body.expression, bodyType, declaredReturn)
      ) {
        diagnostics.error(
          typeMismatchMessage(declaredReturn, bodyType),
          expr.body.expression.span,
          "E0303",
        );
        lambdaDepth -= 1;
        return null;
      }
      bodyReturn = declaredReturn;
    }
  } else {
    if (declaredReturn === null) {
      diagnostics.error(
        "Block-bodied lambda requires an explicit return type or a contextual function type",
        expr.span,
        "E0399",
      );
      lambdaDepth -= 1;
      return null;
    }
    const blockScope = new Map(childScope);
    const exits = checkStatements(
      expr.body.statements,
      blockScope,
      functions,
      structs,
      enums,
      declaredReturn,
      diagnostics,
      0,
      0,
    );
    for (const name of blockScope.keys()) {
      if (!scope.has(name) && !expr.params.some((p) => p.name.name === name)) {
        selfBound.add(name);
      }
    }
    bodyReturn = declaredReturn;
    if (declaredReturn !== "void" && !exits) {
      diagnostics.error(
        `Lambda must return a value of type '${typeToString(declaredReturn)}'`,
        expr.span,
        "E0312",
      );
    }
  }

  lambdaDepth -= 1;

  if (bodyReturn === null) {
    return null;
  }

  const captures = collectLambdaCaptures(expr, selfBound, scope);
  instantiationCollector.lambdaCaptures.set(expr.span.start.offset, captures);

  return {
    kind: "function",
    params: paramTypes,
    returnType: bodyReturn,
  };
}

function collectLambdaCaptures(
  expr: Extract<Expression, { kind: "LambdaExpression" }>,
  selfBound: Set<string>,
  outerScope: Map<string, Binding>,
): { name: string; mutable: boolean }[] {
  const captures = new Map<string, { name: string; mutable: boolean }>();
  const bound = new Set(selfBound);

  const consider = (name: string): void => {
    if (bound.has(name)) {
      return;
    }
    const binding = outerScope.get(name);
    if (binding) {
      captures.set(name, { name, mutable: binding.mutable });
    }
  };

  const walkExpr = (e: Expression): void => {
    switch (e.kind) {
      case "Identifier":
        consider(e.name);
        break;
      case "LambdaExpression": {
        const nestedBound = new Set(bound);
        for (const p of e.params) {
          nestedBound.add(p.name.name);
        }
        walkLambdaBody(e.body, nestedBound);
        break;
      }
      case "CallExpression":
        walkExpr(e.callee);
        for (const a of e.args) {
          if (a.kind === "NamedArgument") {
            walkExpr(a.value);
          } else {
            walkExpr(a);
          }
        }
        break;
      case "BinaryExpression":
        walkExpr(e.left);
        walkExpr(e.right);
        break;
      case "NonNullExpression":
        walkExpr(e.expression);
        break;
      case "NullCoalescingExpression":
        walkExpr(e.left);
        walkExpr(e.right);
        break;
      case "UnaryExpression":
      case "TypeofExpression":
        walkExpr(e.operand);
        break;
      case "IsExpression":
        walkExpr(e.value);
        break;
      case "IndexExpression":
        walkExpr(e.object);
        walkExpr(e.index);
        break;
      case "MemberExpression":
        walkExpr(e.object);
        break;
      case "ArrayLiteral":
        for (const el of e.elements) walkExpr(el);
        break;
      case "StructLiteral":
        for (const f of e.fields) walkExpr(f.value);
        break;
      case "NewExpression":
        for (const a of e.args) {
          if (a.kind === "NamedArgument") {
            walkExpr(a.value);
          } else {
            walkExpr(a);
          }
        }
        break;
      default:
        break;
    }
  };

  const walkStmt = (s: Statement, localBound: Set<string>): void => {
    switch (s.kind) {
      case "VariableDeclaration":
        if (s.initializer) walkExpr(s.initializer);
        if (s.binding.kind === "Identifier") {
          localBound.add(s.binding.name);
        } else {
          for (const el of s.binding.elements) {
            if (el.name) localBound.add(el.name.name);
          }
        }
        break;
      case "AssignmentStatement":
        walkExpr(s.value);
        break;
      case "ExpressionStatement":
        walkExpr(s.expression);
        break;
      case "ReturnStatement":
        if (s.value) walkExpr(s.value);
        break;
      case "IfStatement":
        walkExpr(s.condition);
        for (const st of s.consequent) walkStmt(st, localBound);
        if (Array.isArray(s.alternate)) {
          for (const st of s.alternate) walkStmt(st, localBound);
        } else if (s.alternate) {
          walkStmt(s.alternate, localBound);
        }
        break;
      case "WhileStatement":
        walkExpr(s.condition);
        for (const st of s.body) walkStmt(st, localBound);
        break;
      case "ForStatement":
        if (s.initializer) walkStmt(s.initializer, localBound);
        if (s.condition) walkExpr(s.condition);
        if (s.update) {
          if (s.update.kind === "AssignmentStatement") {
            walkExpr(s.update.value);
          }
        }
        for (const st of s.body) walkStmt(st, localBound);
        break;
      case "ForInStatement":
        walkExpr(s.iterable);
        localBound.add(s.name.name);
        for (const st of s.body) walkStmt(st, localBound);
        break;
      case "SwitchStatement":
        walkExpr(s.discriminant);
        for (const switchCase of s.cases) {
          if (switchCase.test) {
            walkExpr(switchCase.test);
          }
          for (const st of switchCase.body) walkStmt(st, localBound);
        }
        break;
      default:
        break;
    }
  };

  const walkLambdaBody = (
    body: typeof expr.body,
    nestedBound: Set<string>,
  ): void => {
    const saved = new Set(bound);
    bound.clear();
    for (const n of nestedBound) bound.add(n);
    for (const n of selfBound) bound.add(n);
    if (body.kind === "expression") {
      walkExpr(body.expression);
    } else {
      const localBound = new Set(nestedBound);
      for (const st of body.statements) walkStmt(st, localBound);
    }
    bound.clear();
    for (const n of saved) bound.add(n);
  };

  if (expr.body.kind === "expression") {
    walkExpr(expr.body.expression);
  } else {
    const localBound = new Set(bound);
    for (const st of expr.body.statements) walkStmt(st, localBound);
  }

  return [...captures.values()];
}

function checkMethodCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null {
  if (expr.callee.kind !== "MemberExpression") {
    return null;
  }
  const callee = expr.callee;

  // Static method: ClassName.method(...)
  if (callee.object.kind === "Identifier" && !scope.has(callee.object.name)) {
    const classDef = activeClasses.get(callee.object.name);
    if (classDef) {
      const method = classDef.staticMethods.find(
        (m) => m.name === callee.property.name,
      );
      if (!method) {
        diagnostics.error(
          `Unknown static method '${callee.property.name}' on class '${classDef.localName}'`,
          callee.property.span,
          "E0324",
        );
        return null;
      }
      if (
        !canAccessMember(
          method.visibility,
          method.implementingClass,
          diagnostics,
          callee.property.span,
        )
      ) {
        return null;
      }
      return checkMethodArgs(
        method.name,
        method.params,
        method.decl?.params ?? null,
        method.returnType,
        expr,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      );
    }
  }

  const objectType = checkExpression(
    callee.object,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
  );
  if (!objectType) {
    return null;
  }

  let resolvedObjectType: ValueType = objectType;
  if (expr.optional) {
    if (objectType === "null") {
      return "null";
    }
    if (isUnionType(objectType) && includesNull(objectType)) {
      resolvedObjectType = stripNull(objectType) as ValueType;
    }
  }

  const wrapOptionalCall = (result: ValueType | null): ValueType | null => {
    if (!result || !expr.optional) {
      return result;
    }
    return makeUnion([result, "null"]) as ValueType;
  };

  if (isStructType(resolvedObjectType)) {
    const def =
      findStructByTypeName(structs, resolvedObjectType.name) ??
      findStructInNamespaces(resolvedObjectType.name);
    if (!def) {
      diagnostics.error(
        `Unknown struct '${resolvedObjectType.name}'`,
        callee.object.span,
        "E0104",
      );
      return null;
    }
    const method = def.methods.find((m) => m.name === callee.property.name);
    if (!method) {
      diagnostics.error(
        `Unknown method '${callee.property.name}' on struct '${def.decl.name.name}'`,
        callee.property.span,
        "E0324",
      );
      return null;
    }
    return wrapOptionalCall(
      checkMethodArgs(
        method.name,
        method.params,
        method.decl.params,
        method.returnType,
        expr,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      ),
    );
  }

  if (isClassType(resolvedObjectType)) {
    const def = findClassByMangled(resolvedObjectType.name);
    if (!def) {
      diagnostics.error(
        `Unknown class '${resolvedObjectType.name}'`,
        callee.object.span,
        "E0104",
      );
      return null;
    }
    let method = def.instanceMethods.find(
      (m) => m.name === callee.property.name,
    );
    // Generic method on (possibly specialized) class.
    if (!method) {
      const genericMethod = def.decl.members.find(
        (m): m is ClassMethod =>
          m.kind === "ClassMethod" &&
          !m.isStatic &&
          m.name.name === callee.property.name &&
          m.typeParams.length > 0,
      );
      if (genericMethod) {
        return wrapOptionalCall(
          checkGenericMethodCall(
            expr,
            def,
            genericMethod,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
            allowVoidCall,
          ),
        );
      }
    }
    if (!method) {
      diagnostics.error(
        `Unknown method '${callee.property.name}' on class '${def.localName}'`,
        callee.property.span,
        "E0324",
      );
      return null;
    }
    if (
      !canAccessMember(
        method.visibility,
        method.implementingClass,
        diagnostics,
        callee.property.span,
      )
    ) {
      return null;
    }
    return wrapOptionalCall(
      checkMethodArgs(
        method.name,
        method.params,
        method.decl?.params ?? null,
        method.returnType,
        expr,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      ),
    );
  }

  if (isInterfaceType(resolvedObjectType)) {
    const def = findInterfaceByMangled(resolvedObjectType.name);
    if (!def) {
      diagnostics.error(
        `Unknown interface '${resolvedObjectType.name}'`,
        callee.object.span,
        "E0104",
      );
      return null;
    }
    const method = def.methods.find((m) => m.name === callee.property.name);
    if (!method) {
      diagnostics.error(
        `Unknown method '${callee.property.name}' on interface '${def.localName}'`,
        callee.property.span,
        "E0324",
      );
      return null;
    }
    return wrapOptionalCall(
      checkMethodArgs(
        method.name,
        method.params,
        findInterfaceMethodParams(def, method.name),
        method.returnType,
        expr,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      ),
    );
  }

  if (
    typeof resolvedObjectType === "object" &&
    resolvedObjectType.kind === "typeParam"
  ) {
    const arms =
      resolvedObjectType.constraintArms.length > 0
        ? resolvedObjectType.constraintArms
        : resolvedObjectType.constraintName && resolvedObjectType.constraintKind
          ? [
              {
                kind: resolvedObjectType.constraintKind,
                name: resolvedObjectType.constraintName,
              },
            ]
          : [];
    if (arms.length > 0) {
      for (const arm of arms) {
        if (arm.kind !== "interface") {
          continue;
        }
        const def = findInterfaceByMangled(arm.name);
        if (!def) {
          continue;
        }
        const method = def.methods.find((m) => m.name === callee.property.name);
        if (!method) {
          continue;
        }
        return wrapOptionalCall(
          checkMethodArgs(
            method.name,
            method.params,
            findInterfaceMethodParams(def, method.name),
            method.returnType,
            expr,
            scope,
            functions,
            structs,
            enums,
            diagnostics,
            allowVoidCall,
          ),
        );
      }
      diagnostics.error(
        `Unknown method '${callee.property.name}' on constraint '${typeToString(resolvedObjectType)}'`,
        callee.property.span,
        "E0324",
      );
      return null;
    }
  }

  // Extension methods (prelude / imported): receiver.method(args) → method(receiver, args)
  const extensionResult = checkExtensionMethodCall(
    expr,
    callee.property.name,
    resolvedObjectType,
    scope,
    functions,
    structs,
    enums,
    diagnostics,
    allowVoidCall,
  );
  if (extensionResult !== undefined) {
    return wrapOptionalCall(extensionResult);
  }

  diagnostics.error(
    `Unknown method '${callee.property.name}' on type '${typeToString(resolvedObjectType)}'`,
    callee.property.span,
    "E0324",
  );
  return null;
}

/**
 * Try to resolve an extension method. Returns `undefined` if no extension matches the name
 * (caller should report unknown method). Returns `null` if a match failed type-checking.
 */
function checkExtensionMethodCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  methodName: string,
  receiverType: ValueType,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null | undefined {
  const candidates = activeExtensions.filter((e) => e.name === methodName);
  if (candidates.length === 0) {
    return undefined;
  }

  for (const entry of candidates) {
    if (entry.kind === "concrete" && entry.sig) {
      const sig = entry.sig;
      const expectedReceiver = sig.params[0];
      if (!expectedReceiver || !isAssignable(receiverType, expectedReceiver)) {
        continue;
      }
      instantiationCollector.extensionCallRewrites.set(
        expr.span.start.offset,
        sig.mangledName,
      );
      const callParams = sig.params.slice(1);
      const callParamDecls = sig.decl.params.slice(1);
      return checkMethodArgs(
        methodName,
        callParams,
        callParamDecls,
        sig.returnType,
        expr,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      );
    }

    if (entry.kind === "generic" && entry.template) {
      const result = checkGenericExtensionCall(
        expr,
        entry.template,
        receiverType,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
        allowVoidCall,
      );
      if (result !== undefined) {
        return result;
      }
    }
  }

  // Name matched but no receiver type fit — treat as unknown for this type.
  return undefined;
}

function checkGenericExtensionCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  tpl: GenericFunctionTemplate,
  receiverType: ValueType,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null | undefined {
  const receiverAnn = tpl.decl.params[0]?.typeAnnotation;
  if (!receiverAnn) {
    return undefined;
  }

  // Build synthetic arg list: receiver + call args for inference against full param list.
  const mapped = mapCallArgumentsToSlots(
    expr.args,
    "method",
    tpl.decl.name.name,
    tpl.decl.params.slice(1),
    expr.span,
    diagnostics,
  );
  if (!mapped) {
    return null;
  }

  const providedAnns: TypeAnnotation[] = [receiverAnn];
  const providedTypes: ValueType[] = [receiverType];

  // Infer T (and any other non-callback params) from the receiver first.
  const partialFromReceiver = inferTypeArgsPartial(
    tpl.decl.typeParams,
    [receiverAnn],
    [receiverType],
  );

  for (let i = 1; i < tpl.decl.params.length; i += 1) {
    const slot = mapped.slots[i - 1];
    if (slot === undefined) {
      continue;
    }
    const paramAnn = tpl.decl.params[i]!.typeAnnotation;
    let t: ValueType | null = null;

    // Untyped lambdas: contextualize params from partially inferred type args (receiver),
    // then take the body return type as the function return (to solve U in (T) => U).
    if (
      slot.kind === "LambdaExpression" &&
      paramAnn.kind === "FunctionType" &&
      partialFromReceiver
    ) {
      const substEarly = new Map<string, TypeAnnotation>();
      for (let ti = 0; ti < tpl.decl.typeParams.length; ti += 1) {
        const sol = partialFromReceiver[ti];
        if (sol) {
          substEarly.set(tpl.decl.typeParams[ti]!.name.name, sol);
        }
      }
      const subEarly = (ann: TypeAnnotation): TypeAnnotation =>
        substituteAnnotation(ann, substEarly);
      const expectedParams: ValueType[] = [];
      let paramsOk = true;
      for (const pAnn of paramAnn.params) {
        const substituted = subEarly(pAnn);
        // Unsolved type params (e.g. U in reduce's `(U, T) => U`) cannot contextualize yet.
        if (
          substituted.kind === "NamedType" &&
          substituted.namespace === null &&
          substituted.typeArgs.length === 0 &&
          tpl.decl.typeParams.some((tp) => tp.name.name === substituted.name)
        ) {
          paramsOk = false;
          break;
        }
        const pt = resolveAnnotation(substituted, structs, enums, diagnostics);
        if (!pt || (typeof pt === "object" && pt.kind === "typeParam")) {
          paramsOk = false;
          break;
        }
        expectedParams.push(pt);
      }
      if (paramsOk && slot.params.length === expectedParams.length) {
        const childScope = new Map(scope);
        let lambdaOk = true;
        for (let pi = 0; pi < slot.params.length; pi += 1) {
          const lp = slot.params[pi]!;
          if (lp.typeAnnotation) {
            const annotated = resolveAnnotation(
              lp.typeAnnotation,
              structs,
              enums,
              diagnostics,
            );
            if (!annotated || !typesEqual(annotated, expectedParams[pi]!)) {
              lambdaOk = false;
              break;
            }
          }
          childScope.set(lp.name.name, {
            type: expectedParams[pi]!,
            mutable: false,
          });
        }
        if (lambdaOk && slot.body.kind === "expression") {
          lambdaDepth += 1;
          const bodyType = checkExpression(
            slot.body.expression,
            childScope,
            functions,
            structs,
            enums,
            diagnostics,
          );
          lambdaDepth -= 1;
          if (bodyType) {
            t = {
              kind: "function",
              params: expectedParams,
              returnType: bodyType,
            };
          }
        }
      }
    }

    if (!t) {
      t = checkExpression(slot, scope, functions, structs, enums, diagnostics);
    }
    if (!t) {
      return null;
    }
    providedAnns.push(paramAnn);
    providedTypes.push(t);
  }

  let typeArgs = expr.typeArgs;
  if (typeArgs.length === 0) {
    const inferred = inferTypeArgs(
      tpl.decl.typeParams,
      providedAnns,
      providedTypes,
    );
    if (inferred) {
      typeArgs = inferred;
    }
  }

  if (typeArgs.length === 0) {
    return undefined;
  }
  if (
    !checkTypeArgArity(
      tpl.decl.name.name,
      tpl.decl.typeParams,
      typeArgs,
      expr.span,
      diagnostics,
    )
  ) {
    return null;
  }

  const resolvedArgTypes: ValueType[] = [];
  let hasTypeParamArg = false;
  for (const arg of typeArgs) {
    const vt = resolveAnnotation(arg, structs, enums, diagnostics);
    if (vt === null) {
      return null;
    }
    if (typeof vt === "object" && vt.kind === "typeParam") {
      hasTypeParamArg = true;
    }
    resolvedArgTypes.push(vt);
  }

  if (!hasTypeParamArg) {
    if (
      !checkConstraints(
        tpl.decl.typeParams,
        typeArgs,
        structs,
        enums,
        diagnostics,
        expr.span,
      )
    ) {
      return null;
    }
    const instanceLocal = mangleFunctionInstance(tpl.decl.name.name, typeArgs);
    const mangled = mangleSymbol(tpl.moduleId, instanceLocal);
    instantiationCollector.extensionCallRewrites.set(
      expr.span.start.offset,
      mangled,
    );
    instantiationCollector.add({
      kind: "function",
      instanceLocalName: instanceLocal,
      moduleId: tpl.moduleId,
      modulePath: tpl.modulePath,
      templateLocalName: tpl.decl.name.name,
      typeArgs,
    });
  }

  const subst = new Map<string, TypeAnnotation>();
  for (let i = 0; i < tpl.decl.typeParams.length; i += 1) {
    subst.set(tpl.decl.typeParams[i]!.name.name, typeArgs[i]!);
  }
  const sub = (ann: TypeAnnotation): TypeAnnotation =>
    substituteAnnotation(ann, subst);

  const expectedReceiver = resolveAnnotation(
    sub(receiverAnn),
    structs,
    enums,
    diagnostics,
  );
  if (
    expectedReceiver === null ||
    !isAssignable(receiverType, expectedReceiver)
  ) {
    return undefined;
  }

  const callParamDecls = tpl.decl.params.slice(1);
  const paramTypes: ValueType[] = [];
  for (const param of callParamDecls) {
    const expected = resolveAnnotation(
      sub(param.typeAnnotation),
      structs,
      enums,
      diagnostics,
    );
    if (expected === null) {
      return null;
    }
    paramTypes.push(expected);
  }

  if (
    !checkDeclarationCallArgs(
      expr,
      "method",
      tpl.decl.name.name,
      callParamDecls,
      paramTypes,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
      (defaultExpr) => substituteExpression(defaultExpr, subst),
    )
  ) {
    return null;
  }

  const returnType = resolveReturnType(
    sub(tpl.decl.returnType),
    structs,
    enums,
    diagnostics,
  );
  if (returnType === undefined) {
    return null;
  }
  if (returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(
        `Void method '${tpl.decl.name.name}' cannot be used as a value`,
        expr.span,
        "E0309",
      );
    }
    return null;
  }
  void resolvedArgTypes;
  return returnType;
}

function checkGenericMethodCall(
  expr: Extract<Expression, { kind: "CallExpression" }>,
  classDef: ClassDef,
  method: ClassMethod,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null {
  const mapped = mapCallArgumentsToSlots(
    expr.args,
    "method",
    method.name.name,
    method.params,
    expr.span,
    diagnostics,
  );
  if (!mapped) {
    return null;
  }

  const providedAnns: TypeAnnotation[] = [];
  const providedTypes: ValueType[] = [];
  for (let i = 0; i < method.params.length; i += 1) {
    const slot = mapped.slots[i];
    if (slot === undefined) {
      continue;
    }
    const t = checkExpression(
      slot,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
    );
    if (!t) {
      return null;
    }
    providedAnns.push(method.params[i]!.typeAnnotation);
    providedTypes.push(t);
  }

  let typeArgs = expr.typeArgs;
  if (typeArgs.length === 0) {
    const inferred = inferTypeArgs(
      method.typeParams,
      providedAnns,
      providedTypes,
    );
    if (!inferred) {
      diagnostics.error(
        `Cannot infer type arguments for method '${method.name.name}'`,
        expr.span,
        "E0385",
      );
      return null;
    }
    typeArgs = inferred;
  }
  if (
    !checkTypeArgArity(
      method.name.name,
      method.typeParams,
      typeArgs,
      expr.span,
      diagnostics,
    )
  ) {
    return null;
  }
  if (
    !checkConstraints(
      method.typeParams,
      typeArgs,
      structs,
      enums,
      diagnostics,
      expr.span,
    )
  ) {
    return null;
  }

  const methodLocalName =
    typeArgs.length === 0
      ? method.name.name
      : `${method.name.name}__${typeArgs
          .map((a) => {
            if (a.kind === "PrimitiveType") return a.name;
            if (a.kind === "ArrayType") return `arr`;
            if (a.kind === "NamedType") return a.name;
            return a.kind;
          })
          .join("__")}`;

  instantiationCollector.methodCallRewrites.set(
    expr.span.start.offset,
    methodLocalName,
  );
  instantiationCollector.add({
    kind: "classMethod",
    instanceLocalName: methodLocalName,
    moduleId: activeModuleId,
    modulePath: activeModulePath,
    templateLocalName: classDef.decl.name.name,
    typeArgs,
    ownerInstanceLocalName: classDef.localName,
    methodTemplateName: method.name.name,
    ownerTypeArgs: [],
    methodTypeArgs: typeArgs,
  });

  const subst = buildSubst(method.typeParams, typeArgs);
  const sub = (ann: TypeAnnotation): TypeAnnotation =>
    substituteAnnotation(ann, subst);

  const paramTypes: ValueType[] = [];
  for (const param of method.params) {
    const expected = resolveAnnotation(
      sub(param.typeAnnotation),
      structs,
      enums,
      diagnostics,
    );
    if (expected === null) {
      return null;
    }
    paramTypes.push(expected);
  }

  if (
    !checkDeclarationCallArgs(
      expr,
      "method",
      method.name.name,
      method.params,
      paramTypes,
      scope,
      functions,
      structs,
      enums,
      diagnostics,
      (defaultExpr) => substituteExpression(defaultExpr, subst),
    )
  ) {
    return null;
  }

  const returnType = resolveReturnType(
    sub(method.returnType),
    structs,
    enums,
    diagnostics,
  );
  if (returnType === undefined) {
    return null;
  }
  if (returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(
        `Void method '${method.name.name}' cannot be used as a value`,
        expr.span,
        "E0309",
      );
    }
    return null;
  }
  return returnType;
}

function checkMethodArgs(
  name: string,
  params: ValueType[],
  paramDecls: readonly Parameter[] | null,
  returnType: ReturnType,
  expr: Extract<Expression, { kind: "CallExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null {
  if (paramDecls && paramDecls.length === params.length) {
    if (
      !checkDeclarationCallArgs(
        expr,
        "method",
        name,
        paramDecls,
        params,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      )
    ) {
      return null;
    }
  } else {
    if (!rejectNamedArgsOnFunctionValue(expr.args, diagnostics)) {
      return null;
    }
    if (expr.args.length !== params.length) {
      diagnostics.error(
        `Method '${name}' expects ${params.length} argument(s), got ${expr.args.length}`,
        expr.span,
        "E0315",
      );
      return null;
    }
    for (let i = 0; i < expr.args.length; i += 1) {
      const arg = expr.args[i]! as Expression;
      const expected = params[i]!;
      const argType = checkExpression(
        arg,
        scope,
        functions,
        structs,
        enums,
        diagnostics,
      );
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
  }
  if (returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(
        `Void method '${name}' cannot be used as a value`,
        expr.span,
        "E0309",
      );
    }
    return null;
  }
  return returnType;
}

function supportsEquality(type: ValueType): boolean {
  if (typeof type === "string") {
    return EQUALITY_PRIMITIVES.has(type);
  }
  // Reference types and unions support == / != (especially vs null)
  return (
    type.kind === "enum" ||
    type.kind === "class" ||
    type.kind === "interface" ||
    type.kind === "array" ||
    type.kind === "map" ||
    type.kind === "union" ||
    type.kind === "object"
  );
}

function typeMismatchMessage(
  expected: ValueType | PrimitiveTypeName,
  got: ValueType | PrimitiveTypeName,
): string {
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
  const isEquality = operator === "==" || operator === "!=";

  // null comparisons: null == null, or T|null == null, or class/string == null, etc.
  if (isEquality && (left === "null" || right === "null")) {
    const other = left === "null" ? right : left;
    if (
      other === "null" ||
      other === "string" ||
      includesNull(other) ||
      isUnionType(other) ||
      (typeof other === "object" &&
        (other.kind === "class" ||
          other.kind === "interface" ||
          other.kind === "array" ||
          other.kind === "map" ||
          other.kind === "object"))
    ) {
      return "bool";
    }
    if (supportsEquality(other)) {
      return "bool";
    }
    diagnostics.error(
      `Operator '${operator}' cannot compare type '${typeToString(other)}' with null`,
      span,
      "E0306",
    );
    return null;
  }

  if (!typesEqual(left, right)) {
    // Allow comparing a union to one of its arms for equality (rare); otherwise error
    if (
      isEquality &&
      ((isUnionType(left) && isAssignable(right, left)) ||
        (isUnionType(right) && isAssignable(left, right)))
    ) {
      return "bool";
    }
    diagnostics.error(
      `Operator '${operator}' requires matching operand types, got '${typeToString(left)}' and '${typeToString(right)}'`,
      span,
      "E0306",
    );
    return null;
  }

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
  if (isAssignable(inferred, expected)) {
    return true;
  }
  // Literal values against literal / union-of-literals targets
  if (value.kind === "StringLiteral") {
    const lit: LiteralValueType = {
      kind: "literal",
      value: value.value,
      literalKind: "string",
    };
    if (isAssignable(lit, expected)) {
      return true;
    }
  }
  if (value.kind === "IntegerLiteral") {
    const lit: LiteralValueType = {
      kind: "literal",
      value: value.value,
      literalKind: "number",
    };
    if (isAssignable(lit, expected)) {
      return true;
    }
  }
  // Array literal width coercion for elements is handled per-element; here for whole value:
  if (
    value.kind === "IntegerLiteral" &&
    (expected === "i32" || expected === "i64")
  ) {
    return true;
  }
  if (
    value.kind === "FloatLiteral" &&
    (expected === "f32" || expected === "f64")
  ) {
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
  if (
    value.kind === "ArrayLiteral" &&
    isTupleType(inferred) &&
    isTupleType(expected)
  ) {
    if (value.elements.length !== expected.elements.length) {
      return false;
    }
    return value.elements.every((el, i) => {
      const elType = inferred.elements[i]!;
      return valueMatchesBinding(el, elType, expected.elements[i]!);
    });
  }
  return false;
}
