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
- `type_id` indexes runtime `TypeInfo` (see [§18](#18-runtime-typeinfo--object-layouts)). Class IDs start at **256**; IDs **1–5** are reserved for builtins.

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

Runtime APIs (`tsn_array_new`, `tsn_array_push`, `tsn_array_pop`, `tsn_array_index_of`) operate on this header. Per-instantiation scan metadata (`tsn_gc_set_array_meta`) records whether elements are `VALUE`, `PTR`, or `AGG` (inline aggregate that itself contains references) so the GC can scan the data buffer correctly.

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

Today keys are strings and values are pointer-sized. Side-table map metadata (`tsn_gc_set_map_meta`) records key/value reference classification so the GC can scan entries (e.g. `Map<string, Person>` → key `PTR`, value `PTR`; pure value payloads use `VALUE` and are not followed).

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
- Each environment layout gets a registered `TypeInfo` (`TSN_KIND_ENV`). Mutable capture boxes that hold references get their own `TypeInfo` (`TSN_KIND_STRUCT`) so the GC scans the boxed pointer/aggregate.

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

## 12. Allocation ownership

Raw heap memory for TSN-managed objects goes through one canonical API:

```text
void* tsn_alloc(size);
void* tsn_realloc(ptr, size);
void  tsn_free(ptr);
```

**Compiler** chooses object size and layout, then initializes fields. **Runtime** owns the bytes.

```text
TSN compiler
     │
     │  "I need N bytes for this layout"
     ▼
tsn_alloc(N)   (or a helper that calls it)
     │
     ▼
Runtime heap memory
     │
     ▼
Compiler initializes object / header
     │
     ▼
Return reference
```

Call graph today (ABIs unchanged):

| Kind | Compiler emits | Runtime allocates with |
| --- | --- | --- |
| Class instance | `tsn_alloc(sizeof(Class))` + ObjectHeader init | `tsn_alloc` |
| Array | `tsn_array_new(...)` | `tsn_alloc` (header + data); grow via `tsn_realloc` |
| String (dynamic) | `tsn_str_concat` / `to_string` helpers | `tsn_alloc` |
| Map | `tsn_map_new` / `tsn_map_set` | `tsn_alloc` / `tsn_realloc` |
| Closure environment | `tsn_alloc(sizeof(env))` | `tsn_alloc` |

Root registration and `tsn_gc_set_type` / `tsn_gc_set_array_meta` / `tsn_gc_set_map_meta` are the compiler/runtime hooks for the collector; a future allocator swap can keep those call sites.

---

## 13. Memory management

TSN uses **automatic garbage collection**.

- No manual `free(person)`
- No required `Box<Person>` / `Rc<Person>` for everyday code
- Normal code: `let person = new Person();` — the runtime reclaims when unreachable

---

## 14. GC strategy

**Implemented:** tracing **mark-and-sweep** collector with an explicit **shadow stack**.

```text
Heap (side table)
│
├── Person A ← reachable
├── Person B ← unreachable
├── Array A  ← reachable
└── String A ← unreachable
```

### Allocation tracking

Every `tsn_alloc` / `tsn_realloc` registers the payload pointer in a runtime side table (`ptr`, `size`, `type_id`, mark bit, array/map scan meta). Object byte layouts are unchanged — arrays/maps/strings still do not embed `type_id` in-object; the side table carries type identity instead.

GC-internal structures (the side table, root stack, TypeInfo registry growth) use system `malloc`, never `tsn_alloc`, to avoid reentrancy.

Secondary buffers (array `data`, map `keys`/`vals`) are separate GC objects with opaque `type_id = 0`; they are marked only when a parent array/map is marked.

String literals are not in the side table; marking them is a no-op, so they are never swept.

### Roots (shadow stack)

The compiler emits:

```text
cp = tsn_gc_root_checkpoint()   // once per function, before its first root push
tsn_gc_root_push(slot)          // on reference locals / params / this / callable env fields
… function body …
tsn_gc_root_restore(cp)         // on every return (safe if unwind already trimmed roots)
```

Roots also include global slots (`tsn_gc_add_global_root`) and the pending exception pointer (`tsn_gc_set_exception_root`).

Exception unwinding (setjmp/longjmp) restores the shadow stack: each EH frame records a root checkpoint at `tsn_eh_push`, and `tsn_throw` calls `tsn_gc_root_restore` before running a finally-only callback or longjmping to a catcher. That drops abandoned callee roots so the next collection cannot scan dangling stack slots. Catch parameters are rooted before `setjmp`; after binding, `tsn_eh_clear_exception` transfers ownership from the pending-exception root to the catch local. Try-only locals may become unmarked after unwind into catch (they are language-dead). Function returns always restore to the function-entry checkpoint, so a static push count never over-pops after an exception trimmed the shadow stack.

Rule: anything reachable from a GC root stays alive.

### Mark and sweep

1. Clear marks
2. Mark every object reachable from roots, following TypeInfo field/`elem_*`/`key_*`/`value_*` metadata (including nested structs via `AGG`, closure envs, and typed boxes)
3. Free unmarked objects and remove them from the side table; clear marks on survivors

Cycles are handled naturally (marked check stops re-entry; no root → neither object is marked → both swept).

### Reference scanning

The collector walks the full object graph:

```text
Root → Closure env → User → profile (AGG) → String
                  ↘ Friend (PTR) → Person
```

| Container | How refs are found |
| --- | --- |
| Class | `TypeInfo.fields` — `PTR` / nested `AGG` |
| Struct-with-refs (inline) | Nested `TSN_KIND_STRUCT` TypeInfo via `AGG` |
| Array | Side-table `elem_ref_class` / `elem_type_id` (`tsn_gc_set_array_meta`) |
| Map | Side-table key/value meta (`tsn_gc_set_map_meta`) |
| Closure handle | Builtin CLOSURE fields → env `PTR` |
| Closure env | Per-env `TSN_KIND_ENV` TypeInfo |
| Mutable / union box | Per-layout `TSN_KIND_STRUCT` TypeInfo |

### When GC runs

Before `tsn_alloc` / `tsn_realloc`, if `bytes_allocated > threshold` (default 1 MiB), the runtime runs `tsn_gc_collect()`. Tests and tools can call `tsn_gc_collect` / `tsn_gc_set_threshold` directly.

Generational or concurrent GC can come later as optimizations.

---

## 15. References

**Implicit references** for normal programming:

```ts
class Person {}

let a = new Person();
let b = a;
```

No `Person*` or `ref<Person>` required. The compiler knows `Person` is a reference type.

Explicit references/pointers may be added later for low-level work; they are not required for everyday code.

---

## 16. Pointers

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

## 17. Summary table

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

## 18. Runtime TypeInfo & object layouts

The runtime keeps a `TypeInfo` registry so every heap kind can be described for GC — which slots hold references, element/key/value classifications, and object size.

### TypeInfo shape

```text
TypeInfo
├── type_id
├── kind          (class | array | string | map | closure | env | struct)
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

class User { profile: Profile; }    // Profile { name: string; age: i32 }
→ profile : AGG → TypeInfo(Profile)
                   └── name : PTR

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
├── Struct    — nested AGG layouts / typed boxes (`TSN_KIND_STRUCT`)
├── Array     — element type + elem_ref_class (header has no type_id yet)
├── String    — character data (no type_id in buffer yet)
├── Map       — key/value type classification (side-table meta)
└── Closure   — handle shape + environment / capture layout
```

Identification today: class instances via `ObjectHeader.type_id` and the GC side table; other kinds via reserved builtin `TypeInfo` entries plus `tsn_gc_set_type` / `tsn_gc_set_array_meta` / `tsn_gc_set_map_meta` at allocation time. A future ABI bump may also embed `type_id` on every heap object.

### Design decisions (canonical)

| Concern | Decision |
| --- | --- |
| Value types | Primitives, enums, structs |
| Reference types | Classes, arrays, strings, maps, closures |
| Interfaces | Compile-time abstractions; runtime dispatch only when necessary |
| Storage | Compiler chooses stack/register vs heap |
| Memory management | Automatic tracing GC (mark-and-sweep + shadow stack) |
| Object header | Classes: `{ type_id, vtable }`; arrays/maps/strings: layout as above; GC type identity also in side table |
| Type metadata | `TypeInfo` registry (`tsn_typeinfo_get` / `tsn_typeinfo_register`) |
| References | Implicit for reference types |
| Pointers | Optional future low-level feature |
| Manual `free` | Not part of normal TSN programming |
