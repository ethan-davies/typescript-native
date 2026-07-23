# Security Policy

The **sonite** project takes the security of our compiler, CLI, packages, and generated binaries seriously. 

If you believe you have found a security vulnerability in this repository, please report it to us as described below.

## Reporting Security Issues

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report security vulnerabilities directly via email to:

*   **Email:** me@ethann.dev

*(Alternatively, you may submit a private disclosure through the **"Report a vulnerability"** tab under the repository's **Security** tab on GitHub.)*

### What to include in your report

Please include as much of the following information as possible to help us triage and resolve the issue quickly:

*   **Type of issue:** (e.g., arbitrary code execution during compilation, unsafe LLVM IR generation, memory safety bug in compiled output, buffer overflow)
*   **Affected area:** The specific workspace package, module, or source file location
*   **Environment:** Relevant OS, Node.js, pnpm, or Clang configuration details required to reproduce the issue
*   **Reproduction:** Step-by-step instructions or a minimal reproducible `.sn` code snippet
*   **Proof of concept:** Exploit code or assembly/LLVM IR output demonstrating the bug (if applicable)
*   **Impact:** A brief explanation of the potential security impact

## Response Expectations

*   **Initial Response:** You will receive an acknowledgment of your report within 48 hours.
*   **Updates:** We will keep you informed of our progress as we investigate and work on a fix.
*   **Disclosure:** Once a resolution is applied, we will coordinate public disclosure as appropriate.
