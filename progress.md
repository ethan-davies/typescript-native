# Sonite v1.0.0 Roadmap

## Phase 1 — Cross-Platform Toolchain, Runtime & Standard Library

### Native compiler toolchain

* [x] LLVM version pinned
* [x] LLVM C API binding production-ready
* [x] LLVM object emission through `TargetMachine`
* [x] LLD integration
* [x] No `clang` subprocess
* [x] No `llc` subprocess
* [x] No `ld.lld` subprocess
* [x] No system LLVM requirement
* [x] No system Clang requirement
* [x] No system LLD requirement
* [x] Native LLVM libraries bundled
* [x] Native LLD libraries bundled
* [x] Native library loading works without environment configuration
* [x] Reproducible native toolchain builds
* [x] Platform detection
* [x] Correct target triples
* [x] Correct object formats
* [x] Correct ABI configuration
* [x] Correct system library linking

### Supported targets

* [x] Linux x64
* [x] Linux ARM64
* [x] macOS x64
* [x] macOS ARM64
* [x] Windows x64
* [x] Windows ARM64 explicitly deferred

### Native packages

* [x] `@sonite/llvm-linux-x64`
* [x] `@sonite/llvm-linux-arm64`
* [x] `@sonite/llvm-macos-x64`
* [x] `@sonite/llvm-macos-arm64`
* [x] `@sonite/llvm-win32-x64`
* [x] Automatic platform package selection
* [x] Unsupported platform diagnostics

### Runtime

* [x] Linux x64 runtime
* [x] Linux ARM64 runtime
* [x] macOS x64 runtime
* [x] macOS ARM64 runtime
* [x] Windows x64 runtime
* [x] Cross-platform runtime ABI
* [x] Memory management
* [x] Garbage collection
* [x] Exceptions
* [x] Strings
* [x] Arrays
* [x] Console I/O
* [x] Template-string formatting
* [x] Async/await
* [x] Async I/O
* [x] Byte streams
* [x] Filesystem
* [x] Paths
* [x] TCP
* [x] UDP
* [x] DNS
* [x] TLS
* [x] HTTP
* [x] HTTPS

### Standard library

* [x] Cross-platform strings
* [x] Cross-platform collections
* [x] Cross-platform math
* [x] Cross-platform filesystem
* [x] Cross-platform paths
* [x] Cross-platform networking
* [x] Cross-platform TLS
* [x] Cross-platform HTTP
* [x] Cross-platform HTTPS
* [x] Platform detection
* [x] Consistent error types
* [x] Consistent API semantics

### Cross-platform validation

* [x] All core language features compile on every target
* [x] All runtime functionality works on every target
* [x] All stdlib functionality works on every target
* [x] Async client/server round-trip on every target
* [x] HTTPS round-trip on every target
* [x] Clean-machine installation tests
* [x] No-system-LLVM tests
* [x] Native dependency inspection
* [x] Full cross-platform CI

---

# Phase 2 — Complete IDE / LSP Experience

You already have a substantial amount of this implemented, so this phase is about **finishing and hardening it**, not starting from scratch.

### Existing functionality to verify

* [x] Diagnostics
* [x] Completion
* [x] Hover
* [x] Go-to-definition
* [x] Document symbols
* [x] Go-to-references largely implemented
* [x] Auto-import largely implemented

### Complete

* [x] Go-to-references fully production-ready
* [x] Rename symbol
* [x] Signature help
* [x] Code actions
* [x] Auto-import fully production-ready
* [x] Semantic tokens
* [x] Unused-import diagnostics
* [x] Remove unused import action
* [x] Organize imports
* [x] Add missing import action
* [x] Correct import insertion
* [x] Correct import removal
* [x] Correct import sorting

### Language server robustness

* [x] Incremental document updates
* [x] Correct diagnostics after edits
* [x] Correct diagnostics after imports change
* [x] Workspace-aware module resolution
* [x] Multi-file project analysis
* [x] Dependency/package analysis
* [x] Large-project performance
* [x] Cancellation support
* [x] Graceful compiler failures
* [x] No LSP crashes on invalid code

### VS Code extension

* [x] Syntax highlighting
* [x] LSP integration
* [x] Semantic tokens
* [x] Completion UI
* [x] Diagnostics UI
* [x] Code actions
* [x] Formatting integration
* [x] Rename integration
* [x] Signature help
* [x] Auto-import
* [x] Marketplace-ready packaging

---

# Phase 3 — Formatter & Code Quality

This should be a dedicated milestone because a formatter becomes important once the language is used by multiple people.

### Formatter

* [x] Formatter implementation
* [x] Parse source
* [x] Format AST
* [x] Preserve comments
* [x] Preserve string contents
* [x] Stable output
* [x] Idempotent formatting
* [x] Configurable indentation
* [x] Configurable line width
* [x] Import formatting
* [x] Import ordering
* [x] Multiline formatting
* [x] Function formatting
* [x] Type formatting
* [x] Generic formatting
* [x] Struct/class formatting
* [x] Interface formatting
* [x] Async/await formatting
* [ ] Error recovery on incomplete source

### CLI

* [x] `sn fmt`
* [x] `sn fmt --check`
* [x] Format individual files
* [x] Format entire projects
* [ ] Format only changed files where practical
* [x] CI-friendly exit codes

### LSP

* [x] Document formatting
* [x] Format on save
* [ ] Range formatting if practical

### Code quality

* [x] Compiler warnings framework
* [ ] Unused-variable diagnostics
* [ ] Unreachable-code diagnostics
* [ ] Other useful static diagnostics
* [ ] Configurable warning levels

---

# Phase 4 — Compiler & Language Stabilisation

Before adding major new features, make the language you already have reliable.

### Compiler correctness

* [ ] Parser edge cases
* [ ] Scanner edge cases
* [ ] Typechecker edge cases
* [ ] Generic typechecking edge cases
* [x] Generic inference correctness
* [x] Interface checking
* [x] Async typechecking
* [x] Exception checking
* [x] Module resolution
* [x] Circular dependency handling
* [x] Import/export correctness
* [x] Closure correctness
* [x] Lambda correctness
* [ ] Function overload/dispatch correctness if applicable

### Code generation

* [x] Correct LLVM IR generation
* [x] Correct ABI lowering
* [x] Correct struct layout
* [x] Correct array layout
* [x] Correct string representation
* [x] Correct closure representation
* [x] Correct generic monomorphisation/code generation
* [x] Correct async state-machine generation
* [x] Correct exception handling
* [ ] Correct debug location generation

### Runtime correctness

* [ ] Memory safety validation
* [ ] GC stress tests
* [ ] Async stress tests
* [ ] Concurrent task tests
* [ ] Exception stress tests
* [ ] Network stress tests
* [ ] TLS stress tests
* [ ] Resource cleanup validation
* [ ] Socket cleanup
* [ ] File handle cleanup
* [ ] TLS cleanup

### Compiler stability

* [ ] Compiler never crashes on normal invalid input
* [x] Structured compiler diagnostics
* [x] Source spans on all major errors
* [x] Error codes
* [x] Helpful error messages
* [ ] Suggestions where practical
* [ ] Panic/crash reporting for compiler bugs

---

# Phase 5 — Public FFI & Native Interoperability

This is where `extern` evolves from primarily being an internal runtime mechanism into a supported way for Sonite packages to interact with native libraries.

### FFI language features

* [x] Public `extern` declarations
* [x] C ABI support
* [x] External functions
* [ ] External variables if needed
* [ ] External structs
* [ ] Native pointers
* [ ] Pointer types
* [ ] Native arrays/buffers
* [ ] Native callbacks
* [ ] Function pointers
* [x] C-compatible primitive types
* [ ] C-compatible struct layout
* [ ] ABI annotations
* [ ] `unsafe` boundary if required

### Linking

* [ ] Native library declarations
* [ ] Static libraries
* [ ] Dynamic libraries
* [ ] Platform-specific libraries
* [ ] Library search paths
* [ ] Linker arguments
* [ ] Include/header metadata if needed
* [ ] Package-provided native dependencies

### Package integration

Allow packages to declare native dependencies.

Conceptually:

```toml
[native]
libraries = ["sqlite3"]
```

Support:

* [ ] Native dependency metadata
* [ ] Platform-specific native dependencies
* [ ] Native library discovery
* [ ] Native library bundling
* [ ] Native dependency installation
* [ ] Cross-platform native package handling

### Safety

* [ ] Clear FFI safety model
* [ ] Unsafe FFI operations identified
* [ ] Pointer lifetime rules
* [ ] Memory ownership rules
* [ ] Callback lifetime rules
* [ ] ABI mismatch diagnostics

### Runtime

* [ ] Internal runtime `extern` ABI documented internally
* [ ] Runtime symbols separated from public FFI
* [ ] Runtime symbol naming conventions
* [ ] No accidental exposure of internal runtime APIs

---

# Phase 6 — Package Ecosystem & Build System Maturity

You already have:

* Package registry
* Package publishing API
* Package CLI commands
* Dependency system
* `project.toml`

This phase is about making the ecosystem production-ready.

### Dependency management

* [x] Lockfile implementation
* [x] Deterministic dependency resolution
* [x] Transitive dependencies
* [x] Semantic version constraints
* [x] Version conflict resolution
* [x] Dependency updates
* [x] Dependency removal
* [ ] Dependency overrides
* [ ] Local/path dependencies
* [ ] Git dependencies if desired
* [ ] Development dependencies if desired

### CLI

Ensure the package system has:

* [x] `sn init`
* [x] `sn add`
* [x] `sn remove`
* [x] `sn install`
* [x] `sn update`
* [x] `sn publish`
* [x] `sn search`
* [x] `sn info`
* [x] `sn login`
* [x] `sn logout`
* [x] `sn build`
* [x] `sn run`

### Lockfiles

* [x] Lockfile format
* [x] Dependency versions
* [x] Resolved package URLs
* [x] Integrity hashes
* [x] Transitive dependency information
* [ ] Platform-specific dependency information
* [x] Reproducible installs
* [x] Lockfile validation

### Registry

* [x] Package publishing
* [x] Package downloading
* [x] Package metadata
* [x] Version management
* [ ] Package ownership
* [x] Authentication
* [ ] Package deletion policy
* [ ] Deprecation
* [x] Package search
* [ ] Package documentation
* [ ] Download statistics
* [ ] Abuse/security controls

### Package security

* [x] Tarball integrity verification
* [x] Checksums
* [x] Registry HTTPS
* [x] Authentication tokens
* [x] Secure credential storage
* [ ] Dependency provenance where practical

### Project management

* [x] Project configuration validation
* [ ] Build profiles
* [x] Debug build
* [x] Release build
* [ ] Optimisation levels
* [x] Project metadata
* [x] Entry point configuration
* [x] Build output configuration

### Workspaces

If desired before v1:

* [ ] Workspace configuration
* [ ] Multiple Sonite packages
* [ ] Shared lockfile
* [ ] Workspace dependencies
* [ ] Workspace builds

I would consider workspaces optional for v1 unless Sonite's own repository structure requires them.

---

# Phase 7 — Debugging & Production Diagnostics

This is the final major development phase before release.

### Debug information

* [ ] LLVM debug metadata
* [ ] Source locations
* [ ] Function names
* [ ] Local variable information
* [ ] Type information where practical
* [x] Debug builds
* [x] Release builds

### Runtime diagnostics

* [ ] Stack traces
* [ ] Source file locations
* [ ] Line numbers
* [ ] Function names
* [ ] Async stack traces
* [ ] Exception stack traces
* [ ] Runtime panic reporting

### Debug Adapter Protocol

Implement a Sonite debug adapter.

* [ ] DAP implementation
* [ ] VS Code integration
* [ ] Launch configuration
* [ ] Attach configuration
* [ ] Breakpoints
* [ ] Conditional breakpoints
* [ ] Logpoints if practical
* [ ] Step over
* [ ] Step into
* [ ] Step out
* [ ] Continue
* [ ] Pause
* [ ] Restart
* [ ] Stop

### Debug inspection

* [ ] Call stack
* [ ] Local variables
* [ ] Global variables
* [ ] Function arguments
* [ ] Object inspection
* [ ] Array inspection
* [ ] String inspection
* [ ] Async task inspection where practical

### Native debugger integration

Integrate with:

```text id="9xqdbk"
LLDB
```

on:

```text id="y1b39k"
Linux
macOS
```

and:

```text id="3v6x6s"
Windows debugger tooling
```

where appropriate.

The Sonite developer should interact with the Sonite debugger rather than needing to understand native debugger internals.

---

# Phase 8 — v1.0.0 Release Readiness

I would add this as a final phase **after Phase 7**. This is not a new feature phase; it is the actual release gate.

## Language specification

* [ ] Core language specification written
* [ ] Type system specification written
* [ ] Generics documented
* [ ] Async/await documented
* [ ] Error handling documented
* [ ] Module system documented
* [ ] Package system documented
* [ ] FFI documented
* [ ] Runtime behaviour documented
* [ ] Standard library API documented

## Standard library

* [ ] Public API reviewed
* [ ] API naming consistent
* [ ] API stability review
* [ ] Deprecated APIs identified
* [ ] Unstable APIs explicitly marked
* [ ] Core library documentation complete
* [ ] JSON intentionally excluded from core if still desired

## CLI

Finalise and document:

* [x] `sn init`
* [x] `sn build`
* [x] `sn run`
* [x] `sn fmt`
* [x] `sn fmt --check`
* [x] `sn add`
* [x] `sn remove`
* [x] `sn install`
* [x] `sn update`
* [x] `sn publish`
* [x] `sn search`
* [x] `sn info`
* [x] `sn login`
* [x] `sn logout`

Remove or clearly mark experimental commands.

## Installation

* [ ] npm installation tested
* [ ] Linux installation tested
* [ ] macOS installation tested
* [ ] Windows installation tested
* [x] Clean-machine installation
* [x] No system LLVM requirement
* [x] Native packages automatically selected
* [ ] CLI available after installation
* [ ] Uninstall process verified

## Documentation

Create:

* [ ] Official website
* [ ] Getting started guide
* [ ] Installation guide
* [ ] Language guide
* [ ] Language reference
* [ ] Standard library reference
* [ ] Module system documentation
* [ ] Package management guide
* [ ] `project.toml` reference
* [ ] Lockfile documentation
* [ ] FFI guide
* [ ] Async/await guide
* [ ] Networking guide
* [ ] TLS/HTTPS guide
* [ ] Debugging guide
* [ ] LSP/VS Code guide
* [ ] Cross-platform guide
* [ ] Migration/versioning guide

## Examples

Create official examples for:

* [x] Hello World
* [ ] CLI application
* [x] Filesystem application
* [x] Async application
* [x] TCP server
* [x] HTTP server
* [x] HTTPS server
* [x] HTTP client
* [ ] Package usage
* [ ] Package creation
* [ ] FFI example
* [ ] Debugging example

## Testing

* [x] Full compiler test suite
* [x] Full runtime test suite
* [x] Full stdlib test suite
* [ ] Full LSP test suite
* [x] Formatter tests
* [x] Package manager tests
* [ ] Registry tests
* [ ] FFI tests
* [ ] Debugger tests
* [x] Cross-platform CI
* [x] Clean-machine tests
* [x] End-to-end tests
* [x] Regression test suite

## Performance

* [ ] Compiler performance benchmark
* [ ] Runtime performance benchmark
* [ ] Async performance benchmark
* [ ] Startup time benchmark
* [ ] Memory usage benchmark
* [ ] Package installation performance
* [ ] Large-project compilation test

Establish baseline metrics before v1.0.

## Security

* [x] Registry HTTPS
* [x] Package integrity checks
* [x] Lockfile integrity
* [x] Secure authentication
* [ ] FFI security documentation
* [ ] Native dependency security review
* [ ] Dependency vulnerability policy
* [ ] Report-security process

## Stability

* [ ] No known critical compiler crashes
* [ ] No known critical runtime crashes
* [ ] No known critical package manager bugs
* [ ] No known critical cross-platform issues
* [ ] No known critical async deadlocks
* [ ] No known critical memory leaks
* [ ] No known critical data corruption issues
