# TSN Memory Model

TSN aims to be **easy to use**, **TypeScript-like**, and a **compiled native language**. Developers should **not normally think about the stack or heap** — the compiler and runtime handle that automatically.

## Core idea

```text
Value types
    → Stored directly
    → Copied when assigned/passed

Reference types
    → Objects live on the heap
    → Variables hold references to them
    → Automatically managed by the runtime
```

---

## 1. Primitive types → value types

These are values:

```ts
i32
i64
f32
f64
bool
char
```

Example:

```ts
let a: i32 = 10;
let b: i32 = a;

b = 20;
```

Memory conceptually:

```text
a → 10
b → 20
```

Changing `b` does not affect `a`.

Function arguments work the same way — parameters receive a copy:

```ts
function double(x: i32): i32 {
    return x * 2;
}
```

---

## 2. Structs → value types

Structs are **value types**.

```ts
struct Point {
    x: i32;
    y: i32;
}

let a = Point(10, 20);
let b = a;

b.x = 100;
```

Conceptually:

```text
a
┌───────────┐
│ x = 10    │
│ y = 20    │
└───────────┘

b
┌───────────┐
│ x = 100   │
│ y = 20    │
└───────────┘
```

`b` is a copy. Structs are excellent for small data (e.g. `Vector2`) without manual allocate/free.

### Structs can contain references

```ts
struct Person {
    name: string;
}
```

The struct itself is a value, but `name` is a reference to a string object. Copying:

```ts
let a = Person("Ethan");
let b = a;
```

copies the struct's fields, including the reference. The string itself is **not** copied (**shallow copy**):

```text
a ─────┐
       ├──→ "Ethan"
b ─────┘
```

---

## 3. Classes → reference types

Classes are reference types.

```ts
class Person {
    name: string;
}

let a = new Person();
let b = a;

b.name = "Ethan";
```

```text
a ─────┐
       │
       ▼
   Person object
       │
       └── name → "Ethan"
       ▲
       │
b ─────┘
```

`a` and `b` refer to the same object. Mutating through `b` is visible through `a` — the same general behaviour as TypeScript/JavaScript objects.

### Class/object physical layout

Class variables hold a **reference** (`Person*`). The object itself lives on the heap:

```text
Stack / local                 Heap
person (Person*) ───────────→ ┌─────────────────────┐
                              │ ObjectHeader        │
                              │  ├── type_id : i32  │
                              │  └── vtable  : ptr  │
                              ├─────────────────────┤
                              │ name : String*      │
                              ├─────────────────────┤
                              │ age  : i32          │
                              └─────────────────────┘
```

LLVM shape (illustrative):

```text
%ObjectHeader = type { i32, ptr }          ; type_id, vtable
%Person       = type { %ObjectHeader, ptr, i32 }
```

Rules:

- **Struct** locals store the aggregate by value; **class** locals store a pointer.
- Assigning `let b = a` copies only the reference, not the object.
- Methods are **not** stored in the object. Instance methods live in a per-class vtable; the object header holds a pointer to that table. A call is conceptually `greet(person)`.
- **Inheritance** flattens superclass fields after the header, then subclass fields (so a `Dog*` can be treated as an `Animal*` for field offsets).
- Class fields that are reference types (string, class, array, …) are pointers. Struct fields are stored **inline** in the object.
- `new Person()` allocates with `tsn_alloc(sizeof(Person))`, initializes the object header (`type_id` + vtable), then runs the constructor.
- `type_id` indexes runtime `TypeInfo` (see [§17](#17-runtime-typeinfo--object-layouts)). Class IDs start at **256**; IDs **1–5** are reserved for builtins.

### Common heap object header

Every heap-backed value is eventually identified by a `type_id`. Today only **class instances** embed that id in-object:

```text
ObjectHeader (classes today)
├── type_id : i32   → TypeInfo
└── vtable  : ptr
```

Arrays, maps, strings, and closure environments use the layouts below **without** an embedded `type_id` yet. Their kinds are described by reserved builtin `TypeInfo` entries. A future ABI bump may prefix those objects with `type_id` so a single scanner can identify any heap pointer.

---

## 4. Arrays → reference types

Arrays are reference types and live on the heap.

```ts
let a = [1, 2, 3];
let b = a;

b.push(4);
```

```text
a ─────┐
       │
       ▼
    [1,2,3,4]
       ▲
       │
b ─────┘
```

`a` sees the change. This matches TypeScript.

### Array physical layout

Canonical header (24 bytes — `TSN_ARRAY_HEADER_SIZE`):

```text
TsnArray                         separate data buffer
┌──────────────────────┐         ┌─────────────────────┐
│ length   : i64       │         │ elem[0] … elem[n)   │
│ capacity : i64       │───────→ │ size = sizeof(T)    │
│ data     : ptr       │         └─────────────────────┘
└──────────────────────┘
```

Element storage depends on `T`:

| Element type | Storage |
| --- | --- |
| `i32`, `Point` (value) | Inline values in the data buffer |
| `Person`, `string` (reference) | Pointers in the data buffer |

```text
Person[]                         Point[]
┌ header ┐                       ┌ header ┐
│ data ──┼→ Person*              │ data ──┼→ Point { x, y }
│        │  Person*              │        │  Point { x, y }
└────────┘                       └────────┘
```

Runtime APIs (`tsn_array_new`, `tsn_array_push`, `tsn_array_pop`, `tsn_array_index_of`) operate on this header. Per-instantiation `TypeInfo` records whether elements are `VALUE`, `PTR`, or `AGG` (inline aggregate that itself contains references) so a future GC can scan the data buffer correctly.

---

## 5. Strings → reference types

Strings are heap-backed reference types and are **immutable**.

```ts
let a = "hello";
let b = a;
```

```text
a ─────┐
       ▼
   "hello"
       ▲
       │
b ─────┘
```

You cannot modify characters in place. Operations such as `toUpper()` or `concat()` produce a new string. The runtime APIs (`tsn_str_len`, `tsn_str_concat`, etc.) fit this model.

### String physical layout (current ABI)

```text
string ref (ptr) ──→  [ bytes …, '\0' ]
```

- Reference type, immutable, heap-allocated (literals may live in read-only data).
- `tsn_str_concat` allocates a **new** buffer; it never mutates its inputs.
- Length is computed with `tsn_str_len` / `strlen` (no length prefix yet).

**Target layout** (future ABI bump, not implemented):

```text
String object
├── type_id : i32
├── length  : i64
└── data    → characters (optionally still NUL-terminated for C interop)
```

---

## 6. Maps → reference types

Maps are reference types.

```ts
let a = Map();
let b = a;

b.set("name", "Ethan");
```

Both `a` and `b` refer to the same map:

```text
a ─────┐
       ▼
      Map
       ▲
       │
b ─────┘
```

### Map physical layout

Canonical header (32 bytes — `TSN_MAP_HEADER_SIZE`):

```text
TsnMap
┌──────────────────────┐
│ len  : i64           │
│ cap  : i64           │
│ keys : char**        │──→ parallel array of string key pointers
│ vals : void**        │──→ parallel array of value pointers
└──────────────────────┘
```

Behavior (existing runtime):

- `tsn_map_new` — empty map with initial capacity 8
- `tsn_map_set` — insert or **overwrite** value for an existing key (linear `strcmp` search); grows by doubling when full
- `tsn_map_get` — lookup; returns `null` if missing

Today keys are strings and values are pointer-sized. `TypeInfo` records key/value reference classification so a future GC can scan entries (e.g. `Map<string, Person>` → key `PTR`, value `PTR`; value-typed payloads would be classified accordingly once boxed or inlined).

---

## 7. Closures → reference types

Closures need an environment for captured variables. That environment must outlive the function that created it, so environments are heap-allocated and automatically managed.

```ts
function createCounter() {
    let count = 0;

    return () => {
        count++;
        return count;
    };
}
```

### Closure physical layout

```text
%__Callable (handle, copied by value)     Environment (heap)
┌─────────────────────┐                   ┌──────────────────┐
│ code : ptr          │                   │ capture₀         │
│ env  : ptr          │──────────────────→│ capture₁         │
└─────────────────────┘                   │ …                │
                                          └──────────────────┘
```

- The **handle** `{ code, env }` is a language-level reference payload (shallow-copied on assign/pass). It is not itself a heap object with an object header.
- The **environment** (and any mutable capture boxes) live on the heap via `tsn_alloc`.
- Captures follow the same value/reference rules as fields: primitives/structs stored by value (or via a mutable box); reference captures stored as pointers.

```text
() => person.name

Closure handle
└── env ──→ Environment
              └── person : Person* ──→ Person object
```

The environment must remain reachable as long as the closure handle is reachable — critical for GC.

---

## 8. Enums

Simple enums are **value types**, represented internally as an integer/tag (hidden from the developer):

```ts
enum Direction {
    Up,
    Down,
    Left,
    Right
}
```

```text
Up    = 0
Down  = 1
Left  = 2
Right = 3
```

Data-carrying variants (if added later) would behave more like tagged unions and need a separate model.

---

## 9. Interfaces

Interfaces have **no independent runtime storage**. They are primarily compile-time types.

```ts
interface Printable {
    print(): void;
}

struct Number {
    value: i32;

    print(): void {
        // ...
    }
}

let x: Printable = Number(10);
```

The actual object is still a `Number`. The interface does not create a new object.

If dynamic dispatch is needed, the compiler may generate a fat pointer / dispatch structure — an implementation detail:

```text
Printable reference
       │
       ▼
┌─────────────────┐
│ data → Number   │
│ vtable → ...    │
└─────────────────┘
```

---

## 10. Stack vs heap

The developer does not choose. The compiler decides.

### Stack

Short-lived local values where possible:

```ts
function add(a: i32, b: i32): i32 {
    let result = a + b;
    return result;
}
```

```text
Call add()
    │
    ▼
Stack frame
├── a
├── b
└── result
```

When the function returns, the frame disappears.

### Heap

Objects whose lifetime may exceed a function call:

```ts
let person = new Person();

function createPerson(): Person {
    return new Person();
}
```

---

## 11. Key rule for developers

The developer writes:

```ts
let person = new Person();
```

Not:

```text
allocate 32 bytes on heap
track reference count
free object when finished
```

The compiler and runtime handle allocation and reclamation.

---

## 12. Memory management

TSN uses **automatic garbage collection**.

- No manual `free(person)`
- No required `Box<Person>` / `Rc<Person>` for everyday code
- Normal code: `let person = new Person();` — the runtime reclaims when unreachable

---

## 13. GC strategy

**First implementation:** tracing GC, specifically a simple **mark-and-sweep** collector.

```text
Heap
│
├── Person A ← reachable
├── Person B ← unreachable
├── Array A  ← reachable
└── String A ← unreachable
```

Roots include:

```text
Stack
Global variables
Active closures
Runtime roots
```

The collector follows references from roots; unreachable objects are freed. Generational or concurrent GC can come later as optimizations.

---

## 14. References

**Implicit references** for normal programming:

```ts
class Person {}

let a = new Person();
let b = a;
```

No `Person*` or `ref<Person>` required. The compiler knows `Person` is a reference type.

Explicit references/pointers may be added later for low-level work; they are not required for everyday code.

---

## 15. Pointers

Explicit pointers are **out of the initial memory model**.

Systems-level syntax such as `let ptr: *i32` may come later. Normal code stays:

```ts
let x: i32 = 10;
```

not:

```ts
let x: *i32 = ...
```

---

## 16. Summary table

| Type         | Category         | Default storage            |
| ------------ | ---------------- | -------------------------- |
| `i32`, `i64` | Value            | Stack/register             |
| `f32`, `f64` | Value            | Stack/register             |
| `bool`       | Value            | Stack/register             |
| `char`       | Value            | Stack/register             |
| Enum         | Value            | Stack/register             |
| Struct       | Value            | Inline/stack when possible |
| Class        | Reference        | Heap                       |
| Array        | Reference        | Heap                       |
| String       | Reference        | Heap                       |
| Map          | Reference        | Heap                       |
| Closure      | Reference        | Heap                       |
| Interface    | Compile-time only | No independent storage     |

**Stack vs heap is not the same as value vs reference.**

A value-type struct may still be heap-placed when needed. A class *reference* often lives in a stack local while the object lives on the heap:

```text
Stack                 Heap

person ─────────────→ Person object
(reference)           (actual data)
```

### Mental model

```text
                TSN Types
                    │
          ┌─────────┴─────────┐
          │                   │
      Value types        Reference types
          │                   │
     Copy on assign      Reference on assign
          │                   │
     Structs, primitives   Classes, arrays,
     enums                 strings, maps,
                           closures
          │                   │
          └─────────┬─────────┘
                    │
             Compiler decides
             physical storage
                    │
             ┌──────┴──────┐
             │             │
           Stack         Heap
             │             │
       Short-lived      Long-lived
       local data       objects
                           │
                           ▼
                    Automatic GC
```

---

## 17. Runtime TypeInfo & object layouts

The runtime keeps a `TypeInfo` registry so every heap kind can be described for a future GC — which slots hold references, element/key/value classifications, and object size.

### TypeInfo shape

```text
TypeInfo
├── type_id
├── kind          (class | array | string | map | closure | env)
├── size          (fixed byte size, or -1 if variable)
├── fields[]      (offset, size, ref_class, nested type_id)
├── elem_*        (arrays: element type_id + ref_class)
└── key_* / value_* (maps)
```

### Reference classification (`ref_class`)

| `ref_class` | Meaning |
| --- | --- |
| `VALUE` | No GC scan (primitive or pure value aggregate) |
| `PTR` | Field/element is a heap pointer |
| `AGG` | Inline aggregate; scan via nested `type_id` |

Examples:

```text
class Person { name: string; age: i32; }
→ field 0 name : PTR
→ field 1 age  : VALUE

class Player { position: Point; }   // Point is a pure value struct
→ position : VALUE

class Game { player: Player; }
→ player : PTR

Person[]  → elem_ref_class = PTR
Point[]   → elem_ref_class = VALUE
struct WithName { name: string; }[]
          → elem_ref_class = AGG
```

### Reserved builtin type IDs

| ID | Kind |
| --- | --- |
| 1 | String (NUL-terminated buffer today) |
| 2 | Array header (`TsnArray`) |
| 3 | Map header (`TsnMap`) |
| 4 | Closure handle shape (`{ code*, env* }`) |
| 5 | Generic env / capture-box placeholder |

Class `type_id`s start at **256**. Lookup: `tsn_typeinfo_get(type_id)`. The compiler registers per-class `TypeInfo` (field layouts) at program start via `tsn_typeinfo_register`.

### Unified model

```text
Runtime TypeInfo
│
├── Class     — size + reference fields (type_id in ObjectHeader)
├── Array     — element type + elem_ref_class (header has no type_id yet)
├── String    — character data (no type_id in buffer yet)
├── Map       — key/value type classification
└── Closure   — handle shape + environment / capture layout
```

Identification today: class instances via `ObjectHeader.type_id`; other kinds via reserved builtin `TypeInfo` entries until an ABI bump embeds `type_id` on every heap object.

### Design decisions (canonical)

| Concern | Decision |
| --- | --- |
| Value types | Primitives, enums, structs |
| Reference types | Classes, arrays, strings, maps, closures |
| Interfaces | Compile-time abstractions; runtime dispatch only when necessary |
| Storage | Compiler chooses stack/register vs heap |
| Memory management | Automatic tracing GC (initially mark-and-sweep) |
| Object header | Classes: `{ type_id, vtable }`; arrays/maps/strings: layout as above (type_id prefix later) |
| Type metadata | `TypeInfo` registry (`tsn_typeinfo_get` / `tsn_typeinfo_register`) |
| References | Implicit for reference types |
| Pointers | Optional future low-level feature |
| Manual `free` | Not part of normal TSN programming |
