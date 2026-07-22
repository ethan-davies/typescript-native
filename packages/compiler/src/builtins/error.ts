import type {
  ClassDeclaration,
  ClassField,
  ConstructorDeclaration,
  Identifier,
  Parameter,
  PrimitiveType,
} from "../ast/nodes.js";
import type { SourceSpan } from "../diagnostics/diagnostic.js";
import type { ClassDef, ClassFieldDef } from "../typecheck.js";

export const BUILTIN_ERROR_LOCAL_NAME = "Error";
export const BUILTIN_ERROR_MANGLED = "Error";

const BUILTIN_SPAN: SourceSpan = {
  start: { line: 0, column: 0, offset: 0 },
  end: { line: 0, column: 0, offset: 0 },
};

const BUILTIN_ID = (name: string): Identifier => ({
  kind: "Identifier",
  name,
  span: BUILTIN_SPAN,
});

const STRING_TYPE: PrimitiveType = {
  kind: "PrimitiveType",
  name: "string",
  span: BUILTIN_SPAN,
};

const MESSAGE_FIELD: ClassField = {
  kind: "ClassField",
  visibility: "public",
  isStatic: false,
  isReadonly: false,
  name: BUILTIN_ID("message"),
  typeAnnotation: STRING_TYPE,
  initializer: null,
  span: BUILTIN_SPAN,
};

const MESSAGE_PARAM: Parameter = {
  kind: "Parameter",
  name: BUILTIN_ID("message"),
  typeAnnotation: STRING_TYPE,
  defaultValue: null,
  span: BUILTIN_SPAN,
};

const ERROR_CONSTRUCTOR: ConstructorDeclaration = {
  kind: "ConstructorDeclaration",
  visibility: "public",
  params: [MESSAGE_PARAM],
  body: [],
  span: BUILTIN_SPAN,
};

export function createBuiltinErrorClassDeclaration(): ClassDeclaration {
  return {
    kind: "ClassDeclaration",
    exported: false,
    isAbstract: false,
    name: BUILTIN_ID(BUILTIN_ERROR_LOCAL_NAME),
    typeParams: [],
    superclass: null,
    implementsTypes: [],
    members: [MESSAGE_FIELD, ERROR_CONSTRUCTOR],
    span: BUILTIN_SPAN,
  };
}

export function createBuiltinErrorClassDef(): ClassDef {
  const decl = createBuiltinErrorClassDeclaration();
  // fieldIndex 1: slot 0 is ObjectHeader { type_id, vtable }.
  const messageField: ClassFieldDef = {
    name: "message",
    type: "string",
    fieldIndex: 1,
    visibility: "public",
    isStatic: false,
    isReadonly: false,
    declaringClass: BUILTIN_ERROR_MANGLED,
    initializer: null,
  };
  return {
    name: BUILTIN_ERROR_MANGLED,
    localName: BUILTIN_ERROR_LOCAL_NAME,
    isAbstract: false,
    superclass: null,
    implementedInterfaces: [],
    instanceFields: [messageField],
    staticFields: [],
    instanceMethods: [],
    staticMethods: [],
    constructorParams: ["string"],
    constructorDecl: ERROR_CONSTRUCTOR,
    constructorMangledName: "Error__constructor",
    vtableGlobalName: "Error__vtable",
    decl,
    exported: false,
  };
}
