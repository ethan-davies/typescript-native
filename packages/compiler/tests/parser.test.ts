import { describe, expect, it } from "vitest";
import type { FunctionDeclaration, Program } from "../src/ast/nodes.js";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import { Lexer } from "../src/lexer/index.js";
import { Parser } from "../src/parser/index.js";

function parse(source: string) {
  const diagnostics = new DiagnosticCollector();
  const tokens = new Lexer(source, diagnostics).tokenize();
  const ast = new Parser(tokens, diagnostics).parse();
  return { ast, diagnostics };
}

function functionAt(ast: Program, index: number): FunctionDeclaration {
  const decl = ast.body[index];
  expect(decl?.kind).toBe("FunctionDeclaration");
  if (decl?.kind !== "FunctionDeclaration") {
    throw new Error(`expected FunctionDeclaration at index ${index}`);
  }
  return decl;
}

describe("Parser", () => {
  it("parses main with a return type and print statement", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        print("hi");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body).toHaveLength(1);
    const main = functionAt(ast, 0);
    expect(main.name.name).toBe("main");
    expect(main.returnType).toMatchObject({ kind: "PrimitiveType", name: "void" });
    expect(main.params).toEqual([]);
    expect(main.body).toHaveLength(1);

    const stmt = main.body[0];
    expect(stmt?.kind).toBe("ExpressionStatement");
    if (stmt?.kind !== "ExpressionStatement") {
      return;
    }
    const call = stmt.expression;
    expect(call.kind).toBe("CallExpression");
    if (call.kind !== "CallExpression") {
      return;
    }
    expect(call.callee.kind).toBe("Identifier");
    if (call.callee.kind === "Identifier") {
      expect(call.callee.name).toBe("print");
    }
    expect(call.args[0]).toMatchObject({
      kind: "StringLiteral",
      value: "hi",
    });
  });

  it("parses let/const, assignment, and multi-arg print", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        let x = 42;
        const s: string = "hi";
        x = 10;
        print("Hello", "world");
        print("a" + "b");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const body = functionAt(ast, 0).body;
    expect(body).toHaveLength(5);
    expect(body[0]?.kind).toBe("VariableDeclaration");
    expect(body[1]?.kind).toBe("VariableDeclaration");
    expect(body[2]?.kind).toBe("AssignmentStatement");
    expect(body[3]?.kind).toBe("ExpressionStatement");
    expect(body[4]?.kind).toBe("ExpressionStatement");

    if (body[0]?.kind === "VariableDeclaration") {
      expect(body[0].mutability).toBe("let");
      expect(body[0].initializer.kind).toBe("IntegerLiteral");
    }
    if (body[1]?.kind === "VariableDeclaration") {
      expect(body[1].mutability).toBe("const");
      expect(body[1].typeAnnotation).toMatchObject({ kind: "PrimitiveType", name: "string" });
    }
    if (body[4]?.kind === "ExpressionStatement" && body[4].expression.kind === "CallExpression") {
      const arg = body[4].expression.args[0];
      expect(arg?.kind).toBe("BinaryExpression");
    }
  });

  it("parses literal forms", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        print(1);
        print(2.5);
        print(true);
        print(false);
        print('z');
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const kinds = functionAt(ast, 0).body.map((stmt) => {
      if (stmt.kind !== "ExpressionStatement" || stmt.expression.kind !== "CallExpression") {
        return null;
      }
      return stmt.expression.args[0]?.kind;
    });
    expect(kinds).toEqual([
      "IntegerLiteral",
      "FloatLiteral",
      "BooleanLiteral",
      "BooleanLiteral",
      "CharLiteral",
    ]);
  });

  it("parses an empty main body", () => {
    const { ast, diagnostics } = parse("function main(): void {}");
    expect(diagnostics.hasErrors).toBe(false);
    expect(functionAt(ast, 0).body).toEqual([]);
  });

  it("rejects missing return type", () => {
    const { diagnostics } = parse(`
      function main() {
        print("x");
      }
    `);
    expect(diagnostics.hasErrors).toBe(true);
  });

  it("rejects missing parentheses", () => {
    const { diagnostics } = parse('function main: void { print("x"); }');
    expect(diagnostics.hasErrors).toBe(true);
  });

  it("rejects unknown type names", () => {
    const { ast, diagnostics } = parse(`
      function main(): widget {}
    `);
    // Named types are accepted at parse time; resolution happens in typecheck.
    expect(diagnostics.hasErrors).toBe(false);
      expect(ast.body[0]).toMatchObject({
      kind: "FunctionDeclaration",
      returnType: { kind: "NamedType", namespace: null, name: "widget" },
    });
  });

  it("parses struct declarations, literals, and field assignment", () => {
    const { ast, diagnostics } = parse(`
      struct Person {
        name: string;
        age: i32;
      }
      function main(): void {
        let p = Person {
          name: "John",
          age: 16
        };
        p.age = 17;
        print(p.name);
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body).toHaveLength(2);
    expect(ast.body[0]).toMatchObject({
      kind: "StructDeclaration",
      name: { name: "Person" },
    });
    if (ast.body[0]?.kind === "StructDeclaration") {
      expect(ast.body[0].fields).toHaveLength(2);
      expect(ast.body[0].fields[0]?.name.name).toBe("name");
      expect(ast.body[0].fields[0]?.typeAnnotation).toMatchObject({
        kind: "PrimitiveType",
        name: "string",
      });
      expect(ast.body[0].fields[1]?.name.name).toBe("age");
    }

    if (ast.body[1]?.kind !== "FunctionDeclaration") {
      return;
    }
    const body = ast.body[1].body;
    expect(body[0]?.kind).toBe("VariableDeclaration");
    if (body[0]?.kind === "VariableDeclaration") {
      expect(body[0].initializer.kind).toBe("StructLiteral");
      if (body[0].initializer.kind === "StructLiteral") {
        expect(body[0].initializer.name.name).toBe("Person");
        expect(body[0].initializer.fields).toHaveLength(2);
      }
    }
    expect(body[1]?.kind).toBe("AssignmentStatement");
    if (body[1]?.kind === "AssignmentStatement") {
      expect(body[1].target.kind).toBe("MemberExpression");
    }
  });

  it("parses enum declarations and variant access", () => {
    const { ast, diagnostics } = parse(`
      enum Direction {
        Up,
        Down,
        Left,
        Right,
      }
      function main(): void {
        let direction: Direction = Direction.Up;
        print(direction);
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body).toHaveLength(2);
    expect(ast.body[0]).toMatchObject({
      kind: "EnumDeclaration",
      name: { name: "Direction" },
    });
    if (ast.body[0]?.kind === "EnumDeclaration") {
      expect(ast.body[0].variants.map((v) => v.name.name)).toEqual([
        "Up",
        "Down",
        "Left",
        "Right",
      ]);
    }

    if (ast.body[1]?.kind !== "FunctionDeclaration") {
      return;
    }
    const decl = ast.body[1].body[0];
    expect(decl?.kind).toBe("VariableDeclaration");
    if (decl?.kind === "VariableDeclaration") {
      expect(decl.typeAnnotation).toMatchObject({
        kind: "NamedType",
        namespace: null,
        name: "Direction",
      });
      expect(decl.initializer.kind).toBe("MemberExpression");
      if (decl.initializer.kind === "MemberExpression") {
        expect(decl.initializer.object).toMatchObject({
          kind: "Identifier",
          name: "Direction",
        });
        expect(decl.initializer.property.name).toBe("Up");
      }
    }
  });

  it("parses arithmetic precedence, parentheses, and unary minus", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        print(2 + 3 * 4);
        print((2 + 3) * 4);
        print(-5);
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const body = functionAt(ast, 0).body;
    expect(body).toHaveLength(3);

    const first = body[0];
    expect(first?.kind).toBe("ExpressionStatement");
    if (first?.kind === "ExpressionStatement" && first.expression.kind === "CallExpression") {
      const expr = first.expression.args[0];
      expect(expr?.kind).toBe("BinaryExpression");
      if (expr?.kind === "BinaryExpression") {
        expect(expr.operator).toBe("+");
        expect(expr.right.kind).toBe("BinaryExpression");
        if (expr.right.kind === "BinaryExpression") {
          expect(expr.right.operator).toBe("*");
        }
      }
    }

    const second = body[1];
    if (second?.kind === "ExpressionStatement" && second.expression.kind === "CallExpression") {
      const expr = second.expression.args[0];
      expect(expr?.kind).toBe("BinaryExpression");
      if (expr?.kind === "BinaryExpression") {
        expect(expr.operator).toBe("*");
        expect(expr.left.kind).toBe("BinaryExpression");
      }
    }

    const third = body[2];
    if (third?.kind === "ExpressionStatement" && third.expression.kind === "CallExpression") {
      expect(third.expression.args[0]?.kind).toBe("UnaryExpression");
    }
  });

  it("parses left-associative additive and multiplicative chains", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        print(1 - 2 - 3);
        print(8 / 2 / 2);
        print(8 % 5 % 2);
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const body = functionAt(ast, 0).body;

    const checkLeftAssoc = (index: number, operator: string) => {
      const stmt = body[index];
      expect(stmt?.kind).toBe("ExpressionStatement");
      if (stmt?.kind !== "ExpressionStatement" || stmt.expression.kind !== "CallExpression") {
        return;
      }
      const expr = stmt.expression.args[0];
      expect(expr?.kind).toBe("BinaryExpression");
      if (expr?.kind === "BinaryExpression") {
        expect(expr.operator).toBe(operator);
        expect(expr.left.kind).toBe("BinaryExpression");
        if (expr.left.kind === "BinaryExpression") {
          expect(expr.left.operator).toBe(operator);
        }
      }
    };

    checkLeftAssoc(0, "-");
    checkLeftAssoc(1, "/");
    checkLeftAssoc(2, "%");
  });

  it("parses multiple functions with parameters and return", () => {
    const { ast, diagnostics } = parse(`
      function add(a: i32, b: i32): i32 {
        return a + b;
      }
      function main(): void {
        print(add(1, 2));
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body).toHaveLength(2);
    const add = functionAt(ast, 0);
    expect(add.name.name).toBe("add");
    expect(add.params).toHaveLength(2);
    expect(add.params[0]?.name.name).toBe("a");
    expect(add.params[0]?.typeAnnotation).toMatchObject({
      kind: "PrimitiveType",
      name: "i32",
    });
    expect(add.body[0]?.kind).toBe("ReturnStatement");
    if (add.body[0]?.kind === "ReturnStatement") {
      expect(add.body[0].value?.kind).toBe("BinaryExpression");
    }
    expect(functionAt(ast, 1).name.name).toBe("main");
  });

  it("parses bare return in a void function", () => {
    const { ast, diagnostics } = parse(`
      function noop(): void {
        return;
      }
      function main(): void {}
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const stmt = functionAt(ast, 0).body[0];
    expect(stmt?.kind).toBe("ReturnStatement");
    if (stmt?.kind === "ReturnStatement") {
      expect(stmt.value).toBeNull();
    }
  });

  it("parses comparison and logical precedence", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        print(1 < 2 == true && false || !true);
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const stmt = functionAt(ast, 0).body[0];
    expect(stmt?.kind).toBe("ExpressionStatement");
    if (stmt?.kind !== "ExpressionStatement" || stmt.expression.kind !== "CallExpression") {
      return;
    }
    const expr = stmt.expression.args[0];
    expect(expr?.kind).toBe("BinaryExpression");
    if (expr?.kind !== "BinaryExpression") {
      return;
    }
    // || is lowest: (1 < 2 == true && false) || !true
    expect(expr.operator).toBe("||");
    expect(expr.left.kind).toBe("BinaryExpression");
    if (expr.left.kind === "BinaryExpression") {
      expect(expr.left.operator).toBe("&&");
    }
    expect(expr.right.kind).toBe("UnaryExpression");
    if (expr.right.kind === "UnaryExpression") {
      expect(expr.right.operator).toBe("!");
    }
  });

  it("parses if / elseif / else chains", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        let age = 16;
        if (age >= 18) {
          print("Adult");
        } elseif (age >= 13) {
          print("Teen");
        } else {
          print("Minor");
        }
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const stmt = functionAt(ast, 0).body[1];
    expect(stmt?.kind).toBe("IfStatement");
    if (stmt?.kind !== "IfStatement") {
      return;
    }
    expect(stmt.condition.kind).toBe("BinaryExpression");
    if (stmt.condition.kind === "BinaryExpression") {
      expect(stmt.condition.operator).toBe(">=");
    }
    expect(stmt.consequent).toHaveLength(1);
    expect(stmt.alternate).not.toBeNull();
    expect(!Array.isArray(stmt.alternate) && stmt.alternate?.kind === "IfStatement").toBe(true);
    if (!Array.isArray(stmt.alternate) && stmt.alternate?.kind === "IfStatement") {
      expect(stmt.alternate.alternate).toHaveLength(1);
      expect(Array.isArray(stmt.alternate.alternate)).toBe(true);
    }
  });

  it("parses while, for, updates, break, and continue", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        let n = 5;
        while (n > 0) {
          n--;
          continue;
        }
        for (let i = 0; i < 3; i++) {
          i += 1;
          break;
        }
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const body = functionAt(ast, 0).body;
    expect(body[1]?.kind).toBe("WhileStatement");
    if (body[1]?.kind === "WhileStatement") {
      expect(body[1].body[0]?.kind).toBe("UpdateStatement");
      expect(body[1].body[1]?.kind).toBe("ContinueStatement");
      if (body[1].body[0]?.kind === "UpdateStatement") {
        expect(body[1].body[0].operator).toBe("--");
      }
    }
    expect(body[2]?.kind).toBe("ForStatement");
    if (body[2]?.kind === "ForStatement") {
      expect(body[2].initializer?.kind).toBe("VariableDeclaration");
      expect(body[2].condition?.kind).toBe("BinaryExpression");
      expect(body[2].update?.kind).toBe("UpdateStatement");
      if (body[2].update?.kind === "UpdateStatement") {
        expect(body[2].update.operator).toBe("++");
      }
      expect(body[2].body[0]?.kind).toBe("AssignmentStatement");
      if (body[2].body[0]?.kind === "AssignmentStatement") {
        expect(body[2].body[0].operator).toBe("+=");
      }
      expect(body[2].body[1]?.kind).toBe("BreakStatement");
    }
  });

  it("parses array types, literals, indexing, methods, and for-in", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        let numbers: i32[] = [1, 2, 3];
        print(numbers[0]);
        numbers[0] = 10;
        print(numbers.length);
        numbers.push(4);
        for (i in numbers) {
          print(i);
        }
        for (let x in numbers) {
          print(x);
        }
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const body = functionAt(ast, 0).body;
    expect(body[0]?.kind).toBe("VariableDeclaration");
    if (body[0]?.kind === "VariableDeclaration") {
      expect(body[0].typeAnnotation?.kind).toBe("ArrayType");
      if (body[0].typeAnnotation?.kind === "ArrayType") {
        expect(body[0].typeAnnotation.element).toMatchObject({
          kind: "PrimitiveType",
          name: "i32",
        });
      }
      expect(body[0].initializer.kind).toBe("ArrayLiteral");
      if (body[0].initializer.kind === "ArrayLiteral") {
        expect(body[0].initializer.elements).toHaveLength(3);
      }
    }

    if (body[1]?.kind === "ExpressionStatement" && body[1].expression.kind === "CallExpression") {
      expect(body[1].expression.args[0]?.kind).toBe("IndexExpression");
    }

    expect(body[2]?.kind).toBe("AssignmentStatement");
    if (body[2]?.kind === "AssignmentStatement") {
      expect(body[2].target.kind).toBe("IndexExpression");
    }

    if (body[3]?.kind === "ExpressionStatement" && body[3].expression.kind === "CallExpression") {
      expect(body[3].expression.args[0]?.kind).toBe("MemberExpression");
    }

    expect(body[4]?.kind).toBe("ExpressionStatement");
    if (body[4]?.kind === "ExpressionStatement" && body[4].expression.kind === "CallExpression") {
      expect(body[4].expression.callee.kind).toBe("MemberExpression");
    }

    expect(body[5]?.kind).toBe("ForInStatement");
    if (body[5]?.kind === "ForInStatement") {
      expect(body[5].mutability).toBeNull();
      expect(body[5].name.name).toBe("i");
    }

    expect(body[6]?.kind).toBe("ForInStatement");
    if (body[6]?.kind === "ForInStatement") {
      expect(body[6].mutability).toBe("let");
      expect(body[6].name.name).toBe("x");
    }
  });

  it("parses import, alias, and export declarations", () => {
    const { ast, diagnostics } = parse(`
      import "math";
      import "math/vector" as v;
      export function add(a: i32, b: i32): i32 {
        return a + b;
      }
      export struct Point {
        x: i32;
      }
      export enum Color {
        Red,
        Blue
      }
      function main(): void {
        print(math.add(1, 2));
        print(v.add(3, 4));
        let p: math.Point = math.Point { x: 1 };
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body[0]).toMatchObject({
      kind: "ImportDeclaration",
      source: { value: "math" },
      alias: null,
    });
    expect(ast.body[1]).toMatchObject({
      kind: "ImportDeclaration",
      source: { value: "math/vector" },
      alias: { name: "v" },
    });
    expect(ast.body[2]).toMatchObject({
      kind: "FunctionDeclaration",
      exported: true,
      name: { name: "add" },
    });
    expect(ast.body[3]).toMatchObject({
      kind: "StructDeclaration",
      exported: true,
      name: { name: "Point" },
    });
    expect(ast.body[4]).toMatchObject({
      kind: "EnumDeclaration",
      exported: true,
      name: { name: "Color" },
    });
    expect(ast.body[5]).toMatchObject({
      kind: "FunctionDeclaration",
      exported: false,
      name: { name: "main" },
    });

    if (ast.body[5]?.kind !== "FunctionDeclaration") {
      return;
    }
    const body = ast.body[5].body;
    expect(body[2]?.kind).toBe("VariableDeclaration");
    if (body[2]?.kind === "VariableDeclaration") {
      expect(body[2].typeAnnotation).toMatchObject({
        kind: "NamedType",
        namespace: "math",
        name: "Point",
      });
      expect(body[2].initializer).toMatchObject({
        kind: "StructLiteral",
        namespace: { name: "math" },
        name: { name: "Point" },
      });
    }
  });

  it("rejects imports after other declarations", () => {
    const { diagnostics } = parse(`
      function main(): void {}
      import "math";
    `);
    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0105")).toBe(true);
  });

  it("parses interface declarations with extends and class implements", () => {
    const { ast, diagnostics } = parse(`
      interface Drawable {
        draw(): void;
      }
      interface ColorDrawable extends Drawable {
        getColor(): string;
      }
      class Circle implements Drawable, ColorDrawable {
        draw(): void { print("c"); }
        getColor(): string { return "red"; }
      }
      function main(): void {}
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body[0]).toMatchObject({
      kind: "InterfaceDeclaration",
      name: { name: "Drawable" },
      bases: [],
    });
    expect(ast.body[1]).toMatchObject({
      kind: "InterfaceDeclaration",
      name: { name: "ColorDrawable" },
      bases: [{ kind: "NamedType", name: "Drawable" }],
    });
    expect(ast.body[2]).toMatchObject({
      kind: "ClassDeclaration",
      name: { name: "Circle" },
      implementsTypes: [
        { kind: "NamedType", name: "Drawable" },
        { kind: "NamedType", name: "ColorDrawable" },
      ],
    });
    if (ast.body[0]?.kind === "InterfaceDeclaration") {
      expect(ast.body[0].methods).toHaveLength(1);
      expect(ast.body[0].methods[0]).toMatchObject({
        kind: "InterfaceMethodSignature",
        name: { name: "draw" },
      });
    }
  });

  it("rejects interface field members", () => {
    const { diagnostics } = parse(`
      interface Person {
        name: string;
      }
      function main(): void {}
    `);
    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.diagnostics.some((d) => d.code === "E0370")).toBe(true);
  });

  it("parses generic structs, functions, constraints, and type arguments", () => {
    const { ast, diagnostics } = parse(`
      struct Box<T> {
        value: T;
      }
      struct Pair<K, V> {
        key: K;
        value: V;
      }
      function identity<T>(value: T): T {
        return value;
      }
      function sort<T extends Comparable>(items: T): void {}
      function main(): void {
        let b: Box<i32> = Box<i32> { value: 1 };
        print(identity<i32>(1));
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body[0]).toMatchObject({
      kind: "StructDeclaration",
      name: { name: "Box" },
      typeParams: [{ kind: "TypeParameter", name: { name: "T" }, constraint: null }],
    });
    expect(ast.body[1]).toMatchObject({
      kind: "StructDeclaration",
      name: { name: "Pair" },
      typeParams: [
        { name: { name: "K" } },
        { name: { name: "V" } },
      ],
    });
    expect(ast.body[2]).toMatchObject({
      kind: "FunctionDeclaration",
      name: { name: "identity" },
      typeParams: [{ name: { name: "T" } }],
    });
    expect(ast.body[3]).toMatchObject({
      kind: "FunctionDeclaration",
      name: { name: "sort" },
      typeParams: [
        {
          name: { name: "T" },
          constraint: { kind: "NamedType", name: "Comparable" },
        },
      ],
    });
    const main = ast.body[4];
    expect(main?.kind).toBe("FunctionDeclaration");
    if (main?.kind === "FunctionDeclaration") {
      const letStmt = main.body[0];
      expect(letStmt?.kind).toBe("VariableDeclaration");
      if (letStmt?.kind === "VariableDeclaration") {
        expect(letStmt.typeAnnotation).toMatchObject({
          kind: "NamedType",
          name: "Box",
          typeArgs: [{ kind: "PrimitiveType", name: "i32" }],
        });
        expect(letStmt.initializer).toMatchObject({
          kind: "StructLiteral",
          name: { name: "Box" },
          typeArgs: [{ kind: "PrimitiveType", name: "i32" }],
        });
      }
      const printStmt = main.body[1];
      expect(printStmt?.kind).toBe("ExpressionStatement");
      if (printStmt?.kind === "ExpressionStatement") {
        expect(printStmt.expression).toMatchObject({
          kind: "CallExpression",
          callee: { name: "print" },
        });
        const inner = printStmt.expression;
        if (inner.kind === "CallExpression") {
          expect(inner.args[0]).toMatchObject({
            kind: "CallExpression",
            callee: { name: "identity" },
            typeArgs: [{ kind: "PrimitiveType", name: "i32" }],
          });
        }
      }
    }
  });

  it("keeps comparison expressions distinct from generic calls", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        let a: i32 = 1;
        let b: i32 = 2;
        if (a < b) {
          print(a);
        }
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const main = ast.body[0];
    expect(main?.kind).toBe("FunctionDeclaration");
    if (main?.kind === "FunctionDeclaration") {
      const ifStmt = main.body[2];
      expect(ifStmt?.kind).toBe("IfStatement");
      if (ifStmt?.kind === "IfStatement") {
        expect(ifStmt.condition).toMatchObject({
          kind: "BinaryExpression",
          operator: "<",
        });
      }
    }
  });
});
