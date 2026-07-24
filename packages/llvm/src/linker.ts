import {
  loadNative,
  type NativeBinding,
  type NativeLinkerHandle,
} from "./native.js";
import {
  hostPlatformId,
  resolveTargetToolchain,
  type TargetToolchain,
} from "./target.js";

/**
 * Linker abstraction — initial implementation uses LLD via the native binding.
 */
export class Linker {
  private readonly native: NativeBinding;
  private readonly handle: NativeLinkerHandle;
  private readonly toolchain: TargetToolchain;
  private disposed = false;

  private constructor(
    native: NativeBinding,
    handle: NativeLinkerHandle,
    toolchain: TargetToolchain,
  ) {
    this.native = native;
    this.handle = handle;
    this.toolchain = toolchain;
  }

  static forHost(triple?: string): Linker {
    const native = loadNative();
    const toolchain = resolveTargetToolchain(triple, hostPlatformId());
    const handle = native.createLinker({ flavor: toolchain.linkerFlavor });
    const linker = new Linker(native, handle, toolchain);

    // Apply CRT / sysroot args; `--` separates leading CRT from trailing CRT.
    let seenSep = false;
    for (const arg of toolchain.extraArgs) {
      if (arg === "--") {
        seenSep = true;
        continue;
      }
      if (seenSep) {
        native.linkerAddTrailingArg.call(handle, arg);
      } else {
        native.linkerAddArg.call(handle, arg);
      }
    }
    for (const path of toolchain.libraryPaths) {
      native.linkerAddLibraryPath.call(handle, path);
    }
    return linker;
  }

  addObject(path: string): void {
    this.assertAlive();
    this.native.linkerAddObject.call(this.handle, path);
  }

  addLibrary(path: string): void {
    this.assertAlive();
    this.native.linkerAddLibrary.call(this.handle, path);
  }

  addLibraryPath(path: string): void {
    this.assertAlive();
    this.native.linkerAddLibraryPath.call(this.handle, path);
  }

  addSystemLibrary(name: string): void {
    this.assertAlive();
    this.native.linkerAddSystemLibrary.call(this.handle, name);
  }

  /** Add a raw linker argument (e.g. `-pthread`, `-rpath`). */
  addArg(arg: string): void {
    this.assertAlive();
    this.native.linkerAddArg.call(this.handle, arg);
  }

  /** Apply default system libraries for the active target toolchain. */
  addDefaultSystemLibraries(): void {
    this.assertAlive();
    for (const name of this.toolchain.systemLibraries) {
      this.addSystemLibrary(name);
    }
  }

  setOutput(path: string): void {
    this.assertAlive();
    this.native.linkerSetOutput.call(this.handle, path);
  }

  link(): void {
    this.assertAlive();
    this.native.linkerLink.call(this.handle);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.native.linkerDispose.call(this.handle);
  }

  getToolchain(): TargetToolchain {
    return this.toolchain;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("Linker has been disposed");
    }
  }
}
