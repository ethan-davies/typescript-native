import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, compileFile } from "../src/compiler.js";
import { encodeLlvmString } from "../src/codegen/llvm.js";

const examplesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../examples",
);
const modulesDir = join(examplesDir, "modules");

const helloSource = `
function main(): void {
  print("Hello, world!");
}
`;

describe("compile pipeline", () => {
  describe("successful compilation", () => {
    it("compiles hello world to LLVM IR with runtime print", () => {
      const result = compile(helloSource);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("declare void @sn_print_str");
      expect(result.ir).toContain("declare void @sn_print_newline");
      expect(result.ir).toContain("define i32 @main()");
      expect(result.ir).toContain("call void @sn_print_str");
      expect(result.ir).toContain("call void @sn_print_newline");
      expect(result.ir).toContain(encodeLlvmString("Hello, world!"));
      expect(result.ast.body[0]?.kind).toBe("FunctionDeclaration");
      if (result.ast.body[0]?.kind === "FunctionDeclaration") {
        expect(result.ast.body[0].name.name).toBe("main");
      }
    });

    it("allows changing the printed string", () => {
      const result = compile(`
        function main(): void {
          print("changed");
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain(encodeLlvmString("changed"));
      expect(result.ir).not.toContain(encodeLlvmString("Hello, world!"));
    });

    it("emits runtime print calls for multiple prints", () => {
      const result = compile(`
        function main(): void {
          print("a");
          print("b");
        }
      `);
      expect(result.success).toBe(true);
      const calls = result.ir?.match(/call void @sn_print_newline/g) ?? [];
      expect(calls).toHaveLength(2);
    });

    it("compiles annotated and inferred bindings", () => {
      const result = compile(`
        function main(): void {
          let age: i32 = 16;
          let name: string = "John";
          let active: bool = true;
          let inferredAge = 16;
          let inferredName = "John";
          print(age);
          print(name);
          print(active);
          print(inferredAge);
          print(inferredName);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%v.age = alloca i32");
      expect(result.ir).toContain("%v.name = alloca ptr");
      expect(result.ir).toContain("%v.active = alloca i1");
      expect(result.ir).toContain("%v.inferredAge = alloca i32");
      expect(result.ir).toContain("%v.inferredName = alloca ptr");
    });

    it("compiles variables, inference, and concat", () => {
      const result = compile(`
        function main(): void {
          let x = 42;
          const pi = 3.14;
          let n: i64 = 100;
          let ok = true;
          let c: char = 'a';
          let s = "hi";
          x = 10;
          print(42);
          print(x);
          print("Hello " + "world");
          print("Hello", "world");
          print(ok);
          print(c);
          print(s);
          print(pi);
          print(n);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%v.x = alloca i32");
      expect(result.ir).toContain("%v.pi = alloca double");
      expect(result.ir).toContain("%v.n = alloca i64");
      expect(result.ir).toContain("%v.ok = alloca i1");
      expect(result.ir).toContain("%v.c = alloca i8");
      expect(result.ir).toContain("%v.s = alloca ptr");
      expect(result.ir).toContain(encodeLlvmString("Hello world"));
      expect(result.ir).toContain("call void @sn_print_space");
    });

    it("compiles f32 annotations and float arithmetic", () => {
      const result = compile(`
        function main(): void {
          let a: f32 = 1.5;
          let b: f64 = 2.5;
          print(a);
          print(b + 1.0);
          print(b * 2.0);
          print(b / 2.0);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%v.a = alloca float");
      expect(result.ir).toContain("%v.b = alloca double");
      expect(result.ir).toContain("fadd double");
      expect(result.ir).toContain("fmul double");
      expect(result.ir).toContain("fdiv double");
    });

    it("compiles arithmetic with precedence", () => {
      const result = compile(`
        function main(): void {
          print(2 + 3 * 4);
          print((2 + 3) * 4);
          print(10 / 3);
          print(10 % 3);
          print(-5);
          print(1 - 2);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("mul i32");
      expect(result.ir).toContain("add i32");
      expect(result.ir).toContain("sdiv i32");
      expect(result.ir).toContain("srem i32");
      expect(result.ir).toContain("sub i32 0,");
      expect(result.ir).toContain("sub i32");
    });

    it("compiles runtime string concatenation", () => {
      const result = compile(`
        function main(): void {
          let name = "world";
          print("Hello " + name);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("declare ptr @sn_str_concat");
      expect(result.ir).toContain("call ptr @sn_str_concat");
    });

    it("compiles user-defined functions with parameters and calls", () => {
      const result = compile(`
        function add(a: i32, b: i32): i32 {
          return a + b;
        }
        function main(): void {
          let x = add(2, 3) * (4 - 1);
          print(x);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define i32 @add(i32 %arg0, i32 %arg1)");
      expect(result.ir).toContain("define i32 @main()");
      expect(result.ir).toContain("call i32 @add(i32 2, i32 3)");
      expect(result.ir).toContain("ret i32");
      expect(result.ir).toContain("mul i32");
      expect(result.ir).toContain("sub i32");
    });

    it("compiles void helpers and nested calls", () => {
      const result = compile(`
        function greet(name: string): void {
          print("Hello", name);
          return;
        }
        function double(n: i32): i32 {
          return n + n;
        }
        function main(): void {
          greet("Ada");
          print(double(double(2)));
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define void @greet(ptr %arg0)");
      expect(result.ir).toContain("call void @greet(ptr");
      expect(result.ir).toContain("define i32 @double(i32 %arg0)");
      expect(result.ir).toMatch(/call i32 @double\(i32 %t\d+\)/);
      expect(result.ir).toContain("ret void");
    });

    it("compiles i64 parameters and returns", () => {
      const result = compile(`
        function add64(a: i64, b: i64): i64 {
          return a + b;
        }
        function main(): void {
          let n: i64 = add64(10, 20);
          print(n);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define i64 @add64(i64 %arg0, i64 %arg1)");
      expect(result.ir).toContain("call i64 @add64(i64 10, i64 20)");
      expect(result.ir).toContain("add i64");
    });

    it("compiles comparisons, logical ops, and boolean print", () => {
      const result = compile(`
        function main(): void {
          print(5 > 2);
          print(1 == 1);
          print(1.5 < 2.0);
          print(!true);
          print(true && false);
          print(true || false);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("icmp sgt i32");
      expect(result.ir).toContain("icmp eq i32");
      expect(result.ir).toContain("fcmp olt double");
      expect(result.ir).toContain("xor i1");
      expect(result.ir).toContain("and i1");
      expect(result.ir).toContain("or i1");
      expect(result.ir).toContain("call void @sn_print_bool");
    });

    it("compiles if / elseif / else branches", () => {
      const result = compile(`
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
      expect(result.success).toBe(true);
      expect(result.ir).toContain("icmp sge i32");
      expect(result.ir).toContain("br i1");
      expect(result.ir).toContain("then.0:");
      expect(result.ir).toContain("else.0:");
      expect(result.ir).toContain("merge.0:");
      expect(result.ir).toContain(encodeLlvmString("Adult"));
      expect(result.ir).toContain(encodeLlvmString("Teen"));
      expect(result.ir).toContain(encodeLlvmString("Minor"));
    });

    it("compiles while and for loops with updates", () => {
      const result = compile(`
        function main(): void {
          let n: i32 = 3;
          while (n > 0) {
            print(n);
            n--;
          }
          for (let i = 0; i < 3; i++) {
            print(i);
          }
          let x = 10;
          x += 5;
          x -= 2;
          print(x);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("while.cond.0:");
      expect(result.ir).toContain("while.body.0:");
      expect(result.ir).toContain("while.exit.0:");
      expect(result.ir).toContain("for.cond.1:");
      expect(result.ir).toContain("for.body.1:");
      expect(result.ir).toContain("for.latch.1:");
      expect(result.ir).toContain("for.exit.1:");
      expect(result.ir).toContain("add i32");
      expect(result.ir).toContain("sub i32");
    });

    it("compiles break and continue in loops", () => {
      const result = compile(`
        function main(): void {
          for (let i = 0; i < 10; i++) {
            if (i == 2) {
              continue;
            }
            if (i == 5) {
              break;
            }
            print(i);
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("br label %for.latch.0");
      expect(result.ir).toContain("br label %for.exit.0");
    });

    it("compiles switch with break and default", () => {
      const result = compile(`
        function main(): void {
          let value: i32 = 1;
          switch (value) {
            case 1:
              print("one");
              break;
            case 2:
              print("two");
              break;
            default:
              print("other");
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("switch.check.0.0:");
      expect(result.ir).toContain("icmp eq i32");
      expect(result.ir).toContain("switch.exit.0:");
      expect(result.ir).toContain("br label %switch.exit.0");
      expect(result.ir).toContain(encodeLlvmString("one"));
      expect(result.ir).toContain(encodeLlvmString("other"));
    });

    it("compiles switch fallthrough between cases", () => {
      const result = compile(`
        function main(): void {
          let value: i32 = 1;
          switch (value) {
            case 1:
              print("one");
            case 2:
              print("two");
              break;
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("switch.case.0.0:");
      expect(result.ir).toContain("switch.case.0.1:");
      expect(result.ir).toContain(encodeLlvmString("one"));
      expect(result.ir).toContain(encodeLlvmString("two"));
    });

    it("compiles break in switch nested inside while", () => {
      const result = compile(`
        function main(): void {
          let n: i32 = 0;
          while (n < 3) {
            switch (n) {
              case 0:
                break;
            }
            n++;
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("br label %switch.exit.");
      expect(result.ir).toContain("while.cond.");
    });

    it("compiles continue in switch nested inside while", () => {
      const result = compile(`
        function main(): void {
          let n: i32 = 0;
          while (n < 3) {
            switch (n) {
              case 0:
                continue;
            }
            n++;
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("br label %while.cond.");
    });

    it("fails when switch case type does not match discriminant", () => {
      const result = compile(`
        function main(): void {
          let value: i32 = 10;
          switch (value) {
            case "hello":
              print("bad");
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0335")).toBe(true);
    });

    it("fails on duplicate switch cases", () => {
      const result = compile(`
        function main(): void {
          let value: i32 = 1;
          switch (value) {
            case 1:
              print("a");
            case 1:
              print("b");
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0336")).toBe(true);
    });

    it("fails on duplicate default cases", () => {
      const result = compile(`
        function main(): void {
          let value: i32 = 1;
          switch (value) {
            default:
              print("a");
            default:
              print("b");
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0337")).toBe(true);
    });

    it("fails when switch case is not a compile-time constant", () => {
      const result = compile(`
        function getValue(): i32 { return 1; }
        function main(): void {
          let value: i32 = 1;
          switch (value) {
            case getValue():
              print("bad");
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0322")).toBe(true);
    });

    it("compiles the hello, variables, arithmetic, control-flow, loops, arrays, structs, enums, struct-methods, classes, inheritance, interfaces, and generics examples", () => {
      for (const name of [
        "hello.sn",
        "variables.sn",
        "arithmetic.sn",
        "control-flow.sn",
        "loops.sn",
        "switch.sn",
        "arrays.sn",
        "structs.sn",
        "enums.sn",
        "struct-methods.sn",
        "classes.sn",
        "inheritance.sn",
        "interfaces.sn",
        "generics.sn",
        "type-aliases.sn",
        "unions.sn",
        "nullability.sn",
        "null-operators.sn",
        "multi-constraints.sn",
        "dictionaries.sn",
        "type-operators.sn",
        "function-types.sn",
        "default-named-args.sn",
        "lambdas.sn",
      ]) {
        const source = readFileSync(join(examplesDir, name), "utf8");
        const result = compile(source);
        expect(result.success, name).toBe(true);
        expect(result.ir, name).toContain("define i32 @main()");
      }
    });

    it("monomorphizes generic structs and functions", () => {
      const result = compile(`
        struct Box<T> {
          value: T;
        }
        function identity<T>(value: T): T {
          return value;
        }
        function main(): void {
          let a: Box<i32> = Box<i32> { value: 1 };
          print(identity(a.value));
          print(identity("x"));
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%Box__i32 = type");
      expect(result.ir).toContain("define i32 @identity__i32(i32 %");
      expect(result.ir).toContain("define ptr @identity__string(ptr %");
      expect(result.ir).not.toContain("struct Box<");
    });

    it("monomorphizes nested generics and multi-param structs", () => {
      const result = compile(`
        struct Array<T> { data: T[]; }
        struct Pair<K, V> { key: K; value: V; }
        function main(): void {
          let nested: Array<Array<i32>> = Array<Array<i32>> { data: [] };
          let p = Pair<i32, string> { key: 1, value: "a" };
          print(p.key);
          print(p.value);
          print(nested.data.length);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%Array__Array__i32 = type");
      expect(result.ir).toContain("%Pair__i32__string = type");
    });

    it("infers generic class type arguments from constructor args", () => {
      const result = compile(`
        class Box<T> {
          value: T;
          constructor(value: T) {
            this.value = value;
          }
          get(): T {
            return this.value;
          }
        }
        function main(): void {
          let b = new Box("hi");
          print(b.get());
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("Box__string");
    });

    it("monomorphizes generic methods", () => {
      const result = compile(`
        class Cache {
          get<T>(key: string, value: T): T {
            return value;
          }
        }
        function main(): void {
          let c = new Cache();
          print(c.get<string>("k", "v"));
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("get__string");
    });

    it("compiles struct methods with this", () => {
      const result = compile(`
        struct Point {
          x: i32;
          y: i32;
          sum(): i32 {
            return this.x + this.y;
          }
        }
        function main(): void {
          let p = Point { x: 2, y: 3 };
          print(p.sum());
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define i32 @Point__sum(ptr %this)");
    });

    it("compiles classes with new, fields, methods, and statics", () => {
      const result = compile(`
        class Counter {
          value: i32;
          static total: i32;
          constructor(start: i32) {
            this.value = start;
            Counter.total = Counter.total + 1;
          }
          bump(): void {
            this.value = this.value + 1;
          }
          static getTotal(): i32 {
            return Counter.total;
          }
        }
        function main(): void {
          let c = new Counter(10);
          c.bump();
          print(c.value);
          print(Counter.getTotal());
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%ObjectHeader = type { i32, ptr }");
      expect(result.ir).toContain("%Counter = type { %ObjectHeader, i32 }");
      expect(result.ir).toContain("call ptr @sn_alloc");
      expect(result.ir).toContain("@Counter__vtable");
      expect(result.ir).toContain("define void @Counter__constructor");
      expect(result.ir).toContain("define void @Counter__bump");
    });

    it("compiles inheritance with virtual dispatch", () => {
      const result = compile(`
        abstract class Animal {
          abstract speak(): void;
        }
        class Cat extends Animal {
          constructor() { super(); }
          speak(): void { print("meow"); }
        }
        function main(): void {
          let a: Animal = new Cat();
          a.speak();
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("@Cat__vtable");
      expect(result.ir).toContain("define void @Cat__speak");
    });

    it("rejects private field access outside the class", () => {
      const result = compile(`
        class Box {
          private secret: i32;
          constructor() { this.secret = 1; }
        }
        function main(): void {
          let b = new Box();
          print(b.secret);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0359")).toBe(true);
    });

    it("rejects constructing an abstract class", () => {
      const result = compile(`
        abstract class Shape {
          abstract area(): i32;
        }
        function main(): void {
          let s = new Shape();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0362")).toBe(true);
    });

    it("rejects assigning to readonly outside constructor", () => {
      const result = compile(`
        class Item {
          readonly id: i32;
          constructor() { this.id = 1; }
        }
        function main(): void {
          let item = new Item();
          item.id = 2;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0358")).toBe(true);
    });

    it("compiles interfaces with itable dispatch and direct concrete calls", () => {
      const result = compile(`
        interface Drawable {
          draw(): void;
        }
        class Circle implements Drawable {
          constructor() {}
          draw(): void { print("circle"); }
        }
        function render(shape: Drawable): void {
          shape.draw();
        }
        function main(): void {
          let c = new Circle();
          c.draw();
          render(c);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%Drawable = type { ptr, ptr }");
      expect(result.ir).toContain("__itable");
      // Concrete call is direct
      expect(result.ir).toMatch(/call void @Circle__draw\(ptr/);
      // Interface call goes through loaded function pointer
      expect(result.ir).toContain("extractvalue %Drawable");
    });

    it("compiles multiple interfaces and interface extends", () => {
      const result = compile(`
        interface Drawable { draw(): void; }
        interface Named { getName(): string; }
        interface ColorDrawable extends Drawable { getColor(): string; }
        class Player implements Drawable, Named {
          constructor() {}
          draw(): void { print("player"); }
          getName(): string { return "p"; }
        }
        class Square implements ColorDrawable {
          constructor() {}
          draw(): void { print("sq"); }
          getColor(): string { return "red"; }
        }
        function main(): void {
          let p = new Player();
          let d: Drawable = p;
          d.draw();
          let s = new Square();
          let c: ColorDrawable = s;
          let base: Drawable = c;
          base.draw();
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%Drawable = type { ptr, ptr }");
      expect(result.ir).toContain("%ColorDrawable = type { ptr, ptr }");
    });

    it("rejects class missing interface method", () => {
      const result = compile(`
        interface Drawable { draw(): void; }
        class Circle implements Drawable {
          constructor() {}
        }
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0371")).toBe(true);
    });

    it("rejects incompatible interface method signature", () => {
      const result = compile(`
        interface Drawable { draw(): void; }
        class Circle implements Drawable {
          constructor() {}
          draw(): i32 { return 1; }
        }
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0372")).toBe(true);
    });

    it("rejects interface field members at parse time", () => {
      const result = compile(`
        interface Person {
          name: string;
        }
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0370")).toBe(true);
    });

    it("rejects constructing an interface", () => {
      const result = compile(`
        interface Drawable { draw(): void; }
        function main(): void {
          let d = new Drawable();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0376")).toBe(true);
    });

    it("compiles struct declarations, literals, field access, assignment, and params", () => {
      const result = compile(`
        struct Person {
          name: string;
          age: i32;
        }
        function printPerson(person: Person): void {
          print(person.name);
          print(person.age);
        }
        function main(): void {
          let John = Person {
            name: "John",
            age: 16
          };
          printPerson(John);
          John.age = 17;
          print(John.age);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%Person = type { ptr, i32 }");
      expect(result.ir).toContain("getelementptr inbounds %Person");
      expect(result.ir).toContain("define void @printPerson(%Person %arg0)");
      expect(result.ir).toContain("%v.John = alloca %Person");
    });

    it("compiles enum declarations, variant access, comparison, and struct fields", () => {
      const result = compile(`
        enum Direction {
          Up,
          Down,
          Left,
          Right
        }
        enum Status {
          Loading,
          Success,
          Error
        }
        struct Request {
          status: Status;
        }
        function main(): void {
          let direction: Direction = Direction.Up;
          if (direction == Direction.Up) {
            print(direction);
          }
          let request = Request {
            status: Status.Loading
          };
          print(request.status);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%Request = type { i32 }");
      expect(result.ir).toContain("%v.direction = alloca i32");
      expect(result.ir).toContain("store i32 0, ptr %v.direction");
      expect(result.ir).toContain("icmp eq i32");
    });

    it("compiles array literals, indexing, length, mutation, methods, and for-in", () => {
      const result = compile(`
        function main(): void {
          let numbers: i32[] = [1, 2, 3];
          print(numbers[0]);
          numbers[0] = 10;
          print(numbers.length);
          numbers.push(4);
          print(numbers.includes(10));
          print(numbers.indexOf(2));
          let last = numbers.pop();
          print(last);
          for (i in numbers) {
            print(i);
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("declare ptr @sn_array_new");
      expect(result.ir).toContain("declare void @sn_array_push");
      expect(result.ir).toContain("%v.numbers = alloca ptr");
      expect(result.ir).toContain("forin.cond.");
      expect(result.ir).toContain("forin.body.");
      expect(result.ir).toContain("call void @sn_array_push");
    });

    it("allows mutating const array elements and push", () => {
      const result = compile(`
        function main(): void {
          const xs = [1, 2];
          xs[0] = 9;
          xs.push(3);
          print(xs[0]);
        }
      `);
      expect(result.success).toBe(true);
    });

    it("compiles array parameters and returns", () => {
      const result = compile(`
        function first(xs: i32[]): i32 {
          return xs[0];
        }
        function make(): i32[] {
          return [7, 8];
        }
        function main(): void {
          let a = make();
          print(first(a));
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define i32 @first(ptr %arg0)");
      expect(result.ir).toContain("define ptr @make()");
    });
  });

  describe("validation errors", () => {
    it("fails when main is missing", () => {
      const result = compile("");
      expect(result.success).toBe(false);
      expect(result.ir).toBeNull();
      expect(result.diagnostics.some((d) => d.code === "E0200")).toBe(true);
    });

    it("fails when only a non-main function exists", () => {
      const result = compile(`
        function greet(): void {
          print("hi");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0202")).toBe(true);
    });

    it("fails when more than one main exists", () => {
      const result = compile(`
        function main(): void {}
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0201")).toBe(true);
    });

    it("fails when main does not return void", () => {
      const result = compile(`
        function main(): i32 {
          print("hi");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0205")).toBe(true);
    });

    it("fails when main has parameters", () => {
      const result = compile(`
        function main(x: i32): void {
          print(x);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0206")).toBe(true);
    });
  });

  describe("typecheck errors", () => {
    it("fails when a type argument violates a generic constraint", () => {
      const result = compile(`
        interface Comparable {
          compare(other: i32): i32;
        }
        function sort<T extends Comparable>(item: T): void {
          print(item.compare(0));
        }
        function main(): void {
          sort<i32>(1);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0384")).toBe(true);
    });

    it("fails when a generic type is used without type arguments", () => {
      const result = compile(`
        struct Box<T> {
          value: T;
        }
        function main(): void {
          let b: Box = Box<i32> { value: 1 };
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0382")).toBe(true);
    });

    it("fails on unknown function calls", () => {
      const result = compile(`
        function main(): void {
          other("x");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0307")).toBe(true);
    });

    it("fails on const reassignment", () => {
      const result = compile(`
        function main(): void {
          const x = 1;
          x = 2;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0305")).toBe(true);
    });

    it("fails on type annotation mismatch", () => {
      const result = compile(`
        function main(): void {
          let age: i32 = "hello";
        }
      `);
      expect(result.success).toBe(false);
      const mismatch = result.diagnostics.find((d) => d.code === "E0303");
      expect(mismatch).toBeDefined();
      expect(mismatch?.message).toBe("Expected i32, got string");
    });

    it("fails on string annotated as wrong type", () => {
      const result = compile(`
        function main(): void {
          let x: string = 42;
        }
      `);
      expect(result.success).toBe(false);
      const mismatch = result.diagnostics.find((d) => d.code === "E0303");
      expect(mismatch?.message).toBe("Expected string, got i32");
    });

    it("fails on duplicate variable declarations", () => {
      const result = compile(`
        function main(): void {
          let x = 1;
          let x = 2;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0301")).toBe(true);
    });

    it("fails when void is used as a variable type", () => {
      const result = compile(`
        function main(): void {
          let x: void = 1;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0302")).toBe(true);
    });

    it("fails on undefined variables", () => {
      const result = compile(`
        function main(): void {
          print(missing);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0304")).toBe(true);
    });

    it("fails on mismatched arithmetic operands", () => {
      const result = compile(`
        function main(): void {
          print(true + 1);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("allows string + scalar concatenation", () => {
      const result = compile(`
        function main(): void {
          print("n=" + 1);
          print(2 + "!");
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("sn_i32_to_string");
      expect(result.ir).toContain("sn_str_concat");
    });

    it("fails on mixed numeric widths in arithmetic", () => {
      const result = compile(`
        function main(): void {
          let a: i32 = 1;
          let b: i64 = 2;
          print(a + b);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("fails when print has no arguments", () => {
      const result = compile(`
        function main(): void {
          print();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0308")).toBe(true);
    });

    it("fails when print is used as a value", () => {
      const result = compile(`
        function main(): void {
          let x = print("hi");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0309")).toBe(true);
    });

    it("fails when redefining the print builtin", () => {
      const result = compile(`
        function print(): void {}
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0310")).toBe(true);
    });

    it("fails on duplicate function names", () => {
      const result = compile(`
        function helper(): void {}
        function helper(): void {}
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0311")).toBe(true);
    });

    it("fails when a non-void function is missing a final return", () => {
      const result = compile(`
        function add(a: i32, b: i32): i32 {
          let x = a + b;
        }
        function main(): void {
          print(add(1, 2));
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0312")).toBe(true);
    });

    it("fails when a void function returns a value", () => {
      const result = compile(`
        function nope(): void {
          return 1;
        }
        function main(): void {
          nope();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0313")).toBe(true);
    });

    it("fails when a non-void function uses a bare return", () => {
      const result = compile(`
        function value(): i32 {
          return;
        }
        function main(): void {
          print(value());
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0314")).toBe(true);
    });

    it("fails on arity mismatches", () => {
      const result = compile(`
        function add(a: i32, b: i32): i32 {
          return a + b;
        }
        function main(): void {
          print(add(1));
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0315")).toBe(true);
    });

    it("fails when a void function is used as a value", () => {
      const result = compile(`
        function greet(): void {
          print("hi");
        }
        function main(): void {
          let x = greet();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0309")).toBe(true);
    });

    it("fails on argument type mismatches", () => {
      const result = compile(`
        function identity(x: i32): i32 {
          return x;
        }
        function main(): void {
          print(identity("nope"));
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
    });

    it("fails when if condition is not bool", () => {
      const result = compile(`
        function main(): void {
          if (1) {
            print("x");
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0316")).toBe(true);
    });

    it("fails when break is used outside a loop", () => {
      const result = compile(`
        function main(): void {
          break;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0317")).toBe(true);
    });

    it("fails when continue is used outside a loop", () => {
      const result = compile(`
        function main(): void {
          continue;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0317")).toBe(true);
    });

    it("fails on mismatched comparison operands", () => {
      const result = compile(`
        function main(): void {
          print(1 > true);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("fails on non-bool logical operands", () => {
      const result = compile(`
        function main(): void {
          print(1 && true);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("fails on empty array without annotation", () => {
      const result = compile(`
        function main(): void {
          let xs = [];
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0321")).toBe(true);
    });

    it("compiles printing an array value as [elements]", () => {
      const result = compile(`
        function main(): void {
          let xs: i32[] = [1, 2, 3];
          print(xs);
          let empty: i32[] = [];
          print(empty);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("declare ptr @sn_array_to_string");
      expect(result.ir).toContain("call ptr @sn_array_to_string");
    });

    it("infers heterogeneous literals as tuples", () => {
      const result = compile(`
        function main(): void {
          let pair = [1, true];
          print(pair[0]);
          print(pair[1]);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("__tuple_");
    });

    it("rejects tuple arity mismatches", () => {
      const result = compile(`
        function main(): void {
          let pair: [string, i32] = ["hello"];
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0331")).toBe(true);
    });

    it("rejects tuple element type mismatches", () => {
      const result = compile(`
        function main(): void {
          let pair: [string, i32] = [123, "hello"];
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
    });

    it("rejects out-of-bounds constant tuple indexes", () => {
      const result = compile(`
        function main(): void {
          let pair: [string, i32] = ["hello", 123];
          let value = pair[2];
          print(value);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0332")).toBe(true);
    });

    it("rejects negative constant tuple indexes", () => {
      const result = compile(`
        function main(): void {
          let pair: [string, i32] = ["hello", 123];
          let value = pair[-1];
          print(value);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0332")).toBe(true);
    });

    it("types dynamic tuple indexes as unions", () => {
      const result = compile(`
        function getIndex(): i32 {
          return 0;
        }
        function takeString(s: string): void {
          print(s);
        }
        function main(): void {
          let pair: [string, i32] = ["hello", 123];
          let index: i32 = getIndex();
          let value = pair[index];
          if (value is string) {
            takeString(value);
          }
        }
      `);
      expect(result.success).toBe(true);
    });

    it("supports tuple length, mutation, destructuring, and generics", () => {
      const result = compile(`
        type Pair<A, B> = [A, B];

        function makePair<A, B>(first: A, second: B): [A, B] {
          return [first, second];
        }

        function getPerson(): [string, i32] {
          return ["Ethan", 16];
        }

        function printPerson(person: [string, i32]): void {
          print(person[0]);
          print(person[1]);
        }

        function main(): void {
          let pair: [string, i32] = ["hello", 123];
          print(pair.length);
          pair[0] = "world";
          pair[1] = 456;
          print(pair[0]);
          print(pair[1]);

          let typed: Pair<string, i32> = ["Ethan", 16];
          print(typed[0]);

          let inferred = makePair("Ethan", 16);
          print(inferred[1]);

          let [name, age] = getPerson();
          print(name);
          print(age);

          let [first, , third]: [string, string, string] = ["a", "b", "c"];
          print(first);
          print(third);

          printPerson(["Ethan", 16]);
        }
      `);
      expect(result.success).toBe(true);
    });

    it("rejects wrong-type tuple element assignment", () => {
      const result = compile(`
        function main(): void {
          let pair: [string, i32] = ["hello", 123];
          pair[0] = 123;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
    });

    it("rejects dynamic tuple element assignment", () => {
      const result = compile(`
        function getIndex(): i32 {
          return 0;
        }
        function main(): void {
          let pair: [string, i32] = ["hello", 123];
          let index: i32 = getIndex();
          pair[index] = "x";
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0333")).toBe(true);
    });

    it("fails when rebinding a const array", () => {
      const result = compile(`
        function main(): void {
          const xs = [1];
          xs = [2];
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0305")).toBe(true);
    });

    it("fails on for-in over a non-array", () => {
      const result = compile(`
        function main(): void {
          for (i in 1) {
            print(i);
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0318")).toBe(true);
    });

    it("fails on unknown struct type names", () => {
      const result = compile(`
        function main(): void {
          let x: Widget = 1;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0104")).toBe(true);
    });

    it("fails on missing struct literal fields", () => {
      const result = compile(`
        struct Person {
          name: string;
          age: i32;
        }
        function main(): void {
          let p = Person { name: "John" };
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0332")).toBe(true);
    });

    it("fails on unknown struct fields", () => {
      const result = compile(`
        struct Person {
          age: i32;
        }
        function main(): void {
          let p = Person { age: 1 };
          print(p.name);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0324")).toBe(true);
    });

    it("fails when printing a whole struct value", () => {
      const result = compile(`
        struct Person {
          age: i32;
        }
        function main(): void {
          let p = Person { age: 1 };
          print(p);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0333")).toBe(true);
    });

    it("fails when printing a map value", () => {
      const result = compile(`
        function main(): void {
          let m: { [key: string]: string } = createMap();
          print(m);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0333")).toBe(true);
    });

    it("fails when map values are not reference types", () => {
      const result = compile(`
        function main(): void {
          let scores: { [key: string]: i32 } = createMap();
          scores["a"] = 1;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0410")).toBe(true);
    });

    it("fails on unknown enum variants", () => {
      const result = compile(`
        enum Direction {
          Up,
          Down
        }
        function main(): void {
          let d: Direction = Direction.Sideways;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0324")).toBe(true);
    });

    it("fails when mixing enum and i32", () => {
      const result = compile(`
        enum Direction {
          Up,
          Down
        }
        function main(): void {
          let d: Direction = 0;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
    });

    it("fails when enum name clashes with struct", () => {
      const result = compile(`
        struct Direction {
          x: i32;
        }
        enum Direction {
          Up,
          Down
        }
        function main(): void {
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0330")).toBe(true);
    });

    it("rejects imports in compile(source)", () => {
      const result = compile(`
        import "math";
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0400")).toBe(true);
    });
  });
});

describe("modules / compileFile", () => {
  it("compiles examples/generics.sn with module-mangled symbols", () => {
    const result = compileFile(join(examplesDir, "generics.sn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain("Box__i32");
    expect(result.ir).toContain("rank__Num");
    expect(result.ir).toContain("BoxClass__string");
  });

  it("compiles import math and emits mangled calls", () => {
    const result = compileFile(join(modulesDir, "main.sn"));
    expect(result.success).toBe(true);
    const userModules = result.modules.filter(
      (m) => !m.moduleId.startsWith("std_prelude_"),
    );
    expect(userModules).toHaveLength(2);
    expect(result.ir).toContain("define i32 @math__add(i32 %arg0, i32 %arg1)");
    expect(result.ir).toContain("define i32 @math__mul(i32 %arg0, i32 %arg1)");
    expect(result.ir).toContain("call i32 @math__add(i32 5, i32 10)");
    expect(result.ir).toContain("call i32 @math__mul(i32 3, i32 4)");
    expect(result.ir).toContain("define i32 @main()");
  });

  it("compiles aliased nested imports", () => {
    const result = compileFile(join(modulesDir, "alias.sn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain(
      "define i32 @vector__add(i32 %arg0, i32 %arg1)",
    );
    expect(result.ir).toContain("call i32 @vector__add(i32 5, i32 10)");
  });

  it("compiles exported structs and enums via namespaces", () => {
    const result = compileFile(join(modulesDir, "types-main.sn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%types__Point = type { i32, i32 }");
    expect(result.ir).toContain("define %types__Point @types__origin()");
    expect(result.ir).toContain("call %types__Point @types__origin()");
  });

  it("errors when calling a non-exported function", () => {
    const files = new Map<string, string>([
      [
        "/virt/main.sn",
        `import "lib";
function main(): void {
  print(lib.secret());
}
`,
      ],
      [
        "/virt/lib.sn",
        `function secret(): i32 {
  return 1;
}
`,
      ],
    ]);
    const result = compileFile("/virt/main.sn", {
      readFile: (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
    });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0408")).toBe(true);
    expect(
      result.diagnostics.some((d) =>
        d.message.includes('does not export "secret"'),
      ),
    ).toBe(true);
  });

  it("compiles named imports and aliases to mangled calls", () => {
    const result = compileFile(join(modulesDir, "named-main.sn"));
    expect(result.success).toBe(true);
    expect(result.ir).toContain("define i32 @math__add(i32 %arg0, i32 %arg1)");
    expect(result.ir).toContain("define i32 @math__mul(i32 %arg0, i32 %arg1)");
    expect(result.ir).toContain("call i32 @math__add(i32 5, i32 10)");
    expect(result.ir).toContain("call i32 @math__mul(i32 3, i32 4)");
  });

  it("compiles explicit import * as namespace syntax", () => {
    const files = new Map<string, string>([
      [
        "/virt/main.sn",
        `import * as math from "math";
function main(): void {
  print(math.add(1, 2));
}
`,
      ],
      [
        "/virt/math.sn",
        `export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
    ]);
    const result = compileFile("/virt/main.sn", {
      readFile: (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
    });
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call i32 @math__add(i32 1, i32 2)");
  });

  it("errors when a named import is not exported", () => {
    const files = new Map<string, string>([
      [
        "/virt/main.sn",
        `import { helper } from "math";
function main(): void {
  helper();
}
`,
      ],
      [
        "/virt/math.sn",
        `function helper(): void {}
export function add(a: i32, b: i32): i32 {
  return a + b;
}
`,
      ],
    ]);
    const result = compileFile("/virt/main.sn", {
      readFile: (path) => {
        const source = files.get(path);
        if (source === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return source;
      },
    });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0408")).toBe(true);
    expect(
      result.diagnostics.some(
        (d) => d.message === 'Module "math" does not export "helper".',
      ),
    ).toBe(true);
  });
});

describe("type aliases and advanced types", () => {
  it("compiles type aliases and literal unions", () => {
    const result = compile(`
      type UserId = i32;
      type Direction = "north" | "south";
      function main(): void {
        let id: UserId = 21;
        let direction: Direction = "north";
        print(id);
        print(direction);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("define i32 @main()");
  });

  it("rejects invalid literal assignments", () => {
    const result = compile(`
      type Direction = "north" | "south";
      function main(): void {
        let direction: Direction = "up";
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
  });

  it("narrows unions with typeof", () => {
    const result = compile(`
      function getValue(): i32 | string {
        return "hi";
      }
      function main(): void {
        let value: i32 | string = getValue();
        if (typeof value == "string") {
          print(value.length);
        } else {
          print(value + 10);
        }
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%__Union");
  });

  it("supports intersection constraints", () => {
    const result = compile(`
      interface A { a(): void; }
      interface B { b(): void; }
      class C implements A, B {
        a(): void { print("a"); }
        b(): void { print("b"); }
      }
      function test<T extends A & B>(value: T): void {
        value.a();
        value.b();
      }
      function main(): void {
        test(new C());
      }
    `);
    expect(result.success).toBe(true);
  });

  it("supports index signatures as maps", () => {
    const result = compile(`
      interface Dictionary {
        [key: string]: string;
      }
      function main(): void {
        let d: Dictionary = createMap();
        d["hello"] = "world";
        print(d["hello"]);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("sn_map_new");
    expect(result.ir).toContain("sn_map_set");
    expect(result.ir).toContain("sn_map_get");
  });

  it("expands keyof and conditional types", () => {
    const result = compile(`
      type Person = {
        name: string;
        age: i32;
      };
      type Keys = keyof Person;
      type Result<T> = T extends string ? string : i32;
      function main(): void {
        let k: Keys = "name";
        let r: Result<string> = "ok";
        print(k);
        print(r);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("expands indexed access, mapped types, and generic alias projections", () => {
    const result = compile(`
      type Person = {
        name: string;
        age: i32;
      };
      type Name = Person["name"];
      type ReadonlyPerson = {
        readonly [K in keyof Person]: Person[K];
      };
      type ReadonlyName = ReadonlyPerson["name"];
      type Pair<A, B> = {
        first: A;
        second: B;
      };
      type First = Pair<string, i32>["first"];
      function main(): void {
        let name: Name = "Ada";
        let ro: ReadonlyName = "Lovelace";
        let first: First = "hello";
        print(name);
        print(ro);
        print(first);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("expands typeof createPerson() type queries", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      function createPerson(): Point {
        return Point { x: 1, y: 2 };
      }
      type Person = typeof createPerson();
      function main(): void {
        let p: Person = createPerson();
        print(p.x);
      }
    `);
    expect(result.success).toBe(true);
  });
});

describe("nullability and control-flow narrowing", () => {
  it("compiles nullable class types and null assignment", () => {
    const result = compile(`
      class User {
        name: string;
        constructor(name: string) { this.name = name; }
      }
      function main(): void {
        let user: User | null = null;
        user = new User("Ada");
        user = null;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("rejects property access on nullable without narrowing", () => {
    const result = compile(`
      class User {
        name: string;
        constructor(name: string) { this.name = name; }
      }
      function main(): void {
        let user: User | null = null;
        print(user.name);
      }
    `);
    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((d) => d.message.includes("may be null")),
    ).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "E0397")).toBe(true);
  });

  it("narrows with != null inside if", () => {
    const result = compile(`
      class User {
        name: string;
        constructor(name: string) { this.name = name; }
      }
      function main(): void {
        let user: User | null = new User("Ada");
        if (user != null) {
          print(user.name);
        } else {
          print("No user");
        }
      }
    `);
    expect(result.success).toBe(true);
  });

  it("narrows after early return on == null", () => {
    const result = compile(`
      function process(value: string | null): void {
        if (value == null) {
          return;
        }
        print(value.length);
      }
      function main(): void {
        process("hi");
        process(null);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("narrows with is checks", () => {
    const result = compile(`
      function main(): void {
        let value: string | i32 = "hi";
        if (value is string) {
          print(value.length);
        }
        let n: string | null = null;
        if (n is null) {
          print("null");
        }
      }
    `);
    expect(result.success).toBe(true);
  });

  it("narrows multi-arm unions with typeof", () => {
    const result = compile(`
      function main(): void {
        let value: string | i32 | bool = 1;
        if (typeof value == "string") {
          print(value.length);
        } elseif (typeof value == "i32") {
          print(value + 1);
        } else {
          print(value == true);
        }
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%__Union");
  });

  it("narrows after break on null check", () => {
    const result = compile(`
      function main(): void {
        let value: string | null = "hi";
        while (true) {
          if (value == null) {
            break;
          }
          print(value.length);
          break;
        }
      }
    `);
    expect(result.success).toBe(true);
  });

  it("infers nullable return types", () => {
    const result = compile(`
      class User {
        name: string;
        constructor(name: string) { this.name = name; }
      }
      function findUser(id: i32): User | null {
        if (id == 10) {
          return new User("Ada");
        }
        return null;
      }
      function main(): void {
        let user = findUser(10);
        if (user != null) {
          print(user.name);
        }
      }
    `);
    expect(result.success).toBe(true);
  });
});

describe("null operators", () => {
  it("compiles non-null assertion on nullable string", () => {
    const result = compile(`
      function main(): void {
        let name: string | null = "Ada";
        print(name!.length);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("still rejects property access on nullable without narrowing or optional chaining", () => {
    const result = compile(`
      class User {
        name: string;
        constructor(name: string) { this.name = name; }
      }
      function main(): void {
        let user: User | null = null;
        print(user.name);
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0397")).toBe(true);
  });

  it("compiles nullish coalescing with compatible fallback type", () => {
    const result = compile(`
      function getName(): string | null { return null; }
      function main(): void {
        let name: string | null = getName();
        let display: string = name ?? "Unknown";
        print(display);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("rejects nullish coalescing with incompatible fallback type", () => {
    const result = compile(`
      function main(): void {
        let name: string | null = null;
        let x = name ?? 123;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
  });

  it("short-circuits nullish coalescing in generated IR", () => {
    const result = compile(`
      function getDefault(): string { return "Unknown"; }
      function main(): void {
        let name: string | null = "Ada";
        let display = name ?? getDefault();
        print(display);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("coalesce_rhs");
    expect(result.ir).toContain("coalesce_merge");
  });

  it("compiles optional member and method access", () => {
    const result = compile(`
      class User {
        name: string;
        constructor(name: string) { this.name = name; }
        getName(): string { return this.name; }
      }
      function main(): void {
        let user: User | null = new User("Ada");
        let n = user?.name;
        let m = user?.getName();
        print(n ?? "none");
        print(m ?? "none");
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("opt_null");
    expect(result.ir).toContain("opt_merge");
  });

  it("compiles optional array indexing", () => {
    const result = compile(`
      function main(): void {
        let numbers: i32[] | null = [1, 2, 3];
        let first = numbers?[0];
        print(first ?? 0);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("compiles optional chaining combined with nullish coalescing", () => {
    const result = compile(`
      class Address { city: string; constructor(city: string) { this.city = city; } }
      class Profile { address: Address; constructor(address: Address) { this.address = address; } }
      class User {
        profile: Profile | null;
        constructor(profile: Profile | null) { this.profile = profile; }
      }
      function main(): void {
        let user: User | null = new User(new Profile(new Address("NYC")));
        let city: string = user?.profile?.address?.city ?? "Unknown";
        print(city);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("compiles non-null assertion after optional chaining", () => {
    const result = compile(`
      class Address { city: string; constructor(city: string) { this.city = city; } }
      class Profile { address: Address; constructor(address: Address) { this.address = address; } }
      class User {
        profile: Profile | null;
        constructor(profile: Profile | null) { this.profile = profile; }
      }
      function main(): void {
        let user: User | null = new User(new Profile(new Address("NYC")));
        let city = user?.profile!.address?.city ?? "Unknown";
        print(city);
      }
    `);
    expect(result.success).toBe(true);
  });
});

describe("function types", () => {
  it("compiles function type aliases, params, and named function values", () => {
    const result = compile(`
      type Operation = (i32, i32) => i32;
      function add(a: i32, b: i32): i32 {
        return a + b;
      }
      function execute(operation: Operation): i32 {
        return operation(10, 20);
      }
      function main(): void {
        let op: Operation = add;
        print(execute(op));
        print(execute(add));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%__Callable = type { ptr, ptr }");
    expect(result.ir).toContain("add__as_closure");
  });

  it("compiles function-typed returns and indirect calls", () => {
    const result = compile(`
      function double(value: i32): i32 {
        return value * 2;
      }
      function createDoubler(): (i32) => i32 {
        return double;
      }
      function main(): void {
        let doubleIt: (i32) => i32 = createDoubler();
        print(doubleIt(21));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%__Callable = type { ptr, ptr }");
  });

  it("rejects assigning a named function with the wrong return type", () => {
    const result = compile(`
      function greet(a: i32, b: i32): string {
        return "hi";
      }
      function main(): void {
        let op: (i32, i32) => i32 = greet;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
  });

  it("rejects assigning a named function with the wrong arity", () => {
    const result = compile(`
      function identity(a: i32): i32 {
        return a;
      }
      function main(): void {
        let op: (i32, i32) => i32 = identity;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
  });

  it("rejects calling a non-function value", () => {
    const result = compile(`
      function main(): void {
        let x: i32 = 1;
        x(2);
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0307")).toBe(true);
  });

  it("rejects wrong argument arity on a function-typed variable", () => {
    const result = compile(`
      function add(a: i32, b: i32): i32 {
        return a + b;
      }
      function main(): void {
        let op: (i32, i32) => i32 = add;
        print(op(1));
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0315")).toBe(true);
  });
});

describe("lambdas and closures", () => {
  it("compiles expression-bodied lambdas and indirect calls", () => {
    const result = compile(`
      function main(): void {
        let add = (a: i32, b: i32) => a + b;
        print(add(2, 3));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%__Callable = type { ptr, ptr }");
    expect(result.ir).toMatch(/define i32 @lambda_\d+\(ptr %env/);
  });

  it("applies contextual typing for lambda arguments", () => {
    const result = compile(`
      function execute(op: (i32, i32) => i32): i32 {
        return op(10, 20);
      }
      function main(): void {
        print(execute((a, b) => a + b));
      }
    `);
    expect(result.success).toBe(true);
  });

  it("rejects untyped lambda parameters without context", () => {
    const result = compile(`
      function main(): void {
        let add = (a, b) => a + b;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0398")).toBe(true);
  });

  it("rejects return type mismatches on lambdas", () => {
    const result = compile(`
      function main(): void {
        let add = (a: i32, b: i32): i32 => "hello";
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
  });

  it("compiles closures that capture outer parameters", () => {
    const result = compile(`
      function createAdder(x: i32): (i32) => i32 {
        return (y: i32) => x + y;
      }
      function main(): void {
        let addTen = createAdder(10);
        print(addTen(5));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_alloc");
  });

  it("compiles mutable captures with heap boxes", () => {
    const result = compile(`
      function createCounter(): () => i32 {
        let count: i32 = 0;
        return (): i32 => {
          count++;
          return count;
        };
      }
      function main(): void {
        let counter = createCounter();
        print(counter());
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_alloc");
  });

  it("promotes named functions to callable values", () => {
    const result = compile(`
      function add(a: i32, b: i32): i32 {
        return a + b;
      }
      function main(): void {
        let f = add;
        print(f(1, 2));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("add__as_closure");
  });
});

describe("default and named arguments", () => {
  it("compiles omitted and explicit default arguments", () => {
    const result = compile(`
      function greet(name: string, greeting: string = "Hello"): void {
        print(greeting + ", " + name);
      }
      function main(): void {
        greet("Ethan");
        greet("Ethan", "Hi");
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("@greet");
  });

  it("fills multiple trailing defaults", () => {
    const result = compile(`
      function createPerson(name: string, age: i32 = 0, active: bool = true): void {
        print(name);
        print(age);
        print(active);
      }
      function main(): void {
        createPerson("Ethan");
        createPerson("Ethan", 16);
        createPerson("Ethan", 16, false);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("rejects default values with the wrong type", () => {
    const result = compile(`
      function test(x: i32 = "hello"): void {}
      function main(): void {}
    `);
    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((d) =>
        d.message.includes(
          "Default value of type string is not assignable to parameter type i32",
        ),
      ),
    ).toBe(true);
  });

  it("resolves named arguments in any order and skips defaults", () => {
    const result = compile(`
      function configure(host: string, port: i32 = 80, secure: bool = false): void {
        print(host);
        print(port);
        print(secure);
      }
      function main(): void {
        configure(secure: true, host: "example.com");
        configure("example.com", secure: true);
      }
    `);
    expect(result.success).toBe(true);
  });

  it("type-checks named arguments by parameter name", () => {
    const result = compile(`
      function createPerson(name: string, age: i32): void {
        print(name);
        print(age);
      }
      function main(): void {
        createPerson(name: 123, age: "sixteen");
      }
    `);
    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((d) =>
        d.message.includes("Argument 'name' expects string, got i32"),
      ),
    ).toBe(true);
  });

  it("rejects duplicate and unknown named arguments", () => {
    const dup = compile(`
      function createPerson(name: string, age: i32): void {
        print(name);
      }
      function main(): void {
        createPerson("Ethan", name: "Alex");
      }
    `);
    expect(dup.success).toBe(false);
    expect(
      dup.diagnostics.some((d) =>
        d.message.includes("Argument 'name' was provided more than once"),
      ),
    ).toBe(true);

    const unknown = compile(`
      function createPerson(name: string, age: i32): void {
        print(name);
      }
      function main(): void {
        createPerson(username: "Ethan");
      }
    `);
    expect(unknown.success).toBe(false);
    expect(
      unknown.diagnostics.some((d) =>
        d.message.includes(
          "Function 'createPerson' has no parameter named 'username'",
        ),
      ),
    ).toBe(true);
  });

  it("rejects missing required arguments even when later params have defaults", () => {
    const result = compile(`
      function createPerson(name: string, age: i32, active: bool = true): void {
        print(name);
      }
      function main(): void {
        createPerson("Ethan");
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0315")).toBe(true);
  });

  it("allows assigning a function with defaults to a function type without defaults", () => {
    const result = compile(`
      function greet(name: string, greeting: string = "Hello"): void {
        print(greeting + ", " + name);
      }
      function main(): void {
        let fn: (string, string) => void = greet;
        fn("Ethan", "Hi");
      }
    `);
    expect(result.success).toBe(true);
  });

  it("does not apply defaults or named args through function values", () => {
    const arity = compile(`
      function greet(name: string, greeting: string = "Hello"): void {
        print(greeting + ", " + name);
      }
      function main(): void {
        let fn = greet;
        fn("Ethan");
      }
    `);
    expect(arity.success).toBe(false);
    expect(arity.diagnostics.some((d) => d.code === "E0315")).toBe(true);

    const named = compile(`
      function createPerson(name: string, age: i32): void {
        print(name);
      }
      function main(): void {
        let fn = createPerson;
        fn(name: "Ethan", age: 16);
      }
    `);
    expect(named.success).toBe(false);
    expect(
      named.diagnostics.some((d) =>
        d.message.includes(
          "Named arguments require a direct function reference",
        ),
      ),
    ).toBe(true);
  });

  it("evaluates default expressions at the call site only when omitted", () => {
    const result = compile(`
      function getDefault(): i32 {
        return 42;
      }
      function test(x: i32 = getDefault()): void {
        print(x);
      }
      function main(): void {
        test();
        test(10);
      }
    `);
    expect(result.success).toBe(true);
    // Omitted-arg call expands to getDefault() at the call site in main.
    expect(result.ir).toContain("call i32 @getDefault()");
    // Two calls to test: one with the default expansion, one with literal 10.
    const testCalls = result.ir?.match(/call void @test\(/g) ?? [];
    expect(testCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("compiles builtin Error, throw, and try/catch", () => {
    const ok = compile(`
      function divide(a: i32, b: i32): i32 {
        if (b == 0) {
          throw new Error("Cannot divide by zero");
        }
        return a / b;
      }
      function main(): void {
        try {
          print(divide(10, 0));
        } catch (error) {
          print(error.message);
        }
      }
    `);
    expect(ok.success).toBe(true);
    expect(ok.ir).toContain("%ObjectHeader = type { i32, ptr }");
    expect(ok.ir).toContain("%Error = type { %ObjectHeader, ptr }");
    expect(ok.ir).toContain("declare void @sn_throw");
    expect(ok.ir).toContain("declare i32 @setjmp");
    expect(ok.ir).toContain("call void @sn_throw");

    const badString = compile(`
      function main(): void {
        throw "oops";
      }
    `);
    expect(badString.success).toBe(false);
    expect(badString.diagnostics.some((d) => d.code === "E0380")).toBe(true);

    const redefine = compile(`
      class Error {
        message: string;
      }
      function main(): void {}
    `);
    expect(redefine.success).toBe(false);
    expect(redefine.diagnostics.some((d) => d.code === "E0382")).toBe(true);
  });

  it("allows throwing subclasses of Error", () => {
    const result = compile(`
      class FileError extends Error {
        path: string;
        constructor(message: string) {
          super(message);
        }
      }
      function main(): void {
        throw new FileError("missing");
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call void @sn_throw");
  });
});

describe("encodeLlvmString", () => {
  it("escapes non-printable bytes", () => {
    expect(encodeLlvmString("a\nb")).toBe("a\\0Ab");
    expect(encodeLlvmString('say "hi"')).toBe("say \\22hi\\22");
  });
});
