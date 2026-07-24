# Sonite v1.0.0 Roadmap

## Phase 1 — Cross-Platform Toolchain, Runtime & Standard Library

### Native compiler toolchain

* [ ] LLVM version pinned
* [ ] LLVM C API binding production-ready
* [ ] LLVM object emission through `TargetMachine`
* [ ] LLD integration
* [ ] No `clang` subprocess
* [ ] No `llc` subprocess
* [ ] No `ld.lld` subprocess
* [ ] No system LLVM requirement
* [ ] No system Clang requirement
* [ ] No system LLD requirement
* [ ] Native LLVM libraries bundled
* [ ] Native LLD libraries bundled
* [ ] Native library loading works without environment configuration
* [ ] Reproducible native toolchain builds
* [ ] Platform detection
* [ ] Correct target triples
* [ ] Correct object formats
* [ ] Correct ABI configuration
* [ ] Correct system library linking

### Supported targets

* [ ] Linux x64
* [ ] Linux ARM64
* [ ] macOS x64
* [ ] macOS ARM64
* [ ] Windows x64
* [ ] Windows ARM64 explicitly deferred

### Native packages

* [ ] `@sonite/llvm-linux-x64`
* [ ] `@sonite/llvm-linux-arm64`
* [ ] `@sonite/llvm-macos-x64`
* [ ] `@sonite/llvm-macos-arm64`
* [ ] `@sonite/llvm-win32-x64`
* [ ] Automatic platform package selection
* [ ] Unsupported platform diagnostics

### Runtime

* [ ] Linux x64 runtime
* [ ] Linux ARM64 runtime
* [ ] macOS x64 runtime
* [ ] macOS ARM64 runtime
* [ ] Windows x64 runtime
* [ ] Cross-platform runtime ABI
* [ ] Memory management
* [ ] Garbage collection
* [ ] Exceptions
* [ ] Strings
* [ ] Arrays
* [ ] Console I/O
* [ ] Template-string formatting
* [ ] Async/await
* [ ] Async I/O
* [ ] Byte streams
* [ ] Filesystem
* [ ] Paths
* [ ] TCP
* [ ] UDP
* [ ] DNS
* [ ] TLS
* [ ] HTTP
* [ ] HTTPS

### Standard library

* [ ] Cross-platform strings
* [ ] Cross-platform collections
* [ ] Cross-platform math
* [ ] Cross-platform filesystem
* [ ] Cross-platform paths
* [ ] Cross-platform networking
* [ ] Cross-platform TLS
* [ ] Cross-platform HTTP
* [ ] Cross-platform HTTPS
* [ ] Platform detection
* [ ] Consistent error types
* [ ] Consistent API semantics

### Cross-platform validation

* [ ] All core language features compile on every target
* [ ] All runtime functionality works on every target
* [ ] All stdlib functionality works on every target
* [ ] Async client/server round-trip on every target
* [ ] HTTPS round-trip on every target
* [ ] Clean-machine installation tests
* [ ] No-system-LLVM tests
* [ ] Native dependency inspection
* [ ] Full cross-platform CI

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

* [ ] Go-to-references fully production-ready
* [ ] Rename symbol
* [ ] Signature help
* [ ] Code actions
* [ ] Auto-import fully production-ready
* [ ] Semantic tokens
* [ ] Unused-import diagnostics
* [ ] Remove unused import action
* [ ] Organize imports
* [ ] Add missing import action
* [ ] Correct import insertion
* [ ] Correct import removal
* [ ] Correct import sorting

### Language server robustness

* [ ] Incremental document updates
* [ ] Correct diagnostics after edits
* [ ] Correct diagnostics after imports change
* [ ] Workspace-aware module resolution
* [ ] Multi-file project analysis
* [ ] Dependency/package analysis
* [ ] Large-project performance
* [ ] Cancellation support
* [ ] Graceful compiler failures
* [ ] No LSP crashes on invalid code

### VS Code extension

* [ ] Syntax highlighting
* [ ] LSP integration
* [ ] Semantic tokens
* [ ] Completion UI
* [ ] Diagnostics UI
* [ ] Code actions
* [ ] Formatting integration
* [ ] Rename integration
* [ ] Signature help
* [ ] Auto-import
* [ ] Marketplace-ready packaging

---

# Phase 3 — Formatter & Code Quality

This should be a dedicated milestone because a formatter becomes important once the language is used by multiple people.

### Formatter

* [ ] Formatter implementation
* [ ] Parse source
* [ ] Format AST
* [ ] Preserve comments
* [ ] Preserve string contents
* [ ] Stable output
* [ ] Idempotent formatting
* [ ] Configurable indentation
* [ ] Configurable line width
* [ ] Import formatting
* [ ] Import ordering
* [ ] Multiline formatting
* [ ] Function formatting
* [ ] Type formatting
* [ ] Generic formatting
* [ ] Struct/class formatting
* [ ] Interface formatting
* [ ] Async/await formatting
* [ ] Error recovery on incomplete source

### CLI

* [ ] `sn fmt`
* [ ] `sn fmt --check`
* [ ] Format individual files
* [ ] Format entire projects
* [ ] Format only changed files where practical
* [ ] CI-friendly exit codes

### LSP

* [ ] Document formatting
* [ ] Format on save
* [ ] Range formatting if practical

### Code quality

* [ ] Compiler warnings framework
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
* [ ] Generic inference correctness
* [ ] Interface checking
* [ ] Async typechecking
* [ ] Exception checking
* [ ] Module resolution
* [ ] Circular dependency handling
* [ ] Import/export correctness
* [ ] Closure correctness
* [ ] Lambda correctness
* [ ] Function overload/dispatch correctness if applicable

### Code generation

* [ ] Correct LLVM IR generation
* [ ] Correct ABI lowering
* [ ] Correct struct layout
* [ ] Correct array layout
* [ ] Correct string representation
* [ ] Correct closure representation
* [ ] Correct generic monomorphisation/code generation
* [ ] Correct async state-machine generation
* [ ] Correct exception handling
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
* [ ] Structured compiler diagnostics
* [ ] Source spans on all major errors
* [ ] Error codes
* [ ] Helpful error messages
* [ ] Suggestions where practical
* [ ] Panic/crash reporting for compiler bugs

---

# Phase 5 — Public FFI & Native Interoperability

This is where `extern` evolves from primarily being an internal runtime mechanism into a supported way for Sonite packages to interact with native libraries.

### FFI language features

* [ ] Public `extern` declarations
* [ ] C ABI support
* [ ] External functions
* [ ] External variables if needed
* [ ] External structs
* [ ] Native pointers
* [ ] Pointer types
* [ ] Native arrays/buffers
* [ ] Native callbacks
* [ ] Function pointers
* [ ] C-compatible primitive types
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

* [ ] Lockfile implementation
* [ ] Deterministic dependency resolution
* [ ] Transitive dependencies
* [ ] Semantic version constraints
* [ ] Version conflict resolution
* [ ] Dependency updates
* [ ] Dependency removal
* [ ] Dependency overrides
* [ ] Local/path dependencies
* [ ] Git dependencies if desired
* [ ] Development dependencies if desired

### CLI

Ensure the package system has:

* [ ] `sn init`
* [ ] `sn add`
* [ ] `sn remove`
* [ ] `sn install`
* [ ] `sn update`
* [ ] `sn publish`
* [ ] `sn search`
* [ ] `sn info`
* [ ] `sn login`
* [ ] `sn logout`
* [ ] `sn build`
* [ ] `sn run`

### Lockfiles

* [ ] Lockfile format
* [ ] Dependency versions
* [ ] Resolved package URLs
* [ ] Integrity hashes
* [ ] Transitive dependency information
* [ ] Platform-specific dependency information
* [ ] Reproducible installs
* [ ] Lockfile validation

### Registry

* [ ] Package publishing
* [ ] Package downloading
* [ ] Package metadata
* [ ] Version management
* [ ] Package ownership
* [ ] Authentication
* [ ] Package deletion policy
* [ ] Deprecation
* [ ] Package search
* [ ] Package documentation
* [ ] Download statistics
* [ ] Abuse/security controls

### Package security

* [ ] Tarball integrity verification
* [ ] Checksums
* [ ] Registry HTTPS
* [ ] Authentication tokens
* [ ] Secure credential storage
* [ ] Dependency provenance where practical

### Project management

* [ ] Project configuration validation
* [ ] Build profiles
* [ ] Debug build
* [ ] Release build
* [ ] Optimisation levels
* [ ] Project metadata
* [ ] Entry point configuration
* [ ] Build output configuration

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
* [ ] Debug builds
* [ ] Release builds

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

* [ ] `sn init`
* [ ] `sn build`
* [ ] `sn run`
* [ ] `sn fmt`
* [ ] `sn fmt --check`
* [ ] `sn add`
* [ ] `sn remove`
* [ ] `sn install`
* [ ] `sn update`
* [ ] `sn publish`
* [ ] `sn search`
* [ ] `sn info`
* [ ] `sn login`
* [ ] `sn logout`

Remove or clearly mark experimental commands.

## Installation

* [ ] npm installation tested
* [ ] Linux installation tested
* [ ] macOS installation tested
* [ ] Windows installation tested
* [ ] Clean-machine installation
* [ ] No system LLVM requirement
* [ ] Native packages automatically selected
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

* [ ] Hello World
* [ ] CLI application
* [ ] Filesystem application
* [ ] Async application
* [ ] TCP server
* [ ] HTTP server
* [ ] HTTPS server
* [ ] HTTP client
* [ ] Package usage
* [ ] Package creation
* [ ] FFI example
* [ ] Debugging example

## Testing

* [ ] Full compiler test suite
* [ ] Full runtime test suite
* [ ] Full stdlib test suite
* [ ] Full LSP test suite
* [ ] Formatter tests
* [ ] Package manager tests
* [ ] Registry tests
* [ ] FFI tests
* [ ] Debugger tests
* [ ] Cross-platform CI
* [ ] Clean-machine tests
* [ ] End-to-end tests
* [ ] Regression test suite

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

* [ ] Registry HTTPS
* [ ] Package integrity checks
* [ ] Lockfile integrity
* [ ] Secure authentication
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
