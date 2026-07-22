import type {
  ClassDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  NamedType,
  StructDeclaration,
  TypeAnnotation,
  TypeParameter,
} from "../ast/nodes.js";
import type { DiagnosticCollector, SourceSpan } from "../diagnostics/diagnostic.js";
import { mangleSymbol } from "../modules/mangle.js";
import {
  mangleFunctionInstance,
  mangleInstance,
  mangleMethodInstance,
  mangleTypeAnnotation,
} from "./mangle.js";
import type { InstantiationRecord, TypecheckInstantiations } from "./monomorphize.js";
import { valueTypeToAnnotation } from "./value-type.js";

export interface GenericStructTemplate {
  readonly decl: StructDeclaration;
  readonly moduleId: string;
  readonly modulePath: string;
}

export interface GenericClassTemplate {
  readonly decl: ClassDeclaration;
  readonly moduleId: string;
  readonly modulePath: string;
}

export interface GenericInterfaceTemplate {
  readonly decl: InterfaceDeclaration;
  readonly moduleId: string;
  readonly modulePath: string;
}

export interface GenericFunctionTemplate {
  readonly decl: FunctionDeclaration;
  readonly moduleId: string;
  readonly modulePath: string;
}

export class InstantiationCollector {
  readonly records: InstantiationRecord[] = [];
  readonly callRewrites = new Map<number, string>();
  readonly methodCallRewrites = new Map<number, string>();
  /** CallExpression span → mangled LLVM name of an extension method (receiver prepended at call). */
  readonly extensionCallRewrites = new Map<number, string>();
  readonly newRewrites = new Map<number, string>();
  readonly structLiteralRewrites = new Map<number, string>();
  readonly typeRewrites = new Map<number, string>();
  readonly lambdaCaptures = new Map<
    number,
    readonly { readonly name: string; readonly mutable: boolean }[]
  >();
  private readonly seen = new Set<string>();

  add(record: InstantiationRecord): void {
    const key = `${record.kind}:${record.modulePath}:${record.instanceLocalName}:${record.ownerInstanceLocalName ?? ""}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.records.push(record);
  }

  snapshot(): TypecheckInstantiations {
    return {
      records: [...this.records],
      callRewrites: new Map(this.callRewrites),
      methodCallRewrites: new Map(this.methodCallRewrites),
      extensionCallRewrites: new Map(this.extensionCallRewrites),
      newRewrites: new Map(this.newRewrites),
      structLiteralRewrites: new Map(this.structLiteralRewrites),
      typeRewrites: new Map(this.typeRewrites),
      lambdaCaptures: new Map(this.lambdaCaptures),
    };
  }
}

export function validateTypeParamList(
  typeParams: readonly TypeParameter[],
  diagnostics: DiagnosticCollector,
): boolean {
  const seen = new Set<string>();
  for (const tp of typeParams) {
    if (seen.has(tp.name.name)) {
      diagnostics.error(
        `Duplicate type parameter '${tp.name.name}'`,
        tp.name.span,
        "E0380",
      );
      return false;
    }
    seen.add(tp.name.name);
  }
  return true;
}

export function checkTypeArgArity(
  templateName: string,
  typeParams: readonly TypeParameter[],
  typeArgs: readonly TypeAnnotation[],
  span: SourceSpan,
  diagnostics: DiagnosticCollector,
): boolean {
  if (typeArgs.length !== typeParams.length) {
    diagnostics.error(
      `'${templateName}' expects ${typeParams.length} type argument(s), got ${typeArgs.length}`,
      span,
      "E0381",
    );
    return false;
  }
  return true;
}

/** Build a NamedType pointing at a monomorphized instance (no type args). */
export function instanceNamedType(
  instanceLocalName: string,
  span: SourceSpan,
): NamedType {
  return {
    kind: "NamedType",
    namespace: null,
    name: instanceLocalName,
    typeArgs: [],
    span,
  };
}

export {
  mangleFunctionInstance,
  mangleInstance,
  mangleMethodInstance,
  mangleTypeAnnotation,
  mangleSymbol,
  valueTypeToAnnotation,
};
