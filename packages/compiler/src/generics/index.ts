export {
  mangleFunctionInstance,
  mangleInstance,
  mangleMethodInstance,
  mangleTypeAnnotation,
} from "./mangle.js";
export {
  buildSubst,
  primitiveAnnotation,
  specializeClassDecl,
  specializeClassMethod,
  specializeFunctionDecl,
  specializeInterfaceDecl,
  specializeStructDecl,
  specializeStructMethod,
  substituteAnnotation,
  typeParamAnnotation,
  type TypeSubst,
} from "./substitute.js";
export {
  monomorphizeModules,
  type InstantiationRecord,
  type TypecheckInstantiations,
} from "./monomorphize.js";
