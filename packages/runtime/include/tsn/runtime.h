#ifndef TSN_RUNTIME_H
#define TSN_RUNTIME_H

#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Must match ARRAY_HEADER_SIZE in packages/compiler/src/codegen/llvm.ts */
#define TSN_ARRAY_HEADER_SIZE 24
#define TSN_MAP_HEADER_SIZE 32

/* Opaque exception-handling frame; must match TsnEhFrame in exception.c */
#define TSN_EH_FRAME_SIZE 256

typedef void (*TsnFinallyFn)(void *ctx);

void tsn_eh_init_frame(void *frame, int32_t has_catch, TsnFinallyFn finally_fn, void *finally_ctx);
void tsn_eh_push(void *frame);
void tsn_eh_pop(void *frame);
jmp_buf *tsn_eh_jmp_buf(void *frame);
void tsn_throw(void *error);
void *tsn_eh_caught_exception(void);
void tsn_eh_clear_exception(void);
void tsn_uncaught_exception(void *error);

/* Shared header on every class instance. Must match %ObjectHeader in llvm.ts.
 * type_id indexes TypeInfo (class IDs start at TSN_TYPEID_CLASS_BASE).
 * Arrays/maps/strings do not embed type_id yet — see reserved TSN_TYPEID_*. */
typedef struct TsnObjectHeader {
  int32_t type_id;
  void *vtable;
} TsnObjectHeader;

/* Canonical 24-byte array header. Must match ARRAY_HEADER_SIZE in llvm.ts. */
typedef struct TsnArray {
  int64_t length;
  int64_t capacity;
  void *data;
} TsnArray;

/* Canonical 32-byte map header. String keys + pointer-sized values today. */
typedef struct TsnMap {
  int64_t len;
  int64_t cap;
  char **keys;
  void **vals;
} TsnMap;

/* --- TypeInfo (GC / RTTI metadata; does not change object byte layouts) --- */

typedef enum TsnTypeKind {
  TSN_KIND_CLASS = 1,
  TSN_KIND_ARRAY = 2,
  TSN_KIND_STRING = 3,
  TSN_KIND_MAP = 4,
  TSN_KIND_CLOSURE = 5, /* %__Callable handle shape (not always heap) */
  TSN_KIND_ENV = 6,     /* closure environment blob */
  TSN_KIND_STRUCT = 7,  /* value aggregate / box layout (not a heap class) */
} TsnTypeKind;

typedef enum TsnRefClass {
  TSN_REF_VALUE = 0, /* no GC scan (primitive / pure value aggregate) */
  TSN_REF_PTR = 1,   /* field/element is a heap pointer */
  TSN_REF_AGG = 2,   /* inline aggregate; scan via nested type_id */
} TsnRefClass;

/* Reserved builtin type_ids. Class type_ids start at TSN_TYPEID_CLASS_BASE. */
#define TSN_TYPEID_STRING 1
#define TSN_TYPEID_ARRAY 2
#define TSN_TYPEID_MAP 3
#define TSN_TYPEID_CLOSURE 4
#define TSN_TYPEID_ENV 5
#define TSN_TYPEID_CLASS_BASE 256

typedef struct TsnFieldInfo {
  int32_t offset;    /* bytes from object start */
  int32_t size;
  int32_t ref_class; /* TsnRefClass */
  int32_t type_id;   /* nested TypeInfo for AGG; related type for PTR; 0 if N/A */
} TsnFieldInfo;

/* Must match %TsnTypeInfo / %TsnFieldInfo in llvm.ts when emitting constants. */
typedef struct TsnTypeInfo {
  int32_t type_id;
  int32_t kind; /* TsnTypeKind */
  int32_t size; /* fixed size, or -1 if variable-length */
  int32_t field_count;
  const TsnFieldInfo *fields;
  /* Array */
  int32_t elem_type_id;
  int32_t elem_ref_class;
  /* Map */
  int32_t key_type_id;
  int32_t key_ref_class;
  int32_t value_type_id;
  int32_t value_ref_class;
} TsnTypeInfo;

const TsnTypeInfo *tsn_typeinfo_get(int32_t type_id);
void tsn_typeinfo_register(const TsnTypeInfo *info);

/* --- Mark-and-sweep GC (side-table tracking; object layouts unchanged) --- */

void tsn_gc_set_type(void *ptr, int32_t type_id);
void tsn_gc_set_array_meta(void *arr, int32_t elem_ref_class, int32_t elem_type_id, int64_t elem_size);
void tsn_gc_set_map_meta(void *map, int32_t key_ref_class, int32_t key_type_id, int32_t value_ref_class,
                         int32_t value_type_id);
void tsn_gc_root_push(void **slot);
void tsn_gc_root_pop(int32_t n);
int32_t tsn_gc_root_checkpoint(void);
void tsn_gc_root_restore(int32_t n);
void tsn_gc_add_global_root(void **slot);
void tsn_gc_set_exception_root(void **slot);
void tsn_gc_collect(void);
void tsn_gc_set_threshold(int64_t bytes);
int64_t tsn_gc_bytes_allocated(void);

/* Element comparison kinds for array search helpers. */
#define TSN_CMP_I32 0
#define TSN_CMP_I64 1
#define TSN_CMP_F32 2
#define TSN_CMP_F64 3
#define TSN_CMP_BOOL 4
#define TSN_CMP_CHAR 5
#define TSN_CMP_STRING 6
#define TSN_CMP_PTR 7

/* Element formatting kinds for array-to-string helpers. */
#define TSN_FMT_I32 0
#define TSN_FMT_I64 1
#define TSN_FMT_F32 2
#define TSN_FMT_F64 3
#define TSN_FMT_BOOL 4
#define TSN_FMT_CHAR 5
#define TSN_FMT_STRING 6

void *tsn_alloc(int64_t size);
void *tsn_realloc(void *ptr, int64_t size);
void tsn_free(void *ptr);

int32_t tsn_str_len(const char *s);
char *tsn_str_concat(const char *left, const char *right);

void *tsn_array_new(int64_t length, int64_t capacity, int64_t elem_size);
int32_t tsn_array_length(void *arr);
void tsn_array_push(void *arr, void *value, int64_t elem_size);
void tsn_array_pop(void *arr, void *dest, int64_t elem_size);
int32_t tsn_array_index_of(void *arr, void *needle, int64_t elem_size, int32_t cmp_kind);

void *tsn_map_new(void);
void tsn_map_set(void *map, const char *key, void *val);
void *tsn_map_get(void *map, const char *key);

void tsn_print_i32(int32_t value);
void tsn_print_i64(int64_t value);
void tsn_print_f32(float value);
void tsn_print_f64(double value);
void tsn_print_bool(bool value);
void tsn_print_char(char value);
void tsn_print_str(const char *value);
void tsn_print_space(void);
void tsn_print_newline(void);

char *tsn_i32_to_string(int32_t value);
char *tsn_i64_to_string(int64_t value);
char *tsn_f32_to_string(float value);
char *tsn_f64_to_string(double value);
char *tsn_bool_to_string(bool value);
char *tsn_char_to_string(char value);
char *tsn_array_to_string(void *arr, int64_t elem_size, int32_t elem_fmt);

#ifdef __cplusplus
}
#endif

#endif /* TSN_RUNTIME_H */
