import type {
  ClassDeclaration,
  ClassMethod,
  ConstructorDeclaration,
  EnumDeclaration,
  Expression,
  FunctionDeclaration,
  InterfaceDeclaration,
  PrimitiveTypeName,
  Program,
  Statement,
  StructDeclaration,
  StructMethod,
  TypeAnnotation,
  TypeParameter,
  Visibility,
} from "./ast/nodes.js";
import type { DiagnosticCollector, SourceSpan } from "./diagnostics/diagnostic.js";
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
import { buildSubst, specializeStructDecl, substituteAnnotation } from "./generics/substitute.js";
import type { TypecheckInstantiations } from "./generics/monomorphize.js";
import { mangleSymbol } from "./modules/mangle.js";
import type { ResolvedModule } from "./modules/resolve.js";

export type PrimitiveValueType = Exclude<PrimitiveTypeName, "void">;

export interface ArrayValueType {
  readonly kind: "array";
  readonly element: ValueType;
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
}

export type ValueType =
  | PrimitiveValueType
  | ArrayValueType
  | StructValueType
  | ClassValueType
  | InterfaceValueType
  | EnumValueType
  | TypeParamValueType;

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
  /** LLVM field index in the instance object (0 = vtable); -1 for static. */
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
  /** Instance fields in layout order (after vtable slot). */
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
}

interface FunctionSig {
  readonly name: string;
  readonly mangledName: string;
  readonly params: ValueType[];
  readonly returnType: ReturnType;
  readonly decl: FunctionDeclaration;
  readonly exported: boolean;
}

export interface ModuleNamespace {
  readonly moduleId: string;
  readonly functions: ReadonlyMap<string, FunctionSig>;
  readonly structs: ReadonlyMap<string, StructDef>;
  readonly enums: ReadonlyMap<string, EnumDef>;
  readonly classes: ReadonlyMap<string, ClassDef>;
  readonly interfaces: ReadonlyMap<string, InterfaceDef>;
}

interface ModuleSymbols {
  readonly moduleId: string;
  readonly modulePath: string;
  readonly functions: Map<string, FunctionSig>;
  readonly structs: Map<string, StructDef>;
  readonly enums: Map<string, EnumDef>;
  readonly classes: Map<string, ClassDef>;
  readonly interfaces: Map<string, InterfaceDef>;
  readonly genericStructs: Map<string, GenericStructTemplate>;
  readonly genericClasses: Map<string, GenericClassTemplate>;
  readonly genericInterfaces: Map<string, GenericInterfaceTemplate>;
  readonly genericFunctions: Map<string, GenericFunctionTemplate>;
}

interface MemberContext {
  readonly thisType: ValueType;
  readonly enclosingClass: ClassDef | null;
  readonly enclosingStruct: StructDef | null;
  readonly isConstructor: boolean;
  readonly isStatic: boolean;
}

const NUMERIC_PRIMITIVES = new Set<PrimitiveValueType>(["i32", "i64", "f32", "f64"]);
const EQUALITY_PRIMITIVES = new Set<PrimitiveValueType>(["i32", "i64", "f32", "f64", "bool", "char"]);

/** Active import namespaces while type-checking a module. */
let activeNamespaces: Map<string, ModuleNamespace> = new Map();
/** Active class defs for the module under check (local name → def). */
let activeClasses: Map<string, ClassDef> = new Map();
/** Active interface defs for the module under check (local name → def). */
let activeInterfaces: Map<string, InterfaceDef> = new Map();
/** All class defs by mangled name (for inheritance lookups). */
let classesByMangled: Map<string, ClassDef> = new Map();
/** All interface defs by mangled name. */
let interfacesByMangled: Map<string, InterfaceDef> = new Map();
let memberContext: MemberContext | null = null;
/** Type parameters in scope while checking a generic template. */
let activeTypeParams: Map<string, TypeParamValueType> = new Map();
/** Instantiation collector for the current typecheck run. */
let instantiationCollector: InstantiationCollector = new InstantiationCollector();
/** Module currently being checked (for instantiation records). */
let activeModulePath = "";
let activeModuleId = "";
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
): TypecheckInstantiations {
  for (const decl of program.body) {
    if (decl.kind === "ImportDeclaration") {
      diagnostics.error(
        "Import declarations require compiling from a file path (use compileFile)",
        decl.span,
        "E0400",
      );
      return new InstantiationCollector().snapshot();
    }
  }

  return typecheckModules(
    [
      {
        path: "<source>",
        source: "",
        ast: program,
        moduleId: "",
        isEntry: true,
        imports: [],
      },
    ],
    diagnostics,
  );
}

/**
 * Type-check a multi-module compilation unit.
 */
export function typecheckModules(
  modules: readonly ResolvedModule[],
  diagnostics: DiagnosticCollector,
): TypecheckInstantiations {
  instantiationCollector = new InstantiationCollector();
  allModuleSymbols = new Map();
  const byPath = new Map<string, ModuleSymbols>();

  for (const mod of modules) {
    const symbols = collectModuleSymbols(mod, diagnostics);
    byPath.set(mod.path, symbols);
    allModuleSymbols.set(mod.path, symbols);
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

  if (diagnostics.hasErrors) {
    return instantiationCollector.snapshot();
  }

  for (const mod of modules) {
    const local = byPath.get(mod.path)!;
    const namespaces = new Map<string, ModuleNamespace>();

    const localNames = new Set<string>([
      ...local.functions.keys(),
      ...local.structs.keys(),
      ...local.enums.keys(),
      ...local.classes.keys(),
      ...local.interfaces.keys(),
      ...local.genericStructs.keys(),
      ...local.genericClasses.keys(),
      ...local.genericInterfaces.keys(),
      ...local.genericFunctions.keys(),
    ]);

    for (const binding of mod.imports) {
      if (localNames.has(binding.alias)) {
        diagnostics.error(
          `Import namespace '${binding.alias}' conflicts with a local declaration`,
          binding.span,
          "E0405",
        );
        continue;
      }
      const imported = byPath.get(binding.modulePath);
      if (!imported) {
        continue;
      }
      namespaces.set(binding.alias, {
        moduleId: imported.moduleId,
        functions: exportedFunctions(imported.functions),
        structs: exportedStructs(imported.structs),
        enums: exportedEnums(imported.enums),
        classes: exportedClasses(imported.classes),
        interfaces: exportedInterfaces(imported.interfaces),
      });
    }

    if (diagnostics.hasErrors) {
      continue;
    }

    activeNamespaces = namespaces;
    activeClasses = local.classes;
    activeInterfaces = local.interfaces;
    activeGenericStructs = local.genericStructs;
    activeGenericClasses = local.genericClasses;
    activeGenericInterfaces = local.genericInterfaces;
    activeGenericFunctions = local.genericFunctions;
    activeModulePath = mod.path;
    activeModuleId = mod.moduleId;
    specializedStructs = new Map();
    specializedClasses = new Map();
    specializedInterfaces = new Map();
    specializedFunctions = new Map();

    for (const decl of mod.ast.body) {
      if (decl.kind === "FunctionDeclaration") {
        if (decl.typeParams.length > 0) {
          checkGenericFunctionTemplate(decl, local.functions, local.structs, local.enums, diagnostics);
        } else {
          checkFunction(decl, local.functions, local.structs, local.enums, diagnostics);
        }
      } else if (decl.kind === "StructDeclaration") {
        if (decl.typeParams.length > 0) {
          checkGenericStructTemplate(decl, local.functions, local.structs, local.enums, diagnostics);
        } else {
          const def = local.structs.get(decl.name.name);
          if (def) {
            checkStructMethods(def, local.functions, local.structs, local.enums, diagnostics);
          }
        }
      } else if (decl.kind === "ClassDeclaration") {
        if (decl.typeParams.length > 0) {
          checkGenericClassTemplate(decl, local.functions, local.structs, local.enums, diagnostics);
        } else {
          const def = local.classes.get(decl.name.name);
          if (def) {
            checkClassMembers(def, local.functions, local.structs, local.enums, diagnostics);
          }
        }
      }
    }
  }

  activeNamespaces = new Map();
  activeClasses = new Map();
  activeInterfaces = new Map();
  classesByMangled = new Map();
  interfacesByMangled = new Map();
  memberContext = null;
  activeTypeParams = new Map();
  activeGenericStructs = new Map();
  activeGenericClasses = new Map();
  activeGenericInterfaces = new Map();
  activeGenericFunctions = new Map();
  allModuleSymbols = new Map();

  return instantiationCollector.snapshot();
}

function exportedFunctions(fns: Map<string, FunctionSig>): Map<string, FunctionSig> {
  const out = new Map<string, FunctionSig>();
  for (const [name, sig] of fns) {
    if (sig.exported) {
      out.set(name, sig);
    }
  }
  return out;
}

function exportedStructs(structs: Map<string, StructDef>): Map<string, StructDef> {
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

function exportedClasses(classes: Map<string, ClassDef>): Map<string, ClassDef> {
  const out = new Map<string, ClassDef>();
  for (const [name, def] of classes) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
}

function exportedInterfaces(interfaces: Map<string, InterfaceDef>): Map<string, InterfaceDef> {
  const out = new Map<string, InterfaceDef>();
  for (const [name, def] of interfaces) {
    if (def.exported) {
      out.set(name, def);
    }
  }
  return out;
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
    } else if (decl.kind === "InterfaceDeclaration" && decl.typeParams.length > 0) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericInterfaces.set(decl.name.name, {
          decl,
          moduleId: mod.moduleId,
          modulePath: mod.path,
        });
      }
    } else if (decl.kind === "FunctionDeclaration" && decl.typeParams.length > 0) {
      if (validateTypeParamList(decl.typeParams, diagnostics)) {
        genericFunctions.set(decl.name.name, {
          decl,
          moduleId: mod.moduleId,
          modulePath: mod.path,
        });
      }
    }
  }

  const structs = collectStructs(mod.ast, mod.moduleId, enums, diagnostics, genericStructs);
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
  activeClasses = classes;
  activeInterfaces = interfaces;

  for (const decl of mod.ast.body) {
    if (decl.kind !== "FunctionDeclaration" || decl.typeParams.length > 0) {
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
      const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
      if (paramType === null) {
        paramsOk = false;
        continue;
      }
      params.push(paramType);
    }

    if (!paramsOk) {
      continue;
    }

    const returnType = resolveReturnType(fn.returnType, structs, enums, diagnostics);
    if (returnType === undefined) {
      continue;
    }

    functions.set(fn.name.name, {
      name: fn.name.name,
      mangledName: fn.name.name === "main" ? "main" : mangleSymbol(mod.moduleId, fn.name.name),
      params,
      returnType,
      decl: fn,
      exported: fn.exported,
    });
  }

  activeClasses = prevClasses;
  activeInterfaces = prevInterfaces;

  return {
    moduleId: mod.moduleId,
    modulePath: mod.path,
    functions,
    structs,
    enums,
    classes,
    interfaces,
    genericStructs,
    genericClasses,
    genericInterfaces,
    genericFunctions,
  };
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
    if (decl.kind === "ClassDeclaration" || decl.kind === "InterfaceDeclaration") {
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

    if (structs.has(decl.name.name) || declarations.some((d) => d.name.name === decl.name.name)) {
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

      const fieldType = resolveAnnotation(field.typeAnnotation, structs, enums, diagnostics);
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
        const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
        if (paramType === null) {
          paramsOk = false;
          continue;
        }
        params.push(paramType);
      }
      const returnType = resolveReturnType(method.returnType, structs, enums, diagnostics);
      if (returnType === undefined || !paramsOk) {
        ok = false;
        continue;
      }
      methods.push({
        name: method.name.name,
        mangledName: mangleSymbol(moduleId, `${decl.name.name}__${method.name.name}`),
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
      diagnostics.error(`Duplicate interface '${decl.name.name}'`, decl.name.span, "E0328");
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
        diagnostics.error(`Unknown interface '${baseType.name}'`, baseType.span, "E0104");
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
            !existing.params.every((p, i) => typesEqual(p, method.params[i]!)) ||
            (existing.returnType === "void") !== (method.returnType === "void") ||
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
        const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
        if (paramType === null) {
          paramsOk = false;
          continue;
        }
        params.push(paramType);
      }
      const returnType = resolveReturnType(method.returnType, structs, enums, diagnostics);
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

    const def: InterfaceDef = {
      name: mangled,
      localName,
      bases,
      methods,
      baseItableOffsets,
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
    if (decl.typeParams.length > 0) {
      continue;
    }
    if (byLocal.has(decl.name.name) || genericClasses.has(decl.name.name)) {
      diagnostics.error(`Duplicate class '${decl.name.name}'`, decl.name.span, "E0328");
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
      constructorMangledName: mangleSymbol(moduleId, `${decl.name.name}__constructor`),
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
          diagnostics.error(`Unknown interface '${ifaceType.name}'`, ifaceType.span, "E0104");
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

    const instanceFields: ClassFieldDef[] = superclass ? [...superclass.instanceFields] : [];
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
          if (staticNames.has(member.name.name) || methodNames.has(member.name.name)) {
            diagnostics.error(
              `Duplicate member '${member.name.name}' in class '${localName}'`,
              member.name.span,
              "E0329",
            );
            ok = false;
            continue;
          }
          staticNames.add(member.name.name);
          const fieldType = resolveAnnotation(member.typeAnnotation, structs, enums, diagnostics);
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
          const fieldType = resolveAnnotation(member.typeAnnotation, structs, enums, diagnostics);
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
            fieldIndex: instanceFields.length + 1, // +1 for vtable
            initializer: null,
          });
        }
        continue;
      }

      // ClassMethod
      if (methodNames.has(member.name.name) || staticNames.has(member.name.name)) {
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
    const instanceMethods: ClassMethodDef[] = baseMethods.map((m) => ({ ...m }));
    const staticMethods: ClassMethodDef[] = [];
    const slotByName = new Map(instanceMethods.map((m, i) => [m.name, i]));

    for (const method of ownMethods) {
      const params: ValueType[] = [];
      let paramsOk = true;
      for (const param of method.params) {
        const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
        if (paramType === null) {
          paramsOk = false;
          continue;
        }
        params.push(paramType);
      }
      const returnType = resolveReturnType(method.returnType, structs, enums, diagnostics);
      if (returnType === undefined || !paramsOk) {
        ok = false;
        continue;
      }

      const mangledMethod = mangleSymbol(moduleId, `${localName}__${method.name.name}`);

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
        const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
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
      constructorMangledName: mangleSymbol(moduleId, `${localName}__constructor`),
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
  if (typeof type === "string") {
    return type;
  }
  if (type.kind === "array") {
    return `${typeToString(type.element)}[]`;
  }
  if (type.kind === "typeParam") {
    return type.constraintName
      ? `${type.name} extends ${type.constraintName}`
      : type.name;
  }
  return type.name;
}

export function typesEqual(a: ValueType, b: ValueType): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a === "object" && typeof b === "object") {
    if (a.kind === "array" && b.kind === "array") {
      return typesEqual(a.element, b.element);
    }
    if (a.kind === "typeParam" && b.kind === "typeParam") {
      return a.name === b.name;
    }
    if (a.kind === "struct" && b.kind === "struct") {
      return a.name === b.name;
    }
    if (a.kind === "class" && b.kind === "class") {
      return a.name === b.name;
    }
    if (a.kind === "interface" && b.kind === "interface") {
      return a.name === b.name;
    }
    if (a.kind === "enum" && b.kind === "enum") {
      return a.name === b.name;
    }
  }
  return false;
}

/** True if `from` can be assigned to a binding of type `to` (includes class/interface upcasts). */
export function isAssignable(from: ValueType, to: ValueType): boolean {
  if (typesEqual(from, to)) {
    return true;
  }
  if (isClassType(from) && isClassType(to)) {
    let current: ClassDef | undefined = classesByMangled.get(from.name) ?? findClassByMangled(from.name);
    while (current) {
      if (current.name === to.name) {
        return true;
      }
      current = current.superclass ?? undefined;
    }
  }
  if (isClassType(from) && isInterfaceType(to)) {
    const cls = classesByMangled.get(from.name) ?? findClassByMangled(from.name);
    const iface = interfacesByMangled.get(to.name) ?? findInterfaceByMangled(to.name);
    if (cls && iface && classSatisfiesInterface(cls, iface)) {
      return true;
    }
  }
  if (isInterfaceType(from) && isInterfaceType(to)) {
    const fromIface = interfacesByMangled.get(from.name) ?? findInterfaceByMangled(from.name);
    if (fromIface && fromIface.baseItableOffsets.has(to.name)) {
      return true;
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

export function isClassType(type: ValueType): type is ClassValueType {
  return typeof type === "object" && type.kind === "class";
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
  if (ann.kind === "PrimitiveType") {
    if (ann.name === "void") {
      return null;
    }
    return ann.name;
  }
  if (ann.kind === "NamedType") {
    const key = ann.namespace ? `${ann.namespace}.${ann.name}` : ann.name;
    const kind = namedKinds?.get(key) ?? "struct";
    return { kind, name: key };
  }
  const element = annotationToValueType(ann.element, namedKinds);
  if (element === null) {
    return null;
  }
  return { kind: "array", element };
}

function resolveAnnotation(
  ann: TypeAnnotation,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
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
    // Type parameter in scope (template body).
    if (ann.namespace === null && ann.typeArgs.length === 0 && activeTypeParams.has(ann.name)) {
      return activeTypeParams.get(ann.name)!;
    }

    // Generic instantiation: Foo<T, U>
    if (ann.typeArgs.length > 0) {
      return resolveGenericNamedType(ann, structs, enums, diagnostics);
    }

    if (ann.namespace) {
      const ns = activeNamespaces.get(ann.namespace);
      if (!ns) {
        diagnostics.error(`Unknown namespace '${ann.namespace}'`, ann.span, "E0406");
        return null;
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
        return { kind: "interface", name: ns.interfaces.get(ann.name)!.name };
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
    if (activeClasses.has(ann.name)) {
      return { kind: "class", name: activeClasses.get(ann.name)!.name };
    }
    if (specializedClasses.has(ann.name)) {
      return { kind: "class", name: specializedClasses.get(ann.name)!.name };
    }
    if (activeInterfaces.has(ann.name)) {
      return { kind: "interface", name: activeInterfaces.get(ann.name)!.name };
    }
    if (specializedInterfaces.has(ann.name)) {
      return { kind: "interface", name: specializedInterfaces.get(ann.name)!.name };
    }
    if (activeGenericStructs.has(ann.name) || activeGenericClasses.has(ann.name) || activeGenericInterfaces.has(ann.name)) {
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
  const element = resolveAnnotation(ann.element, structs, enums, diagnostics);
  if (element === null) {
    return null;
  }
  return { kind: "array", element };
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
    // Re-encode for mangling (prefer original annotation when not a type param).
    resolvedArgs.push(
      arg.kind === "NamedType" && activeTypeParams.has(arg.name)
        ? valueTypeToLocalAnnotation(vt)
        : arg,
    );
  }

  const structTpl = activeGenericStructs.get(ann.name);
  if (structTpl) {
    return instantiateGenericStruct(structTpl, resolvedArgs, ann.span, structs, enums, diagnostics);
  }
  const classTpl = activeGenericClasses.get(ann.name);
  if (classTpl) {
    return instantiateGenericClass(classTpl, resolvedArgs, ann.span, structs, enums, diagnostics);
  }
  const ifaceTpl = activeGenericInterfaces.get(ann.name);
  if (ifaceTpl) {
    return instantiateGenericInterface(ifaceTpl, resolvedArgs, ann.span, structs, enums, diagnostics);
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
    if (tp.constraint) {
      const c = resolveAnnotation(tp.constraint, structs, enums, diagnostics);
      if (c === null) {
        return null;
      }
      if (isInterfaceType(c)) {
        constraintName = c.name;
        constraintKind = "interface";
      } else if (isClassType(c)) {
        constraintName = c.name;
        constraintKind = "class";
      } else {
        diagnostics.error(
          `Type parameter constraint must be a class or interface`,
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
    const argType = resolveAnnotation(typeArgs[i]!, structs, enums, diagnostics);
    const constraintType = resolveAnnotation(tp.constraint, structs, enums, diagnostics);
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
  if (!checkTypeArgArity(tpl.decl.name.name, tpl.decl.typeParams, typeArgs, span, diagnostics)) {
    return null;
  }
  if (!checkConstraints(tpl.decl.typeParams, typeArgs, structs, enums, diagnostics, span)) {
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
    return { kind: "struct", name: specializedStructs.get(instanceLocal)!.name };
  }

  const prev = activeTypeParams;
  activeTypeParams = new Map();
  const fields: StructFieldDef[] = [];
  const methods: StructMethodDef[] = [];
  const subst = buildSubst(tpl.decl.typeParams, typeArgs);
  const specializedDecl = specializeStructDecl(tpl.decl, instanceLocal, subst);

  for (const field of specializedDecl.fields) {
    const fieldType = resolveAnnotation(field.typeAnnotation, structs, enums, diagnostics);
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
      const pt = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
      if (pt === null) {
        activeTypeParams = prev;
        return null;
      }
      params.push(pt);
    }
    const returnType = resolveReturnType(method.returnType, structs, enums, diagnostics);
    if (returnType === undefined) {
      activeTypeParams = prev;
      return null;
    }
    methods.push({
      name: method.name.name,
      mangledName: mangleSymbol(tpl.moduleId, `${instanceLocal}__${method.name.name}`),
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
  if (!checkTypeArgArity(tpl.decl.name.name, tpl.decl.typeParams, typeArgs, span, diagnostics)) {
    return null;
  }
  if (!checkConstraints(tpl.decl.typeParams, typeArgs, structs, enums, diagnostics, span)) {
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
  const sub = (ann: TypeAnnotation): TypeAnnotation => {
    if (ann.kind === "PrimitiveType") {
      return ann;
    }
    if (ann.kind === "ArrayType") {
      return { kind: "ArrayType", element: sub(ann.element), span: ann.span };
    }
    if (ann.namespace === null && ann.typeArgs.length === 0 && subst.has(ann.name)) {
      return subst.get(ann.name)!;
    }
    if (ann.typeArgs.length === 0) {
      return ann;
    }
    return {
      kind: "NamedType",
      namespace: ann.namespace,
      name: ann.name,
      typeArgs: ann.typeArgs.map(sub),
      span: ann.span,
    };
  };

  const instanceFields: ClassFieldDef[] = [];
  const staticFields: ClassFieldDef[] = [];
  const instanceMethods: ClassMethodDef[] = [];
  const staticMethods: ClassMethodDef[] = [];
  let fieldIndex = 1;
  let constructorParams: ValueType[] = [];
  let constructorDecl: ConstructorDeclaration | null = null;

  for (const member of tpl.decl.members) {
    if (member.kind === "ClassField") {
      const fieldType = resolveAnnotation(sub(member.typeAnnotation), structs, enums, diagnostics);
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
        const pt = resolveAnnotation(sub(p.typeAnnotation), structs, enums, diagnostics);
        if (pt === null) {
          return null;
        }
        constructorParams.push(pt);
      }
    } else if (member.kind === "ClassMethod" && member.typeParams.length === 0) {
      const params: ValueType[] = [];
      for (const p of member.params) {
        const pt = resolveAnnotation(sub(p.typeAnnotation), structs, enums, diagnostics);
        if (pt === null) {
          return null;
        }
        params.push(pt);
      }
      const returnType = resolveReturnType(sub(member.returnType), structs, enums, diagnostics);
      if (returnType === undefined) {
        return null;
      }
      const methodDef: ClassMethodDef = {
        name: member.name.name,
        mangledName: mangleSymbol(tpl.moduleId, `${instanceLocal}__${member.name.name}`),
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
    constructorMangledName: mangleSymbol(tpl.moduleId, `${instanceLocal}__constructor`),
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
  if (!checkTypeArgArity(tpl.decl.name.name, tpl.decl.typeParams, typeArgs, span, diagnostics)) {
    return null;
  }
  if (!checkConstraints(tpl.decl.typeParams, typeArgs, structs, enums, diagnostics, span)) {
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
    return { kind: "interface", name: specializedInterfaces.get(instanceLocal)!.name };
  }

  const subst = new Map<string, TypeAnnotation>();
  for (let i = 0; i < tpl.decl.typeParams.length; i += 1) {
    subst.set(tpl.decl.typeParams[i]!.name.name, typeArgs[i]!);
  }
  const sub = (ann: TypeAnnotation): TypeAnnotation => {
    if (ann.kind === "PrimitiveType") {
      return ann;
    }
    if (ann.kind === "ArrayType") {
      return { kind: "ArrayType", element: sub(ann.element), span: ann.span };
    }
    if (ann.namespace === null && ann.typeArgs.length === 0 && subst.has(ann.name)) {
      return subst.get(ann.name)!;
    }
    if (ann.typeArgs.length === 0) {
      return ann;
    }
    return {
      kind: "NamedType",
      namespace: ann.namespace,
      name: ann.name,
      typeArgs: ann.typeArgs.map(sub),
      span: ann.span,
    };
  };

  const methods: InterfaceMethodDef[] = [];
  for (const method of tpl.decl.methods) {
    const params: ValueType[] = [];
    for (const p of method.params) {
      const pt = resolveAnnotation(sub(p.typeAnnotation), structs, enums, diagnostics);
      if (pt === null) {
        return null;
      }
      params.push(pt);
    }
    const returnType = resolveReturnType(sub(method.returnType), structs, enums, diagnostics);
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
  const def: InterfaceDef = {
    name: mangled,
    localName: instanceLocal,
    bases: [],
    methods,
    baseItableOffsets: new Map([[mangled, 0]]),
    decl: {
      ...tpl.decl,
      name: { kind: "Identifier", name: instanceLocal, span: tpl.decl.name.span },
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
      const methodBound = bindTypeParams(method.typeParams, structs, enums, diagnostics);
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
      const pt = resolveAnnotation(p.typeAnnotation, structs, enums, diagnostics);
      if (pt) {
        scope.set(p.name.name, { type: pt, mutable: false });
      }
    }
    const returnType = resolveReturnType(method.returnType, structs, enums, diagnostics);
    if (returnType !== undefined) {
      memberContext = {
        thisType: { kind: "typeParam", name: "Self", constraintName: null, constraintKind: null },
        enclosingClass: null,
        enclosingStruct: null,
        isConstructor: false,
        isStatic: false,
      };
      // Use a synthetic struct this-type via type param — for template check, bind this as opaque.
      // Better: treat this as having the template's fields. Skip full this checking for MVP of methods.
      for (const stmt of method.body) {
        checkStatement(stmt, scope, functions, structs, enums, returnType, diagnostics, 0);
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
        const mb = bindTypeParams(member.typeParams, structs, enums, diagnostics);
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
  if (typeof type === "string") {
    return valueTypeToAnnotation(type);
  }
  if (type.kind === "array") {
    return {
      kind: "ArrayType",
      element: valueTypeToLocalAnnotation(type.element),
      span: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 1, offset: 0 },
      },
    };
  }
  if (type.kind === "typeParam") {
    return valueTypeToAnnotation(type);
  }
  if (type.kind === "class") {
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
      span: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 1, offset: 0 },
      },
    };
  }
  if (type.kind === "interface") {
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
      span: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 1, offset: 0 },
      },
    };
  }
  if (type.kind === "struct") {
    const local = localNameFromMangled(type.name);
    const def =
      specializedStructs.get(local) ??
      [...specializedStructs.values()].find((d) => d.name === type.name);
    const name = def?.decl.name.name ?? local;
    return {
      kind: "NamedType",
      namespace: null,
      name,
      typeArgs: [],
      span: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 1, offset: 0 },
      },
    };
  }
  // enum
  return {
    kind: "NamedType",
    namespace: null,
    name: localNameFromMangled(type.name),
    typeArgs: [],
    span: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    },
  };
}

function inferTypeArgs(
  typeParams: readonly TypeParameter[],
  paramAnns: readonly TypeAnnotation[],
  argTypes: readonly ValueType[],
): TypeAnnotation[] | null {
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
    if (ann.namespace === null && ann.typeArgs.length === 0) {
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
    // Named concrete types — accept if names match after resolving would be complex; skip deep unify.
    return true;
  };

  for (let i = 0; i < paramAnns.length; i += 1) {
    if (!unify(paramAnns[i]!, argTypes[i]!)) {
      return null;
    }
  }
  const args: TypeAnnotation[] = [];
  for (const tp of typeParams) {
    const sol = solutions.get(tp.name.name);
    if (!sol) {
      return null;
    }
    args.push(valueTypeToLocalAnnotation(sol));
  }
  return args;
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
  const argTypes: ValueType[] = [];
  for (const arg of expr.args) {
    const t = checkExpression(arg, scope, functions, structs, enums, diagnostics);
    if (!t) {
      return null;
    }
    argTypes.push(t);
  }

  let typeArgs = expr.typeArgs;
  if (typeArgs.length === 0) {
    const inferred = inferTypeArgs(
      tpl.decl.typeParams,
      tpl.decl.params.map((p) => p.typeAnnotation),
      argTypes,
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
  if (!checkTypeArgArity(tpl.decl.name.name, tpl.decl.typeParams, typeArgs, expr.span, diagnostics)) {
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
    if (!checkConstraints(tpl.decl.typeParams, typeArgs, structs, enums, diagnostics, expr.span)) {
      return null;
    }
    const instanceLocal = mangleFunctionInstance(tpl.decl.name.name, typeArgs);
    instantiationCollector.callRewrites.set(expr.span.start.offset, instanceLocal);
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
  const sub = (ann: TypeAnnotation): TypeAnnotation => {
    if (ann.kind === "PrimitiveType") {
      return ann;
    }
    if (ann.kind === "ArrayType") {
      return { kind: "ArrayType", element: sub(ann.element), span: ann.span };
    }
    if (ann.namespace === null && ann.typeArgs.length === 0 && subst.has(ann.name)) {
      return subst.get(ann.name)!;
    }
    if (ann.typeArgs.length === 0) {
      return ann;
    }
    return {
      kind: "NamedType",
      namespace: ann.namespace,
      name: ann.name,
      typeArgs: ann.typeArgs.map(sub),
      span: ann.span,
    };
  };

  if (expr.args.length !== tpl.decl.params.length) {
    diagnostics.error(
      `Function '${tpl.decl.name.name}' expects ${tpl.decl.params.length} argument(s), got ${expr.args.length}`,
      expr.span,
      "E0315",
    );
    return null;
  }

  for (let i = 0; i < expr.args.length; i += 1) {
    const expected = resolveAnnotation(sub(tpl.decl.params[i]!.typeAnnotation), structs, enums, diagnostics);
    if (expected === null) {
      return null;
    }
    if (!valueMatchesBinding(expr.args[i]!, argTypes[i]!, expected)) {
      diagnostics.error(typeMismatchMessage(expected, argTypes[i]!), expr.args[i]!.span, "E0303");
      return null;
    }
  }

  const returnType = resolveReturnType(sub(tpl.decl.returnType), structs, enums, diagnostics);
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
  const scope = new Map<string, Binding>();
  const returnType = resolveReturnType(fn.returnType, structs, enums, diagnostics);
  if (returnType === undefined) {
    return;
  }

  for (const param of fn.params) {
    const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
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
    checkStatement(stmt, scope, functions, structs, enums, returnType, diagnostics, 0);
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
      const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
      if (paramType === null) {
        continue;
      }
      if (scope.has(param.name.name)) {
        diagnostics.error(`Duplicate parameter '${param.name.name}'`, param.name.span, "E0301");
        continue;
      }
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    for (const stmt of method.decl.body) {
      checkStatement(stmt, scope, functions, structs, enums, method.returnType, diagnostics, 0);
    }
    if (method.returnType !== "void") {
      const last = method.decl.body[method.decl.body.length - 1];
      if (!last || last.kind !== "ReturnStatement" || last.value === null) {
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
      if (inferred && !valueMatchesBinding(field.initializer, inferred, field.type)) {
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
      const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
      if (paramType === null) {
        continue;
      }
      if (scope.has(param.name.name)) {
        diagnostics.error(`Duplicate parameter '${param.name.name}'`, param.name.span, "E0301");
        continue;
      }
      scope.set(param.name.name, { type: paramType, mutable: false });
    }

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
      checkStatement(stmt, scope, functions, structs, enums, "void", diagnostics, 0);
    }
    memberContext = null;
  } else if (def.superclass) {
    // Synthesized constructor: require base to have zero-arg constructor.
    if (def.superclass.constructorParams.length > 0) {
      // Already diagnosed during collect.
    }
  }

  for (const method of [...def.instanceMethods, ...def.staticMethods]) {
    if (!method.decl || method.isAbstract || method.implementingClass !== def.name) {
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
      const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
      if (paramType === null) {
        continue;
      }
      if (scope.has(param.name.name)) {
        diagnostics.error(`Duplicate parameter '${param.name.name}'`, param.name.span, "E0301");
        continue;
      }
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    const body = method.decl.body ?? [];
    for (const stmt of body) {
      checkStatement(stmt, scope, functions, structs, enums, method.returnType, diagnostics, 0);
    }
    if (method.returnType !== "void") {
      const last = body[body.length - 1];
      if (!last || last.kind !== "ReturnStatement" || last.value === null) {
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
    if (member.kind !== "ClassMethod" || member.typeParams.length === 0 || member.isAbstract) {
      continue;
    }
    const bound = bindTypeParams(member.typeParams, structs, enums, diagnostics);
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
      const paramType = resolveAnnotation(param.typeAnnotation, structs, enums, diagnostics);
      if (paramType === null) {
        continue;
      }
      scope.set(param.name.name, { type: paramType, mutable: false });
    }
    const returnType = resolveReturnType(member.returnType, structs, enums, diagnostics);
    if (returnType !== undefined && member.body) {
      for (const stmt of member.body) {
        checkStatement(stmt, scope, functions, structs, enums, returnType, diagnostics, 0);
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

function checkStatement(
  stmt: Statement,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
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
        annotated = resolveAnnotation(stmt.typeAnnotation, structs, enums, diagnostics);
        if (annotated === null) {
          return;
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
      checkAssignment(stmt, scope, functions, structs, enums, diagnostics);
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
      checkExpression(stmt.expression, scope, functions, structs, enums, diagnostics, true);
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

      const valueType = checkExpression(stmt.value, scope, functions, structs, enums, diagnostics);
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
      const condType = checkExpression(stmt.condition, scope, functions, structs, enums, diagnostics);
      if (condType && condType !== "bool") {
        diagnostics.error(
          `If condition must be 'bool', got '${typeToString(condType)}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      for (const s of stmt.consequent) {
        checkStatement(s, scope, functions, structs, enums, returnType, diagnostics, loopDepth);
      }
      if (stmt.alternate === null) {
        return;
      }
      if (Array.isArray(stmt.alternate)) {
        for (const s of stmt.alternate) {
          checkStatement(s, scope, functions, structs, enums, returnType, diagnostics, loopDepth);
        }
      } else {
        checkStatement(stmt.alternate, scope, functions, structs, enums, returnType, diagnostics, loopDepth);
      }
      return;
    }
    case "WhileStatement": {
      const condType = checkExpression(stmt.condition, scope, functions, structs, enums, diagnostics);
      if (condType && condType !== "bool") {
        diagnostics.error(
          `While condition must be 'bool', got '${typeToString(condType)}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      for (const s of stmt.body) {
        checkStatement(s, scope, functions, structs, enums, returnType, diagnostics, loopDepth + 1);
      }
      return;
    }
    case "ForStatement": {
      if (stmt.initializer) {
        checkStatement(stmt.initializer, scope, functions, structs, enums, returnType, diagnostics, loopDepth);
      }
      if (stmt.condition) {
        const condType = checkExpression(stmt.condition, scope, functions, structs, enums, diagnostics);
        if (condType && condType !== "bool") {
          diagnostics.error(
            `For condition must be 'bool', got '${typeToString(condType)}'`,
            stmt.condition.span,
            "E0316",
          );
        }
      }
      if (stmt.update) {
        checkStatement(stmt.update, scope, functions, structs, enums, returnType, diagnostics, loopDepth);
      }
      for (const s of stmt.body) {
        checkStatement(s, scope, functions, structs, enums, returnType, diagnostics, loopDepth + 1);
      }
      return;
    }
    case "ForInStatement": {
      const iterableType = checkExpression(stmt.iterable, scope, functions, structs, enums, diagnostics);
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
        checkStatement(s, scope, functions, structs, enums, returnType, diagnostics, loopDepth + 1);
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
  enums: Map<string, EnumDef>,
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

    const valueType = checkExpression(stmt.value, scope, functions, structs, enums, diagnostics);
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
    const fieldType = checkMemberLvalue(stmt.target, scope, functions, structs, enums, diagnostics);
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

    const valueType = checkExpression(stmt.value, scope, functions, structs, enums, diagnostics);
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
  const objectType = checkExpression(stmt.target.object, scope, functions, structs, enums, diagnostics);
  const indexType = checkExpression(stmt.target.index, scope, functions, structs, enums, diagnostics);
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

  const valueType = checkExpression(stmt.value, scope, functions, structs, enums, diagnostics);
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
      const field = classDef.staticFields.find((f) => f.name === expr.property.name);
      if (!field) {
        diagnostics.error(
          `Unknown static field '${expr.property.name}' on class '${classDef.localName}'`,
          expr.property.span,
          "E0324",
        );
        return null;
      }
      if (!canAccessMember(field.visibility, field.declaringClass, diagnostics, expr.property.span)) {
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

  const objectType = checkExpression(expr.object, scope, functions, structs, enums, diagnostics);
  if (!objectType) {
    return null;
  }

  if (isStructType(objectType)) {
    const def =
      findStructByTypeName(structs, objectType.name) ?? findStructInNamespaces(objectType.name);
    if (!def) {
      diagnostics.error(`Unknown struct '${objectType.name}'`, expr.object.span, "E0104");
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
      diagnostics.error(`Unknown class '${objectType.name}'`, expr.object.span, "E0104");
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
    if (!canAccessMember(field.visibility, field.declaringClass, diagnostics, expr.property.span)) {
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
    diagnostics.error(
      `Unknown function '${nsName}.${expr.callee.property.name}'`,
      expr.callee.property.span,
      "E0307",
    );
    return null;
  }

  if (expr.args.length !== sig.params.length) {
    diagnostics.error(
      `Function '${nsName}.${sig.name}' expects ${sig.params.length} argument(s), got ${expr.args.length}`,
      expr.span,
      "E0315",
    );
    return null;
  }

  for (let i = 0; i < expr.args.length; i += 1) {
    const arg = expr.args[i]!;
    const expected = sig.params[i]!;
    const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
    if (!argType) {
      return null;
    }
    if (!valueMatchesBinding(arg, argType, expected)) {
      diagnostics.error(typeMismatchMessage(expected, argType), arg.span, "E0303");
      return null;
    }
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
          diagnostics.error(`Unknown generic struct '${expr.name.name}'`, expr.name.span, "E0104");
          return null;
        }
        let typeArgs = expr.typeArgs;
        if (typeArgs.length === 0 && expectedType && isStructType(expectedType)) {
          // Cannot easily reverse-mangle; require explicit args or field inference.
        }
        if (typeArgs.length === 0) {
          // Infer from field initializers against template field types.
          const fieldArgTypes: ValueType[] = [];
          const fieldAnns: TypeAnnotation[] = [];
          for (const field of template.decl.fields) {
            const init = expr.fields.find((f) => f.name.name === field.name.name);
            if (!init) {
              continue;
            }
            const vt = checkExpression(init.value, scope, functions, structs, enums, diagnostics);
            if (!vt) {
              return null;
            }
            fieldArgTypes.push(vt);
            fieldAnns.push(field.typeAnnotation);
          }
          const inferred = inferTypeArgs(template.decl.typeParams, fieldAnns, fieldArgTypes);
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
        instantiationCollector.structLiteralRewrites.set(expr.span.start.offset, mangleInstance(template.decl.name.name, typeArgs));
        def = specializedStructs.get(mangleInstance(template.decl.name.name, typeArgs))
          ?? structs.get(mangleInstance(template.decl.name.name, typeArgs));
        if (!def) {
          return null;
        }
      } else {
        def = structs.get(expr.name.name) ?? specializedStructs.get(expr.name.name);
        if (!def) {
          if (activeGenericStructs.has(expr.name.name)) {
            diagnostics.error(
              `Generic type '${expr.name.name}' requires type arguments`,
              expr.name.span,
              "E0382",
            );
            return null;
          }
          diagnostics.error(`Unknown struct '${expr.name.name}'`, expr.name.span, "E0104");
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
        const t = checkExpression(element, scope, functions, structs, enums, diagnostics, false, expectedElement);
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
      const objectType = checkExpression(expr.object, scope, functions, structs, enums, diagnostics);
      const indexType = checkExpression(expr.index, scope, functions, structs, enums, diagnostics);
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
          (activeNamespaces.has(expr.object.name)
            ? undefined
            : undefined);
        const localClass = activeClasses.get(expr.object.name);
        if (localClass) {
          const field = localClass.staticFields.find((f) => f.name === expr.property.name);
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

      // Bare namespace member used as a value (not a call) — only enums are handled above
      if (
        expr.object.kind === "Identifier" &&
        activeNamespaces.has(expr.object.name) &&
        !scope.has(expr.object.name)
      ) {
        const ns = activeNamespaces.get(expr.object.name)!;
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

      const objectType = checkExpression(expr.object, scope, functions, structs, enums, diagnostics);
      if (!objectType) {
        return null;
      }
      if (isStructType(objectType)) {
        const def =
          findStructByTypeName(structs, objectType.name) ??
          findStructInNamespaces(objectType.name);
        if (!def) {
          diagnostics.error(`Unknown struct '${objectType.name}'`, expr.object.span, "E0104");
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
          diagnostics.error(`Unknown class '${objectType.name}'`, expr.object.span, "E0104");
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
          !canAccessMember(field.visibility, field.declaringClass, diagnostics, expr.property.span)
        ) {
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
    case "ThisExpression": {
      if (!memberContext || memberContext.isStatic) {
        diagnostics.error(
          "'this' is only allowed in instance methods and constructors",
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
        expr.namespace == null ? activeGenericClasses.get(expr.className.name) : undefined;

      if (!classDef && classTpl) {
        let typeArgs = expr.typeArgs;
        if (typeArgs.length === 0) {
          // Infer from constructor args.
          const argTypes: ValueType[] = [];
          for (const arg of expr.args) {
            const t = checkExpression(arg, scope, functions, structs, enums, diagnostics);
            if (!t) {
              return null;
            }
            argTypes.push(t);
          }
          const ctor = classTpl.decl.members.find((m) => m.kind === "ConstructorDeclaration");
          if (!ctor || ctor.kind !== "ConstructorDeclaration") {
            diagnostics.error(
              `Cannot infer type arguments for '${expr.className.name}' without a constructor`,
              expr.span,
              "E0385",
            );
            return null;
          }
          const inferred = inferTypeArgs(
            classTpl.decl.typeParams,
            ctor.params.map((p) => p.typeAnnotation),
            argTypes,
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
          classDef = specializedClasses.get(mangleInstance(classTpl.decl.name.name, typeArgs));
          if (!classDef) {
            return null;
          }
          // Validate args against specialized constructor.
          if (expr.args.length !== classDef.constructorParams.length) {
            diagnostics.error(
              `Constructor of '${classDef.localName}' expects ${classDef.constructorParams.length} argument(s), got ${expr.args.length}`,
              expr.span,
              "E0315",
            );
            return null;
          }
          for (let i = 0; i < expr.args.length; i += 1) {
            if (!valueMatchesBinding(expr.args[i]!, argTypes[i]!, classDef.constructorParams[i]!)) {
              diagnostics.error(
                typeMismatchMessage(classDef.constructorParams[i]!, argTypes[i]!),
                expr.args[i]!.span,
                "E0303",
              );
              return null;
            }
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
        classDef = specializedClasses.get(mangleInstance(classTpl.decl.name.name, typeArgs));
      }

      if (!classDef) {
        const label = expr.namespace
          ? `${expr.namespace.name}.${expr.className.name}`
          : expr.className.name;
        const iface =
          expr.namespace == null
            ? activeInterfaces.get(expr.className.name)
            : activeNamespaces.get(expr.namespace.name)?.interfaces.get(expr.className.name);
        if (iface) {
          diagnostics.error(
            `Cannot construct interface '${iface.localName}'`,
            expr.className.span,
            "E0376",
          );
          return null;
        }
        diagnostics.error(`Unknown class '${label}'`, expr.className.span, "E0104");
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
      if (expr.args.length !== classDef.constructorParams.length) {
        diagnostics.error(
          `Constructor of '${classDef.localName}' expects ${classDef.constructorParams.length} argument(s), got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }
      for (let i = 0; i < expr.args.length; i += 1) {
        const arg = expr.args[i]!;
        const expected = classDef.constructorParams[i]!;
        const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
        if (!argType) {
          return null;
        }
        if (!valueMatchesBinding(arg, argType, expected)) {
          diagnostics.error(typeMismatchMessage(expected, argType), arg.span, "E0303");
          return null;
        }
      }
      return { kind: "class", name: classDef.name };
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
      const operand = checkExpression(expr.operand, scope, functions, structs, enums, diagnostics);
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
      const left = checkExpression(expr.left, scope, functions, structs, enums, diagnostics);
      const right = checkExpression(expr.right, scope, functions, structs, enums, diagnostics);
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
      if (expr.callee.kind === "SuperExpression") {
        if (!memberContext?.isConstructor || !memberContext.enclosingClass?.superclass) {
          diagnostics.error(
            "'super' can only be called from a subclass constructor",
            expr.span,
            "E0361",
          );
          return null;
        }
        const base = memberContext.enclosingClass.superclass;
        if (expr.args.length !== base.constructorParams.length) {
          diagnostics.error(
            `super(...) expects ${base.constructorParams.length} argument(s), got ${expr.args.length}`,
            expr.span,
            "E0315",
          );
          return null;
        }
        for (let i = 0; i < expr.args.length; i += 1) {
          const arg = expr.args[i]!;
          const expected = base.constructorParams[i]!;
          const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
          if (!argType) {
            return null;
          }
          if (!valueMatchesBinding(arg, argType, expected)) {
            diagnostics.error(typeMismatchMessage(expected, argType), arg.span, "E0303");
            return null;
          }
        }
        if (!allowVoidCall) {
          diagnostics.error("'super' cannot be used as a value", expr.span, "E0309");
        }
        return null;
      }

      if (expr.callee.kind === "MemberExpression") {
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
        return checkMethodCall(expr, scope, functions, structs, enums, diagnostics, allowVoidCall);
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
          const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
          if (!argType) {
            return null;
          }
          if (isStructType(argType) || isClassType(argType)) {
            diagnostics.error(
              `Cannot print ${argType.kind} value of type '${typeToString(argType)}'; print individual fields instead`,
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
        const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
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
      const method = classDef.staticMethods.find((m) => m.name === callee.property.name);
      if (!method) {
        diagnostics.error(
          `Unknown static method '${callee.property.name}' on class '${classDef.localName}'`,
          callee.property.span,
          "E0324",
        );
        return null;
      }
      if (
        !canAccessMember(method.visibility, method.implementingClass, diagnostics, callee.property.span)
      ) {
        return null;
      }
      return checkMethodArgs(
        method.name,
        method.params,
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

  if (isStructType(objectType)) {
    const def =
      findStructByTypeName(structs, objectType.name) ?? findStructInNamespaces(objectType.name);
    if (!def) {
      diagnostics.error(`Unknown struct '${objectType.name}'`, callee.object.span, "E0104");
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
    return checkMethodArgs(
      method.name,
      method.params,
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

  if (isClassType(objectType)) {
    const def = findClassByMangled(objectType.name);
    if (!def) {
      diagnostics.error(`Unknown class '${objectType.name}'`, callee.object.span, "E0104");
      return null;
    }
    let method = def.instanceMethods.find((m) => m.name === callee.property.name);
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
        return checkGenericMethodCall(
          expr,
          def,
          genericMethod,
          scope,
          functions,
          structs,
          enums,
          diagnostics,
          allowVoidCall,
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
      !canAccessMember(method.visibility, method.implementingClass, diagnostics, callee.property.span)
    ) {
      return null;
    }
    return checkMethodArgs(
      method.name,
      method.params,
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

  if (isInterfaceType(objectType)) {
    const def = findInterfaceByMangled(objectType.name);
    if (!def) {
      diagnostics.error(`Unknown interface '${objectType.name}'`, callee.object.span, "E0104");
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
    return checkMethodArgs(
      method.name,
      method.params,
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

  if (
    typeof objectType === "object" &&
    objectType.kind === "typeParam" &&
    objectType.constraintKind === "interface" &&
    objectType.constraintName
  ) {
    const def = findInterfaceByMangled(objectType.constraintName);
    if (!def) {
      diagnostics.error(
        `Unknown constraint interface '${objectType.constraintName}'`,
        callee.object.span,
        "E0104",
      );
      return null;
    }
    const method = def.methods.find((m) => m.name === callee.property.name);
    if (!method) {
      diagnostics.error(
        `Unknown method '${callee.property.name}' on constraint '${def.localName}'`,
        callee.property.span,
        "E0324",
      );
      return null;
    }
    return checkMethodArgs(
      method.name,
      method.params,
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

  if (!isArrayType(objectType)) {
    diagnostics.error(
      `Methods are not available on type '${typeToString(objectType)}'`,
      callee.object.span,
      "E0326",
    );
    return null;
  }

  const method = callee.property.name;
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
      const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
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
      const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
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
      const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
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
      diagnostics.error(`Unknown method '${method}'`, callee.property.span, "E0324");
      return null;
  }
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
  const argTypes: ValueType[] = [];
  for (const arg of expr.args) {
    const t = checkExpression(arg, scope, functions, structs, enums, diagnostics);
    if (!t) {
      return null;
    }
    argTypes.push(t);
  }

  let typeArgs = expr.typeArgs;
  if (typeArgs.length === 0) {
    const inferred = inferTypeArgs(
      method.typeParams,
      method.params.map((p) => p.typeAnnotation),
      argTypes,
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
  if (!checkTypeArgArity(method.name.name, method.typeParams, typeArgs, expr.span, diagnostics)) {
    return null;
  }
  if (!checkConstraints(method.typeParams, typeArgs, structs, enums, diagnostics, expr.span)) {
    return null;
  }

  const methodLocalName =
    typeArgs.length === 0
      ? method.name.name
      : `${method.name.name}__${typeArgs.map((a) => {
          if (a.kind === "PrimitiveType") return a.name;
          if (a.kind === "ArrayType") return `arr`;
          return a.name;
        }).join("__")}`;

  instantiationCollector.methodCallRewrites.set(expr.span.start.offset, methodLocalName);
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
  const sub = (ann: TypeAnnotation): TypeAnnotation => substituteAnnotation(ann, subst);

  if (expr.args.length !== method.params.length) {
    diagnostics.error(
      `Method '${method.name.name}' expects ${method.params.length} argument(s), got ${expr.args.length}`,
      expr.span,
      "E0315",
    );
    return null;
  }
  for (let i = 0; i < expr.args.length; i += 1) {
    const expected = resolveAnnotation(sub(method.params[i]!.typeAnnotation), structs, enums, diagnostics);
    if (expected === null) {
      return null;
    }
    if (!valueMatchesBinding(expr.args[i]!, argTypes[i]!, expected)) {
      diagnostics.error(typeMismatchMessage(expected, argTypes[i]!), expr.args[i]!.span, "E0303");
      return null;
    }
  }
  const returnType = resolveReturnType(sub(method.returnType), structs, enums, diagnostics);
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
  returnType: ReturnType,
  expr: Extract<Expression, { kind: "CallExpression" }>,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  structs: Map<string, StructDef>,
  enums: Map<string, EnumDef>,
  diagnostics: DiagnosticCollector,
  allowVoidCall: boolean,
): ValueType | null {
  if (expr.args.length !== params.length) {
    diagnostics.error(
      `Method '${name}' expects ${params.length} argument(s), got ${expr.args.length}`,
      expr.span,
      "E0315",
    );
    return null;
  }
  for (let i = 0; i < expr.args.length; i += 1) {
    const arg = expr.args[i]!;
    const expected = params[i]!;
    const argType = checkExpression(arg, scope, functions, structs, enums, diagnostics);
    if (!argType) {
      return null;
    }
    if (!valueMatchesBinding(arg, argType, expected)) {
      diagnostics.error(typeMismatchMessage(expected, argType), arg.span, "E0303");
      return null;
    }
  }
  if (returnType === "void") {
    if (!allowVoidCall) {
      diagnostics.error(`Void method '${name}' cannot be used as a value`, expr.span, "E0309");
    }
    return null;
  }
  return returnType;
}

function supportsEquality(type: ValueType): boolean {
  if (typeof type === "string") {
    return EQUALITY_PRIMITIVES.has(type);
  }
  return type.kind === "enum";
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
  if (isAssignable(inferred, expected)) {
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
