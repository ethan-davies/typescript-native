import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {typeof import("vscode-textmate")} */
const vsctm = require("vscode-textmate");
/** @type {typeof import("vscode-oniguruma")} */
const oniguruma = require("vscode-oniguruma");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const grammarPath = path.join(packageRoot, "syntaxes/sn.tmLanguage.json");
const examplesRoot = path.join(repoRoot, "examples");

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectSnFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSnFiles(full)));
    } else if (entry.name.endsWith(".sn")) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * @returns {Promise<vsctm.IGrammar>}
 */
async function loadGrammar() {
  const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
  const wasmBin = await readFile(wasmPath);
  await oniguruma.loadWASM(
    wasmBin.buffer.slice(
      wasmBin.byteOffset,
      wasmBin.byteOffset + wasmBin.byteLength,
    ),
  );

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName) => {
      if (scopeName !== "source.sn") {
        return null;
      }
      const raw = await readFile(grammarPath, "utf8");
      return vsctm.parseRawGrammar(raw, grammarPath);
    },
  });

  const grammar = await registry.loadGrammar("source.sn");
  assert.ok(grammar, "failed to load source.sn grammar");
  return grammar;
}

/**
 * @param {vsctm.IGrammar} grammar
 * @param {string} source
 * @returns {{ text: string, scopes: string[] }[]}
 */
function tokenize(grammar, source) {
  /** @type {{ text: string, scopes: string[] }[]} */
  const tokens = [];
  let ruleStack = vsctm.INITIAL;
  for (const line of source.split(/\r?\n/)) {
    const { tokens: lineTokens, ruleStack: next } = grammar.tokenizeLine(
      line,
      ruleStack,
    );
    ruleStack = next;
    for (const token of lineTokens) {
      tokens.push({
        text: line.slice(token.startIndex, token.endIndex),
        scopes: token.scopes,
      });
    }
  }
  return tokens;
}

/**
 * @param {{ text: string, scopes: string[] }[]} tokens
 * @param {string} text
 * @param {string} scopeSubstring
 */
function assertTokenScoped(tokens, text, scopeSubstring) {
  const match = tokens.find(
    (t) => t.text === text && t.scopes.some((s) => s.includes(scopeSubstring)),
  );
  assert.ok(
    match,
    `expected token ${JSON.stringify(text)} with scope containing ${JSON.stringify(scopeSubstring)}; got ${JSON.stringify(
      tokens.filter((t) => t.text === text).map((t) => t.scopes),
      null,
      2,
    )}`,
  );
}

/**
 * @param {{ text: string, scopes: string[] }[]} tokens
 * @param {RegExp} textPattern
 * @param {string} scopeSubstring
 */
function assertSomeTokenScoped(tokens, textPattern, scopeSubstring) {
  const match = tokens.find(
    (t) =>
      textPattern.test(t.text) &&
      t.scopes.some((s) => s.includes(scopeSubstring)),
  );
  assert.ok(
    match,
    `expected some token matching ${textPattern} with scope containing ${JSON.stringify(scopeSubstring)}`,
  );
}

test("grammar JSON is valid and declares source.sn", async () => {
  const raw = await readFile(grammarPath, "utf8");
  const grammar = JSON.parse(raw);
  assert.equal(grammar.scopeName, "source.sn");
  assert.ok(grammar.repository);
  assert.ok(Array.isArray(grammar.patterns));
});

test("loads with vscode-textmate and tokenizes all examples", async () => {
  const grammar = await loadGrammar();
  const files = await collectSnFiles(examplesRoot);
  assert.ok(files.length > 0, "expected example .sn files");

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const tokens = tokenize(grammar, source);
    assert.ok(
      tokens.length > 0,
      `no tokens for ${path.relative(repoRoot, file)}`,
    );
    for (const token of tokens) {
      assert.ok(
        token.scopes.includes("source.sn"),
        `token missing source.sn in ${file}: ${JSON.stringify(token)}`,
      );
    }
  }
});

test("scopes SN-specific keywords, operators, literals, and builtins", async () => {
  const grammar = await loadGrammar();
  const source = `
// line comment
/* block comment */
import { add as sum } from "math";
export function identity<T>(value: T): T { return value; }

struct Person {
  name: string;
  age: i32;
}

enum Direction { Up, Down }

interface Drawable {
  draw(): void;
}

abstract class Animal {
  abstract speak(): void;
}

class Dog extends Animal implements Drawable {
  constructor() { super(); this; }
  private readonly id: i32 = 1;
  static count: i32 = 0;
  speak(): void { print("woof"); }
}

type IsString<T> = T extends string ? string : i32;
type ReadonlyPerson = { readonly [K in keyof Person]: Person[K]; };

function main(): void {
  let age: i64 = 16;
  const pi: f64 = 3.14;
  let flag: bool = true;
  let ch: char = '\\n';
  let maybe: string | null = null;
  let nums: i32[] = [1, 2, 3];
  let p = Person { name: "Alex", age: 16 };
  let boxed = Box<i32> { value: 42 };
  let map = createMap();
  let err = new Error("boom");

  if (age >= 18) {
    print("Adult");
  } elseif (age >= 13) {
    print("Teen");
  } else {
    print("Minor");
  }

  for (let i: i32 = 0; i < 5; i++) {
    if (i == 0) { continue; }
    if (i == 4) { break; }
  }

  for (n in nums) {
    print(n);
  }

  switch (Direction.Up) {
    case Direction.Up:
      break;
    default:
      break;
  }

  try {
    throw err;
  } catch (error) {
    print(error.message);
  } finally {
    print("done");
  }

  let display = maybe ?? "Unknown";
  print(p?.name ?? "none");
  print(nums?[0] ?? 0);
  print(maybe!.length);
  print(typeof maybe);
  if (maybe is string) {
    print(maybe);
  }

  let add = (a: i32, b: i32): i32 => a + b;
  let x = 1;
  x += 2;
  x--;
  let y = true && false || !flag;
  let z = age != 0;
}
`;

  const tokens = tokenize(grammar, source);

  assertTokenScoped(tokens, "elseif", "keyword.control");
  assertTokenScoped(tokens, "struct", "storage.type");
  assertTokenScoped(tokens, "enum", "storage.type");
  assertTokenScoped(tokens, "interface", "storage.type");
  assertTokenScoped(tokens, "abstract", "storage.modifier");
  assertTokenScoped(tokens, "private", "storage.modifier");
  assertTokenScoped(tokens, "readonly", "storage.modifier");
  assertTokenScoped(tokens, "static", "storage.modifier");
  assertTokenScoped(tokens, "extends", "keyword.control");
  assertTokenScoped(tokens, "implements", "keyword.control");
  assertTokenScoped(tokens, "constructor", "storage.type");
  assertTokenScoped(tokens, "this", "variable.language");
  assertTokenScoped(tokens, "super", "variable.language");
  assertTokenScoped(tokens, "keyof", "keyword.operator");
  assertTokenScoped(tokens, "typeof", "keyword.operator");
  assertTokenScoped(tokens, "is", "keyword.operator");
  assertTokenScoped(tokens, "as", "keyword.control.import");
  assertTokenScoped(tokens, "from", "keyword.control.import");
  assertTokenScoped(tokens, "import", "keyword.control.import");
  assertTokenScoped(tokens, "export", "keyword.control.export");
  assertTokenScoped(tokens, "true", "constant.language.boolean");
  assertTokenScoped(tokens, "false", "constant.language.boolean");
  assertTokenScoped(tokens, "null", "constant.language.null");
  assertTokenScoped(tokens, "i32", "support.type.primitive");
  assertTokenScoped(tokens, "i64", "support.type.primitive");
  assertTokenScoped(tokens, "f64", "support.type.primitive");
  assertTokenScoped(tokens, "bool", "support.type.primitive");
  assertTokenScoped(tokens, "string", "support.type.primitive");
  assertTokenScoped(tokens, "char", "support.type.primitive");
  assertTokenScoped(tokens, "void", "support.type.primitive");
  assertTokenScoped(tokens, "print", "support.function.builtin");
  assertTokenScoped(tokens, "createMap", "support.function.builtin");
  assertTokenScoped(tokens, "Error", "support.class.builtin");
  assertTokenScoped(tokens, "??", "keyword.operator.nullish");
  assertTokenScoped(tokens, "?.", "keyword.operator.optional");
  assertTokenScoped(tokens, "?[", "keyword.operator.optional");
  assertTokenScoped(tokens, "=>", "storage.type.function.arrow");
  assertTokenScoped(tokens, "+=", "keyword.operator.assignment.compound");
  assertTokenScoped(tokens, "--", "keyword.operator.assignment.compound");
  assertTokenScoped(tokens, "&&", "keyword.operator.logical");
  assertTokenScoped(tokens, "||", "keyword.operator.logical");
  assertTokenScoped(tokens, "!=", "keyword.operator.comparison");
  assertTokenScoped(tokens, ">=", "keyword.operator.comparison");
  assertTokenScoped(tokens, "==", "keyword.operator.comparison");
  assertTokenScoped(tokens, "new", "keyword.operator.expression");
  assertTokenScoped(tokens, "in", "keyword.control.inheritance");
  assertTokenScoped(tokens, "try", "keyword.control");
  assertTokenScoped(tokens, "catch", "keyword.control");
  assertTokenScoped(tokens, "finally", "keyword.control");
  assertTokenScoped(tokens, "throw", "keyword.control");
  assertTokenScoped(tokens, "switch", "keyword.control");
  assertTokenScoped(tokens, "case", "keyword.control");
  assertTokenScoped(tokens, "default", "keyword.control");
  assertTokenScoped(tokens, "continue", "keyword.control");
  assertTokenScoped(tokens, "break", "keyword.control");

  assertSomeTokenScoped(tokens, /^\/\//, "comment.line");
  assertSomeTokenScoped(tokens, /^\/\*/, "comment.block");
  assertSomeTokenScoped(tokens, /^"/, "string.quoted.double");
  assertSomeTokenScoped(tokens, /^'/, "string.quoted.single");
  assertSomeTokenScoped(tokens, /^\\n$/, "constant.character.escape");
  assertTokenScoped(tokens, "3.14", "constant.numeric.float");
  assertTokenScoped(tokens, "16", "constant.numeric.integer");
  assertTokenScoped(tokens, "Person", "entity.name.type");
  assertTokenScoped(tokens, "identity", "entity.name.function");
  assertTokenScoped(tokens, "|", "keyword.operator.bitwise");
  assertTokenScoped(tokens, "?", "keyword.operator.ternary");
});

test("example corpus contains expected SN markers with correct scopes", async () => {
  const grammar = await loadGrammar();

  /** @type {{ file: string, checks: [string, string][] }[]} */
  const cases = [
    {
      file: "control-flow.sn",
      checks: [
        ["elseif", "keyword.control"],
        ["if", "keyword.control"],
        ["else", "keyword.control"],
      ],
    },
    {
      file: "structs.sn",
      checks: [
        ["struct", "storage.type"],
        ["string", "support.type.primitive"],
        ["i32", "support.type.primitive"],
      ],
    },
    {
      file: "null-operators.sn",
      checks: [
        ["??", "keyword.operator.nullish"],
        ["?.", "keyword.operator.optional"],
      ],
    },
    {
      file: "errors.sn",
      checks: [
        ["throw", "keyword.control"],
        ["try", "keyword.control"],
        ["catch", "keyword.control"],
        ["Error", "support.class.builtin"],
        ["new", "keyword.operator.expression"],
      ],
    },
    {
      file: "lambdas.sn",
      checks: [["=>", "storage.type.function.arrow"]],
    },
    {
      file: "type-operators.sn",
      checks: [
        ["keyof", "keyword.operator"],
        ["typeof", "keyword.operator"],
        ["extends", "keyword.control"],
        ["readonly", "storage.modifier"],
      ],
    },
    {
      file: "modules/named-main.sn",
      checks: [
        ["import", "keyword.control.import"],
        ["from", "keyword.control.import"],
        ["as", "keyword.control.import"],
      ],
    },
    {
      file: "enums.sn",
      checks: [["enum", "storage.type"]],
    },
    {
      file: "inheritance.sn",
      checks: [
        ["abstract", "storage.modifier"],
        ["class", "storage.type"],
        ["extends", "keyword.control"],
        ["super", "variable.language"],
      ],
    },
    {
      file: "interfaces.sn",
      checks: [
        ["interface", "storage.type"],
        ["implements", "keyword.control"],
      ],
    },
  ];

  for (const { file, checks } of cases) {
    const source = await readFile(path.join(examplesRoot, file), "utf8");
    const tokens = tokenize(grammar, source);
    for (const [text, scope] of checks) {
      assertTokenScoped(tokens, text, scope);
    }
  }
});
