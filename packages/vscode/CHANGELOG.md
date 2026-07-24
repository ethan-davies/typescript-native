# Changelog

## 0.1.0

### Added

- Marketplace-ready packaging with a bundled language server and standard library
- Production IDE features: diagnostics, completion (with auto-import), hover,
  go-to-definition, find-all-references, rename, signature help, code actions,
  semantic tokens, and formatting
- Incremental document sync, analysis caching, cancellation, and crash isolation
  in the language server

### Notes

- The extension embeds the Sonite language server; installing the `sn` CLI is
  optional and only required for building/running projects from the terminal.
