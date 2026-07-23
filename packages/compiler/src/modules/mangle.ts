/**
 * LLVM / internal symbol mangling for multi-module compilation.
 * Empty moduleId (in-memory single-file compile) leaves names unmangled.
 */
export function mangleSymbol(moduleId: string, name: string): string {
  if (moduleId === "") {
    return name;
  }
  return `${moduleId}__${name}`;
}

/** Basename without `.sn` used as the module id / default namespace. */
export function moduleIdFromPath(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  return base.replace(/\.sn$/i, "");
}
