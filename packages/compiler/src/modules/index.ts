export { mangleSymbol, moduleIdFromPath } from "./mangle.js";
export {
  getPackageRootInfo,
  getPackageRoots,
  getStdRootPath,
  isPackageSpecifier,
  isPathInsideRoot,
  isRelativeSpecifier,
  isStdSpecifier,
  moduleIdForPackagePath,
  moduleIdForStdPath,
  moduleIdentityForPath,
  resolveImportSpecifier,
  resolveModules,
  resolvePackageEntry,
  resolvePackageSpecifier,
  resolvePackageSpecifierDetailed,
  resolveSpecifierDetailed,
  resolveStdSpecifier,
  setPackageRootsProvider,
  setStdRootProvider,
  splitPackageSpecifier,
} from "./resolve.js";
export type {
  ImportSpecifierKind,
  ModuleIdentity,
  ModuleImportBinding,
  PackageRootInfo,
  PackageRootsProvider,
  ReadFileFn,
  ResolveResult,
  ResolvedModule,
  ResolvedSpecifier,
  StdRootProvider,
} from "./resolve.js";
export {
  attachPrelude,
  getPreludeModulePaths,
  setPreludePathsProvider,
} from "./prelude.js";
export {
  buildExportTables,
  collectReExportSpecifiers,
  hasPrivateDeclarationInAst,
  isReExportDecl,
} from "./exports.js";
export type {
  ExportEntry,
  ExportKind,
  ExportTable,
  ModuleForExports,
} from "./exports.js";
export {
  applyPackageRootsFromProject,
  discoverPackageRootsForProject,
  findProjectToml,
  loadLockPackages,
} from "./project-roots.js";
