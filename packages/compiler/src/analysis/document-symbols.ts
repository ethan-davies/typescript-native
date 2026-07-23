import type {
  ClassDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  Program,
  StructDeclaration,
  TypeAliasDeclaration,
} from "../ast/nodes.js";
import type { SourceSpan } from "../diagnostics/diagnostic.js";

export type DocumentSymbolKind =
  | "function"
  | "struct"
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "method"
  | "field"
  | "constructor"
  | "variant"
  | "variable"
  | "constant";

export interface DocumentSymbolInfo {
  readonly name: string;
  readonly kind: DocumentSymbolKind;
  readonly span: SourceSpan;
  readonly selectionSpan: SourceSpan;
  readonly children: readonly DocumentSymbolInfo[];
}

function fnSymbol(fn: FunctionDeclaration): DocumentSymbolInfo {
  return {
    name: fn.name.name,
    kind: "function",
    span: fn.span,
    selectionSpan: fn.name.span,
    children: [],
  };
}

function structSymbol(decl: StructDeclaration): DocumentSymbolInfo {
  const children: DocumentSymbolInfo[] = [
    ...decl.fields.map((f) => ({
      name: f.name.name,
      kind: "field" as const,
      span: f.span,
      selectionSpan: f.name.span,
      children: [],
    })),
    ...decl.methods.map((m) => ({
      name: m.name.name,
      kind: "method" as const,
      span: m.span,
      selectionSpan: m.name.span,
      children: [],
    })),
  ];
  return {
    name: decl.name.name,
    kind: "struct",
    span: decl.span,
    selectionSpan: decl.name.span,
    children,
  };
}

function classSymbol(decl: ClassDeclaration): DocumentSymbolInfo {
  const children: DocumentSymbolInfo[] = [];
  for (const member of decl.members) {
    if (member.kind === "ConstructorDeclaration") {
      children.push({
        name: "constructor",
        kind: "constructor",
        span: member.span,
        selectionSpan: member.span,
        children: [],
      });
    } else if (member.kind === "ClassField") {
      children.push({
        name: member.name.name,
        kind: "field",
        span: member.span,
        selectionSpan: member.name.span,
        children: [],
      });
    } else {
      children.push({
        name: member.name.name,
        kind: "method",
        span: member.span,
        selectionSpan: member.name.span,
        children: [],
      });
    }
  }
  return {
    name: decl.name.name,
    kind: "class",
    span: decl.span,
    selectionSpan: decl.name.span,
    children,
  };
}

function interfaceSymbol(decl: InterfaceDeclaration): DocumentSymbolInfo {
  return {
    name: decl.name.name,
    kind: "interface",
    span: decl.span,
    selectionSpan: decl.name.span,
    children: decl.methods.map((m) => ({
      name: m.name.name,
      kind: "method" as const,
      span: m.span,
      selectionSpan: m.name.span,
      children: [],
    })),
  };
}

function enumSymbol(decl: EnumDeclaration): DocumentSymbolInfo {
  return {
    name: decl.name.name,
    kind: "enum",
    span: decl.span,
    selectionSpan: decl.name.span,
    children: decl.variants.map((v) => ({
      name: v.name.name,
      kind: "variant" as const,
      span: v.span,
      selectionSpan: v.name.span,
      children: [],
    })),
  };
}

function typeAliasSymbol(decl: TypeAliasDeclaration): DocumentSymbolInfo {
  return {
    name: decl.name.name,
    kind: "type",
    span: decl.span,
    selectionSpan: decl.name.span,
    children: [],
  };
}

/** Collect hierarchical outline symbols from a module AST. */
export function collectDocumentSymbols(program: Program): DocumentSymbolInfo[] {
  const out: DocumentSymbolInfo[] = [];
  for (const decl of program.body) {
    switch (decl.kind) {
      case "FunctionDeclaration":
        out.push(fnSymbol(decl));
        break;
      case "StructDeclaration":
        out.push(structSymbol(decl));
        break;
      case "ClassDeclaration":
        out.push(classSymbol(decl));
        break;
      case "InterfaceDeclaration":
        out.push(interfaceSymbol(decl));
        break;
      case "EnumDeclaration":
        out.push(enumSymbol(decl));
        break;
      case "TypeAliasDeclaration":
        out.push(typeAliasSymbol(decl));
        break;
      case "ModuleVariableDeclaration":
        out.push({
          name: decl.name.name,
          kind: decl.mutability === "const" ? "constant" : "variable",
          span: decl.span,
          selectionSpan: decl.name.span,
          children: [],
        });
        break;
      default:
        break;
    }
  }
  return out;
}
