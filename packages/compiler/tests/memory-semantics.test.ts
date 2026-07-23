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
    expect(result.ir).toContain("%ObjectHeader = type { i32, ptr }");
    expect(result.ir).toContain("%Person = type { %ObjectHeader, ptr }");
    expect(result.ir).toContain("%v.a = alloca ptr");
    expect(result.ir).toContain("%v.b = alloca ptr");
    expect(result.ir).toMatch(/load ptr, ptr %v\.a/);
    expect(result.ir).toMatch(/store ptr .*, ptr %v\.b/);
    expect(result.ir).toContain("call ptr @sn_alloc");
    expect(result.ir).toMatch(/store i32 \d+, ptr %/);
    expect(result.ir).toContain("store ptr @Person__vtable");
    expect(result.ir).toContain("call void @sn_init_typeinfo()");
    expect(result.ir).toContain("@Person__typeinfo");
    expect(result.ir).toContain("sn_typeinfo_register");
    // ObjectHeader.type_id stores a class id (>= SN_TYPEID_CLASS_BASE = 256).
    const typeIdStore = result.ir!.match(/store i32 (2\d{2,}), ptr %/);
    expect(typeIdStore).not.toBeNull();
    expect(Number(typeIdStore![1])).toBeGreaterThanOrEqual(256);
  });

  it("emits TypeInfo with PTR for string fields and VALUE for i32", () => {
    const result = compile(`
      class Person {
        name: string;
        age: i32;
        constructor(name: string, age: i32) {
          this.name = name;
          this.age = age;
        }
      }
      function main(): void {
        let p = new Person("A", 20);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain(
      "%SnTypeInfo = type { i32, i32, i32, i32, ptr, i32, i32, i32, i32, i32, i32, i32 }",
    );
    expect(result.ir).toContain("@Person__typeinfo_fields");
    // string → PTR (ref_class 1), related type_id 1 (SN_TYPEID_STRING)
    expect(result.ir).toMatch(/i32 1, i32 1\s*\}/);
    // i32 → VALUE (ref_class 0)
    expect(result.ir).toMatch(/i32 0, i32 0\s*\}/);
  });

  it("lays out class instances with ObjectHeader before fields", () => {
    const result = compile(`
      class Person {
        name: string;
        age: i32;
        constructor(name: string, age: i32) {
          this.name = name;
          this.age = age;
        }
      }
      function main(): void {
        let p = new Person("A", 20);
        p.age = 21;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%ObjectHeader = type { i32, ptr }");
    expect(result.ir).toContain("%Person = type { %ObjectHeader, ptr, i32 }");
    expect(result.ir).toContain("getelementptr inbounds %Person, ptr");
    expect(result.ir).toMatch(/i32 0, i32 0, i32 0/); // type_id
    expect(result.ir).toMatch(/i32 0, i32 0, i32 1/); // vtable
    expect(result.ir).toMatch(/i32 0, i32 2/); // age field
  });

  it("flattens superclass fields after ObjectHeader", () => {
    const result = compile(`
      class Animal {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      class Dog extends Animal {
        breed: string;
        constructor(name: string, breed: string) {
          super(name);
          this.breed = breed;
        }
      }
      function main(): void {
        let d = new Dog("Rex", "lab");
        print(d.name);
        print(d.breed);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Dog = type { %ObjectHeader, ptr, ptr }");
  });

  it("emits sn_is_instance for subclass is-checks and parent_type_id", () => {
    const result = compile(`
      class Animal {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      class Dog extends Animal {
        constructor(name: string) {
          super(name);
        }
      }
      function main(): void {
        let d: Animal = new Dog("Rex");
        if (d is Animal) {
          print("yes");
        }
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call i1 @sn_is_instance");
    expect(result.ir).toContain(
      "%SnTypeInfo = type { i32, i32, i32, i32, ptr, i32, i32, i32, i32, i32, i32, i32 }",
    );
    // Animal has no parent (trailing i32 0); Dog's parent_type_id is Animal's non-zero type_id.
    expect(result.ir).toMatch(/@Animal__typeinfo = .* i32 0 \}/);
    expect(result.ir).toMatch(
      /@Dog__typeinfo = .* i32 (2\d{2}|[3-9]\d{2}|[1-9]\d{3,}) \}/,
    );
  });

  it("registers static reference fields as global GC roots", () => {
    const result = compile(`
      class Holder {
        static item: string;
        constructor() {}
      }
      function main(): void {
        Holder.item = "hi";
        print(Holder.item);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call void @sn_gc_add_global_root");
  });

  it("compares strings by content via strcmp", () => {
    const result = compile(`
      function main(): void {
        let a = "hel" + "lo";
        let b = "hello";
        print(a == b);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call i32 @strcmp");
    expect(result.ir).not.toMatch(/icmp eq ptr %.*a.*, %.*b/);
  });

  it("coerces scalars with sn_*_to_string for string +", () => {
    const result = compile(`
      function main(): void {
        print("n=" + 42);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_i32_to_string");
    expect(result.ir).toContain("call ptr @sn_str_concat");
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
    expect(result.ir).toContain("declare ptr @sn_array_new");
    expect(result.ir).toContain("call void @sn_array_push");
    expect(result.ir).toContain("%v.a = alloca ptr");
    expect(result.ir).toContain("%v.b = alloca ptr");
    expect(result.ir).toMatch(/load ptr, ptr %v\.a/);
    expect(result.ir).toMatch(/store ptr .*, ptr %v\.b/);
  });

  it("treats maps as references (shared identity on assign)", () => {
    const result = compile(`
      interface Dictionary {
        [key: string]: string;
      }
      function main(): void {
        let a: Dictionary = createMap();
        let b = a;
        b["name"] = "Ethan";
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("sn_map_new");
    expect(result.ir).toContain("sn_map_set");
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

  it("mutates arrays through reference parameters", () => {
    const result = compile(`
      function addItem(items: i32[]): void {
        items.push(10);
      }
      function main(): void {
        let a: i32[] = [1, 2];
        addItem(a);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("define void @addItem(ptr %arg0)");
    expect(result.ir).toContain("call void @sn_array_push");
  });

  it("returns arrays, strings, and maps by reference", () => {
    const result = compile(`
      interface Dictionary {
        [key: string]: string;
      }
      function makeArr(): i32[] {
        return [1, 2];
      }
      function makeStr(): string {
        return "hello";
      }
      function makeMap(): Dictionary {
        return createMap();
      }
      function main(): void {
        let a = makeArr();
        let s = makeStr();
        let m = makeMap();
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("define ptr @makeArr()");
    expect(result.ir).toContain("define ptr @makeStr()");
    expect(result.ir).toContain("define ptr @makeMap()");
    expect(result.ir).toMatch(/ret ptr /);
  });

  it("shallow-copies structs that contain string references", () => {
    const result = compile(`
      struct PersonData {
        name: string;
      }
      function main(): void {
        let a = PersonData { name: "Ethan" };
        let b = a;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%PersonData = type { ptr }");
    expect(result.ir).toContain("%v.a = alloca %PersonData");
    expect(result.ir).toContain("%v.b = alloca %PersonData");
    expect(result.ir).toMatch(/load %PersonData, ptr %v\.a/);
    expect(result.ir).toMatch(/store %PersonData .*, ptr %v\.b/);
  });

  it("lays out nested structs inline with declaration-order fields", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      struct Rectangle {
        topLeft: Point;
        bottomRight: Point;
      }
      function main(): void {
        let r = Rectangle {
          topLeft: Point { x: 0, y: 0 },
          bottomRight: Point { x: 10, y: 20 }
        };
        print(r.topLeft.x);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Point = type { i32, i32 }");
    expect(result.ir).toContain("%Rectangle = type { %Point, %Point }");
    expect(result.ir).toContain("getelementptr inbounds %Rectangle");
    expect(result.ir).toContain("getelementptr inbounds %Point");
  });

  it("preserves struct field declaration order in LLVM types", () => {
    const result = compile(`
      struct Example {
        a: i32;
        b: f64;
        c: bool;
      }
      function main(): void {
        let e = Example { a: 1, b: 2.0, c: true };
        print(e.a);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Example = type { i32, double, i1 }");
  });

  it("mutates struct fields via GEP + store", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      function main(): void {
        let p = Point { x: 10, y: 20 };
        p.x = 50;
        print(p.x);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Point = type { i32, i32 }");
    expect(result.ir).toContain("getelementptr inbounds %Point");
    expect(result.ir).toMatch(/store i32 50, ptr /);
  });

  it("stores structs inline as array elements with LLVM sizeof", () => {
    const result = compile(`
      struct Point {
        x: i32;
        y: i32;
      }
      function main(): void {
        let points: Point[] = [Point { x: 1, y: 2 }, Point { x: 3, y: 4 }];
        print(points[0].x);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%Point = type { i32, i32 }");
    expect(result.ir).toContain(
      "ptrtoint (ptr getelementptr (%Point, ptr null, i32 1) to i64)",
    );
    expect(result.ir).toContain("getelementptr inbounds %Point, ptr");
    expect(result.ir).toMatch(/store %Point .*, ptr /);
  });

  it("lays out structs that mix reference and value fields", () => {
    const result = compile(`
      struct PersonData {
        name: string;
        age: i32;
      }
      function main(): void {
        let a = PersonData { name: "Ethan", age: 16 };
        let b = a;
        print(b.name);
        print(b.age);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%PersonData = type { ptr, i32 }");
    expect(result.ir).toMatch(/load %PersonData, ptr %v\.a/);
    expect(result.ir).toMatch(/store %PersonData .*, ptr %v\.b/);
  });

  it("copies function handles on assignment (shared identity)", () => {
    const result = compile(`
      function add(a: i32, b: i32): i32 {
        return a + b;
      }
      function main(): void {
        let a: (i32, i32) => i32 = add;
        let b = a;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%__Callable = type { ptr, ptr }");
    expect(result.ir).toContain("%v.a = alloca %__Callable");
    expect(result.ir).toContain("%v.b = alloca %__Callable");
    expect(result.ir).toMatch(/load %__Callable, ptr %v\.a/);
    expect(result.ir).toMatch(/store %__Callable .*, ptr %v\.b/);
  });
});

describe("heap allocation contract (sn_alloc)", () => {
  it("allocates class instances via sn_alloc(sizeof) and initializes ObjectHeader", () => {
    const result = compile(`
      class Person {
        name: string;
        age: i32;
        constructor(name: string, age: i32) {
          this.name = name;
          this.age = age;
        }
      }
      function main(): void {
        let p = new Person("A", 20);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain(
      "call ptr @sn_alloc(i64 noundef ptrtoint (ptr getelementptr (%Person, ptr null, i32 1) to i64))",
    );
    expect(result.ir).toMatch(/store i32 \d+, ptr %/);
    expect(result.ir).toContain("store ptr @Person__vtable");
    expect(result.ir).not.toContain("@malloc");
    expect(result.ir).not.toContain("@free");
  });

  it("creates arrays via sn_array_new (not direct malloc)", () => {
    const result = compile(`
      function main(): void {
        let a: i32[] = [1, 2];
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_array_new");
    expect(result.ir).not.toMatch(/call ptr @sn_alloc/);
    expect(result.ir).not.toContain("@malloc");
  });

  it("creates maps via sn_map_new", () => {
    const result = compile(`
      interface Dictionary {
        [key: string]: string;
      }
      function main(): void {
        let m: Dictionary = createMap();
        m["name"] = "Ethan";
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_map_new");
    expect(result.ir).toContain("sn_map_set");
    expect(result.ir).not.toContain("@malloc");
  });

  it("concatenates strings via sn_str_concat", () => {
    const result = compile(`
      function main(): void {
        let a: string = "hello";
        let b: string = " world";
        let s = a + b;
        print(s);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_str_concat");
    expect(result.ir).not.toContain("@malloc");
  });

  it("allocates closure environments via sn_alloc(sizeof(env))", () => {
    const result = compile(`
      function main(): void {
        let x: i32 = 10;
        let f = () => x;
        print(f());
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toMatch(
      /call ptr @sn_alloc\(i64 noundef ptrtoint \(ptr getelementptr \(%__env_[^,]+, ptr null, i32 1\) to i64\)\)/,
    );
    expect(result.ir).not.toContain("@malloc");
  });
});

describe("GC root registration and type hooks", () => {
  it("registers and unregisters shadow-stack roots for reference locals", () => {
    const result = compile(`
      class Box {
        value: i32;
        constructor(value: i32) {
          this.value = value;
        }
      }
      function main(): void {
        let a = new Box(1);
        let b = a;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call void @sn_gc_root_push");
    expect(result.ir).toContain("call void @sn_gc_root_restore");
    expect(result.ir).toContain("call i32 @sn_gc_root_checkpoint");
  });

  it("emits sn_gc_set_type after class allocation", () => {
    const result = compile(`
      class Person {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      function main(): void {
        let p = new Person("A");
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call void @sn_gc_set_type");
    expect(result.ir).not.toContain("@malloc");
    expect(result.ir).not.toContain("@free");
  });

  it("emits sn_gc_set_array_meta for array literals", () => {
    const result = compile(`
      function main(): void {
        let a: i32[] = [1, 2];
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call void @sn_gc_set_array_meta");
  });

  it("emits AGG TypeInfo for nested ref-struct class fields", () => {
    const result = compile(`
      struct Profile {
        name: string;
        age: i32;
      }
      class User {
        profile: Profile;
        constructor(profile: Profile) {
          this.profile = profile;
        }
      }
      function main(): void {
        let u = new User(Profile { name: "A", age: 1 });
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("@__agg_Profile__typeinfo");
    // AGG ref_class = 2 pointing at nested Profile TypeInfo
    expect(result.ir).toMatch(/i32 2, i32 \d+\s*\}/);
    expect(result.ir).toContain(
      "sn_typeinfo_register(ptr noundef @__agg_Profile__typeinfo)",
    );
  });

  it("emits env TypeInfo and sn_gc_set_type for closure environments", () => {
    const result = compile(`
      class Box {
        value: i32;
        constructor(value: i32) {
          this.value = value;
        }
      }
      function main(): void {
        let b = new Box(1);
        let f = () => b.value;
        print(f());
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toMatch(/@__env_.*__typeinfo/);
    expect(result.ir).toMatch(
      /call void @sn_gc_set_type\(ptr noundef %.*, i32 noundef \d+\)/,
    );
  });

  it("types mutable capture boxes that hold references", () => {
    const result = compile(`
      class Box {
        value: i32;
        constructor(value: i32) {
          this.value = value;
        }
      }
      function main(): void {
        let b = new Box(1);
        let f = (): i32 => {
          b = new Box(2);
          return b.value;
        };
        print(f());
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("@__box_ptr_");
    // Box type_id must be non-zero (≥ CLASS_BASE)
    expect(result.ir).toMatch(
      /call void @sn_gc_set_type\(ptr noundef %.*, i32 noundef (2\d{2}|[3-9]\d{2}|\d{4,})\)/,
    );
  });

  it("emits sn_gc_set_map_meta after createMap", () => {
    const result = compile(`
      interface Dictionary {
        [key: string]: string;
      }
      function main(): void {
        let m: Dictionary = createMap();
        m["name"] = "Ethan";
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call void @sn_gc_set_map_meta");
  });

  it("emits AGG array meta for struct elements with references", () => {
    const result = compile(`
      struct PersonData {
        name: string;
      }
      function main(): void {
        let a: PersonData[] = [PersonData { name: "A" }];
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("@__agg_PersonData__typeinfo");
    // elem_ref_class AGG = 2
    expect(result.ir).toMatch(
      /call void @sn_gc_set_array_meta\(ptr noundef %.*, i32 noundef 2,/,
    );
  });

  it("roots function parameters that are references", () => {
    const result = compile(`
      class Item {
        id: i32;
        constructor(id: i32) {
          this.id = id;
        }
      }
      function use(item: Item): void {
        print(item.id);
      }
      function main(): void {
        use(new Item(1));
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toMatch(/define void @use\(ptr %arg0\)/);
    expect(result.ir).toContain("call void @sn_gc_root_push");
  });

  it("pre-roots catch parameter before setjmp and clears pending exception", () => {
    const result = compile(`
      function main(): void {
        try {
          throw new Error("boom");
        } catch (error) {
          print(error.message);
        }
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("declare void @sn_eh_clear_exception()");
    const mainFn = result.ir!.slice(result.ir!.indexOf("define i32 @main"));
    const catchAlloca = mainFn.indexOf("%v.error = alloca ptr");
    const setjmpCall = mainFn.indexOf("call i32 @setjmp");
    const clearCall = mainFn.indexOf("call void @sn_eh_clear_exception()");
    const catchLabel = mainFn.indexOf("try.catch.");
    expect(catchAlloca).toBeGreaterThanOrEqual(0);
    expect(setjmpCall).toBeGreaterThan(catchAlloca);
    expect(catchLabel).toBeGreaterThan(setjmpCall);
    expect(clearCall).toBeGreaterThan(catchLabel);
    /* Catch entry pops EH frame before the body so rethrow propagates outward. */
    const afterCatch = mainFn.slice(catchLabel);
    expect(afterCatch.indexOf("call void @sn_eh_pop")).toBeGreaterThanOrEqual(
      0,
    );
    expect(afterCatch.indexOf("call void @sn_eh_pop")).toBeLessThan(
      afterCatch.indexOf("call void @sn_eh_clear_exception()"),
    );
  });

  it("restores entry root checkpoint on return after try/catch", () => {
    const result = compile(`
      class Box {
        value: i32;
        constructor(value: i32) {
          this.value = value;
        }
      }
      function main(): void {
        try {
          let b = new Box(1);
          print(b.value);
        } catch (error) {
          print(error.message);
        }
      }
    `);
    expect(result.success).toBe(true);
    const mainFn = result.ir!.slice(result.ir!.indexOf("define i32 @main"));
    expect(mainFn).toContain("call i32 @sn_gc_root_checkpoint()");
    expect(mainFn).toContain("call void @sn_gc_root_restore");
    expect(mainFn).toContain("%v.error = alloca ptr");
    expect(mainFn.indexOf("%v.error = alloca ptr")).toBeLessThan(
      mainFn.indexOf("call i32 @setjmp"),
    );
  });

  it("allocates throwable subclasses with GC type hooks", () => {
    const result = compile(`
      class Person {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      class MyError extends Error {
        person: Person;
        constructor(message: string, person: Person) {
          super(message);
          this.person = person;
        }
      }
      function main(): void {
        try {
          throw new MyError("x", new Person("A"));
        } catch (error) {
          print(error.message);
        }
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("call ptr @sn_alloc");
    expect(result.ir).toContain("call void @sn_gc_set_type");
    expect(result.ir).toContain("call void @sn_throw");
  });
});
