import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";

describe("value vs reference memory semantics", () => {
  it("copies structs on assignment (value)", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      function main(): void {
        let a = Point { x: 10, y: 20 };
        let b = a;
        b.x = 100;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Point = type { i32, i32 }");
    expect(result.ir).toContain("%v.a = alloca %Point");
    expect(result.ir).toContain("%v.b = alloca %Point");
    expect(result.ir).toMatch(/load %Point, ptr %v\.a/);
    expect(result.ir).toMatch(/store %Point .*, ptr %v\.b/);
  });

  it("aliases classes on assignment (reference)", () => {
    const result = compile(`
      class Person {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      function main(): void {
        let a = new Person("A");
        let b = a;
        b.name = "Ethan";
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%v.a = alloca ptr");
    expect(result.ir).toContain("%v.b = alloca ptr");
    expect(result.ir).toMatch(/load ptr, ptr %v\.a/);
    expect(result.ir).toMatch(/store ptr .*, ptr %v\.b/);
    expect(result.ir).toContain("call ptr @tsn_alloc");
  });

  it("passes struct params by value and class params by reference", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      class Person {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      function modifyPoint(p: Point): void {
        p.x = 10;
      }
      function modifyPerson(p: Person): void {
        p.name = "Ethan";
      }
      function main(): void {
        modifyPoint(Point { x: 1, y: 2 });
        modifyPerson(new Person("A"));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("define void @modifyPoint(%Point %arg0)");
    expect(result.ir).toContain("define void @modifyPerson(ptr %arg0)");
  });

  it("returns structs by value and classes by reference", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      class Person {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      function createPoint(): Point {
        return Point { x: 1, y: 2 };
      }
      function createPerson(): Person {
        return new Person("A");
      }
      function main(): void {
        let p = createPoint();
        let person = createPerson();
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("define %Point @createPoint()");
    expect(result.ir).toMatch(/ret %Point /);
    expect(result.ir).toContain("define ptr @createPerson()");
    expect(result.ir).toMatch(/ret ptr /);
  });

  it("lays out mixed value and reference fields in structs", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      class Person {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      struct Data {
        position: Point;
        owner: Person;
        name: string;
      }
      function main(): void {
        let owner = new Person("A");
        let a = Data {
          position: Point { x: 1, y: 2 },
          owner: owner,
          name: "n"
        };
        let b = a;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Point = type { i32, i32 }");
    expect(result.ir).toContain("%Data = type { %Point, ptr, ptr }");
    expect(result.ir).toContain("%v.a = alloca %Data");
    expect(result.ir).toContain("%v.b = alloca %Data");
    expect(result.ir).toMatch(/load %Data, ptr %v\.a/);
    expect(result.ir).toMatch(/store %Data .*, ptr %v\.b/);
  });

  it("treats arrays as references (shared identity on assign)", () => {
    const result = compile(`
      function main(): void {
        let a: i32[] = [1, 2];
        let b = a;
        b.push(3);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("declare ptr @tsn_array_new");
    expect(result.ir).toContain("call void @tsn_array_push");
    expect(result.ir).toContain("%v.a = alloca ptr");
    expect(result.ir).toContain("%v.b = alloca ptr");
    expect(result.ir).toMatch(/load ptr, ptr %v\.a/);
    expect(result.ir).toMatch(/store ptr .*, ptr %v\.b/);
  });

  it("treats maps as references (shared identity on assign)", () => {
    const result = compile(`
      interface Dictionary {
        [key: string]: i32;
      }
      function main(): void {
        let a: Dictionary = createMap();
        let b = a;
        b["name"] = 1;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("tsn_map_new");
    expect(result.ir).toContain("tsn_map_set");
    expect(result.ir).toContain("%v.a = alloca ptr");
    expect(result.ir).toContain("%v.b = alloca ptr");
    expect(result.ir).toMatch(/load ptr, ptr %v\.a/);
    expect(result.ir).toMatch(/store ptr .*, ptr %v\.b/);
  });

  it("treats strings as references (ptr locals)", () => {
    const result = compile(`
      function main(): void {
        let a: string = "hello";
        let b = a;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%v.a = alloca ptr");
    expect(result.ir).toContain("%v.b = alloca ptr");
    expect(result.ir).toMatch(/load ptr, ptr %v\.a/);
    expect(result.ir).toMatch(/store ptr .*, ptr %v\.b/);
  });
});
