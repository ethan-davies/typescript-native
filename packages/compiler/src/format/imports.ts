export type ImportGroup = "std" | "package" | "relative";

export function classifyImportSpecifier(specifier: string): ImportGroup {
  if (specifier.startsWith("std/") || specifier === "std") {
    return "std";
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return "relative";
  }
  return "package";
}

const GROUP_ORDER: Record<ImportGroup, number> = {
  std: 0,
  package: 1,
  relative: 2,
};

export function compareImportSpecifiers(a: string, b: string): number {
  const ga = GROUP_ORDER[classifyImportSpecifier(a)];
  const gb = GROUP_ORDER[classifyImportSpecifier(b)];
  if (ga !== gb) {
    return ga - gb;
  }
  return a.localeCompare(b);
}

/** Whether two consecutive import groups should be separated by a blank line. */
export function importGroupsDiffer(a: string, b: string): boolean {
  return classifyImportSpecifier(a) !== classifyImportSpecifier(b);
}
