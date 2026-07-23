#ifndef SN_RUNTIME_H
#define SN_RUNTIME_H

#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Must match ARRAY_HEADER_SIZE in packages/compiler/src/codegen/llvm.ts */
#define SN_ARRAY_HEADER_SIZE 24
#define SN_MAP_HEADER_SIZE 32

/* Opaque exception-handling frame; must match SnEhFrame in exception.c */
#define SN_EH_FRAME_SIZE 256

typedef void (*SnFinallyFn)(void *ctx);

void sn_eh_init_frame(void *frame, int32_t has_catch, SnFinallyFn finally_fn, void *finally_ctx);
void sn_eh_push(void *frame);
void sn_eh_pop(void *frame);
jmp_buf *sn_eh_jmp_buf(void *frame);
void sn_throw(void *error);
void *sn_eh_caught_exception(void);
void sn_eh_clear_exception(void);
void sn_uncaught_exception(void *error);

/* Shared header on every class instance. Must match %ObjectHeader in llvm.ts.
 * type_id indexes TypeInfo (class IDs start at SN_TYPEID_CLASS_BASE).
 * Arrays/maps/strings do not embed type_id yet — see reserved SN_TYPEID_*. */
typedef struct SnObjectHeader {
  int32_t type_id;
  void *vtable;
} SnObjectHeader;

/* Canonical 24-byte array header. Must match ARRAY_HEADER_SIZE in llvm.ts. */
typedef struct SnArray {
  int64_t length;
  int64_t capacity;
  void *data;
} SnArray;

/* Canonical 32-byte map header. String keys + pointer-sized values today. */
typedef struct SnMap {
  int64_t len;
  int64_t cap;
  char **keys;
  void **vals;
} SnMap;

/* --- TypeInfo (GC / RTTI metadata; does not change object byte layouts) --- */

typedef enum SnTypeKind {
  SN_KIND_CLASS = 1,
  SN_KIND_ARRAY = 2,
  SN_KIND_STRING = 3,
  SN_KIND_MAP = 4,
  SN_KIND_CLOSURE = 5, /* %__Callable handle shape (not always heap) */
  SN_KIND_ENV = 6,     /* closure environment blob */
  SN_KIND_STRUCT = 7,  /* value aggregate / box layout (not a heap class) */
} SnTypeKind;

typedef enum SnRefClass {
  SN_REF_VALUE = 0, /* no GC scan (primitive / pure value aggregate) */
  SN_REF_PTR = 1,   /* field/element is a heap pointer */
  SN_REF_AGG = 2,   /* inline aggregate; scan via nested type_id */
} SnRefClass;

/* Reserved builtin type_ids. Class type_ids start at SN_TYPEID_CLASS_BASE. */
#define SN_TYPEID_STRING 1
#define SN_TYPEID_ARRAY 2
#define SN_TYPEID_MAP 3
#define SN_TYPEID_CLOSURE 4
#define SN_TYPEID_ENV 5
#define SN_TYPEID_FUTURE 6
#define SN_TYPEID_TASK 7
#define SN_TYPEID_CLASS_BASE 256

/* Future lifecycle states. */
#define SN_FUTURE_PENDING 0
#define SN_FUTURE_COMPLETED 1
#define SN_FUTURE_FAILED 2
#define SN_FUTURE_CANCELLED 3

typedef struct SnFieldInfo {
  int32_t offset;    /* bytes from object start */
  int32_t size;
  int32_t ref_class; /* SnRefClass */
  int32_t type_id;   /* nested TypeInfo for AGG; related type for PTR; 0 if N/A */
} SnFieldInfo;

/* Must match %SnTypeInfo / %SnFieldInfo in llvm.ts when emitting constants. */
typedef struct SnTypeInfo {
  int32_t type_id;
  int32_t kind; /* SnTypeKind */
  int32_t size; /* fixed size, or -1 if variable-length */
  int32_t field_count;
  const SnFieldInfo *fields;
  /* Array */
  int32_t elem_type_id;
  int32_t elem_ref_class;
  /* Map */
  int32_t key_type_id;
  int32_t key_ref_class;
  int32_t value_type_id;
  int32_t value_ref_class;
  /* Class inheritance: superclass type_id, or 0 if none. */
  int32_t parent_type_id;
} SnTypeInfo;

const SnTypeInfo *sn_typeinfo_get(int32_t type_id);
void sn_typeinfo_register(const SnTypeInfo *info);
/* True if obj is non-null and its type_id (or an ancestor) equals type_id. */
bool sn_is_instance(void *obj, int32_t type_id);

/* --- Mark-and-sweep GC (side-table tracking; object layouts unchanged) --- */

void sn_gc_set_type(void *ptr, int32_t type_id);
void sn_gc_set_array_meta(void *arr, int32_t elem_ref_class, int32_t elem_type_id, int64_t elem_size);
void sn_gc_set_map_meta(void *map, int32_t key_ref_class, int32_t key_type_id, int32_t value_ref_class,
                         int32_t value_type_id);
void sn_gc_root_push(void **slot);
void sn_gc_root_pop(int32_t n);
int32_t sn_gc_root_checkpoint(void);
void sn_gc_root_restore(int32_t n);
void sn_gc_add_global_root(void **slot);
void sn_gc_set_exception_root(void **slot);
void sn_gc_collect(void);
void sn_gc_set_threshold(int64_t bytes);
int64_t sn_gc_bytes_allocated(void);

/* Element comparison kinds for array search helpers. */
#define SN_CMP_I32 0
#define SN_CMP_I64 1
#define SN_CMP_F32 2
#define SN_CMP_F64 3
#define SN_CMP_BOOL 4
#define SN_CMP_CHAR 5
#define SN_CMP_STRING 6
#define SN_CMP_PTR 7

/* Element formatting kinds for array-to-string helpers. */
#define SN_FMT_I32 0
#define SN_FMT_I64 1
#define SN_FMT_F32 2
#define SN_FMT_F64 3
#define SN_FMT_BOOL 4
#define SN_FMT_CHAR 5
#define SN_FMT_STRING 6

void *sn_alloc(int64_t size);
void *sn_realloc(void *ptr, int64_t size);
void sn_free(void *ptr);

int32_t sn_str_len(const char *s);
char *sn_str_concat(const char *left, const char *right);
int32_t sn_str_index_of(const char *haystack, const char *needle);
bool sn_str_contains(const char *haystack, const char *needle);
bool sn_str_starts_with(const char *s, const char *prefix);
bool sn_str_ends_with(const char *s, const char *suffix);
char *sn_str_substring(const char *s, int32_t start, int32_t end);
char *sn_str_trim(const char *s);
char *sn_str_trim_start(const char *s);
char *sn_str_trim_end(const char *s);
char *sn_str_to_upper(const char *s);
char *sn_str_to_lower(const char *s);
char *sn_str_replace(const char *s, const char *from, const char *to);
char *sn_str_replace_all(const char *s, const char *from, const char *to);
/* Returns a GC-managed string[] (array header pointer). */
char *sn_str_split(const char *s, const char *sep);
char sn_str_char_at(const char *s, int32_t index);
char *sn_str_repeat(const char *s, int32_t count);
char *sn_str_pad_start(const char *s, int32_t target_len, const char *pad);
char *sn_str_pad_end(const char *s, int32_t target_len, const char *pad);
/* Join a string[] with a separator. */
char *sn_str_join(void *parts, const char *sep);
int32_t sn_str_last_index_of(const char *haystack, const char *needle);

/* Math (libm). Floating wrappers use f64; integer helpers are separate. */
double sn_math_abs(double x);
double sn_math_min(double a, double b);
double sn_math_max(double a, double b);
double sn_math_floor(double x);
double sn_math_ceil(double x);
double sn_math_round(double x);
double sn_math_sqrt(double x);
double sn_math_pow(double base, double exponent);
double sn_math_sin(double x);
double sn_math_cos(double x);
double sn_math_tan(double x);
double sn_math_asin(double x);
double sn_math_acos(double x);
double sn_math_atan(double x);
double sn_math_atan2(double y, double x);
double sn_math_clamp(double x, double lo, double hi);
double sn_math_log(double x);
double sn_math_exp(double x);
int32_t sn_math_abs_i32(int32_t x);
int64_t sn_math_abs_i64(int64_t x);
int32_t sn_math_min_i32(int32_t a, int32_t b);
int32_t sn_math_max_i32(int32_t a, int32_t b);
int64_t sn_math_min_i64(int64_t a, int64_t b);
int64_t sn_math_max_i64(int64_t a, int64_t b);

/* Random number generation (seeded from time on first use). */
void sn_random_seed(int64_t seed);
double sn_random(void);
int32_t sn_random_int(int32_t min, int32_t max);
double sn_random_float(double min, double max);

void *sn_array_new(int64_t length, int64_t capacity, int64_t elem_size);
int32_t sn_array_length(void *arr);
void sn_array_push(void *arr, void *value, int64_t elem_size);
void sn_array_pop(void *arr, void *dest, int64_t elem_size);
int32_t sn_array_index_of(void *arr, void *needle, int64_t elem_size, int32_t cmp_kind);

void *sn_map_new(void);
void sn_map_set(void *map, const char *key, void *val);
void *sn_map_get(void *map, const char *key);
bool sn_map_remove(void *map, const char *key);
bool sn_map_contains(void *map, const char *key);
int32_t sn_map_size(void *map);
void sn_map_clear(void *map);
/* Returns string[] of keys. */
void *sn_map_keys(void *map);
/* Returns void*[] of values (pointer-sized slots). */
void *sn_map_values(void *map);

void sn_print_i32(int32_t value);
void sn_print_i64(int64_t value);
void sn_print_f32(float value);
void sn_print_f64(double value);
void sn_print_bool(bool value);
void sn_print_char(char value);
void sn_print_str(const char *value);
void sn_print_space(void);
void sn_print_newline(void);

void sn_eprint_i32(int32_t value);
void sn_eprint_i64(int64_t value);
void sn_eprint_f32(float value);
void sn_eprint_f64(double value);
void sn_eprint_bool(bool value);
void sn_eprint_char(char value);
void sn_eprint_str(const char *value);
void sn_eprint_space(void);
void sn_eprint_newline(void);

/* Reads a line from stdin (without trailing newline). Returns "" on EOF. */
char *sn_read_line(void);

char *sn_i32_to_string(int32_t value);
char *sn_i64_to_string(int64_t value);
char *sn_f32_to_string(float value);
char *sn_f64_to_string(double value);
char *sn_bool_to_string(bool value);
char *sn_char_to_string(char value);
char *sn_array_to_string(void *arr, int64_t elem_size, int32_t elem_fmt);
char *sn_map_to_string(void *map);

/* Process / environment */
void sn_runtime_init(int32_t argc, char **argv);
void *sn_process_args(void); /* string[] */
char *sn_process_getenv(const char *name);
bool sn_process_setenv(const char *name, const char *value);
char *sn_process_cwd(void);
void sn_process_exit(int32_t code);

/* Time (milliseconds) */
int64_t sn_time_now_ms(void);
void sn_time_sleep_ms(int64_t ms);

/* Filesystem */
char *sn_fs_read_file(const char *path); /* NULL on failure */
bool sn_fs_write_file(const char *path, const char *contents);
bool sn_fs_append_file(const char *path, const char *contents);
bool sn_fs_exists(const char *path);
bool sn_fs_delete_file(const char *path);
bool sn_fs_copy_file(const char *src, const char *dst);
bool sn_fs_move_file(const char *src, const char *dst);
bool sn_fs_create_dir(const char *path);
bool sn_fs_delete_dir(const char *path);
void *sn_fs_list_dir(const char *path); /* string[] or NULL on failure */

/* Path helpers */
char *sn_path_join(const char *a, const char *b);
char *sn_path_basename(const char *path);
char *sn_path_dirname(const char *path);
char *sn_path_extension(const char *path);
char *sn_path_normalize(const char *path);
char *sn_path_absolute(const char *path);

/* Encoding */
char *sn_base64_encode(const char *data);
char *sn_base64_decode(const char *data); /* NULL on invalid input */
char *sn_hex_encode(const char *data);
char *sn_hex_decode(const char *data); /* NULL on invalid input */
int32_t sn_utf8_byte_len(const char *s);
bool sn_utf8_is_valid(const char *s);

bool sn_random_bool(void);

/* --- Async runtime (single-threaded cooperative tasks) --- */

void sn_async_init(void);
void sn_async_shutdown(void);

void *sn_future_new(void);
void sn_future_complete(void *fut, void *value);
void sn_future_complete_void(void *fut);
void sn_future_fail(void *fut, void *error);
void sn_future_cancel(void *fut);
bool sn_future_is_ready(void *fut);
bool sn_future_is_cancelled(void *fut);
int32_t sn_future_state(void *fut);
void *sn_future_value(void *fut);
void *sn_future_error(void *fut);
/* Compose: all/race over a Future*[] array. Returns a new Future. */
void *sn_future_all(void *futures_array);
void *sn_future_race(void *futures_array);

typedef void (*SnTaskResumeFn)(void *frame);

/* Spawn a task. Returns the result future (same as result_fut if non-null). */
void *sn_task_spawn(SnTaskResumeFn resume, void *frame, void *result_fut);
void *sn_task_current(void);
void sn_task_await(void *task, void *fut);
void sn_task_cancel(void *task);
bool sn_task_is_cancelled(void *task);
/* In a resume function: if fut is pending, registers await and returns true (caller must ret).
 * If ready, returns false and caller continues (throwing on failure is caller's job). */
bool sn_task_await_suspend(void *fut);
/* Drive the event loop until fut is settled. Safe to call from a running task
 * (nested). On failure the caller should sn_throw(sn_future_error(fut)). */
void sn_future_await_run(void *fut);

/* Drive the event loop until root_future is settled (and drain runnable work). */
void sn_event_loop_run(void *root_future);
/* Non-blocking: run runnable tasks and poll ready I/O once. */
void sn_event_loop_poll(void);

/* Async sleep: returns Future<void> that completes after ms. */
void *sn_timer_sleep_ms(int64_t ms);
void sn_timer_cancel(void *fut);

/* Non-blocking TCP. Handles are i64-encoded pointers in Future values. */
void *sn_tcp_listen(const char *host, int32_t port); /* Future<i64> */
void *sn_tcp_accept(int64_t listener);                 /* Future<i64> */
void *sn_tcp_connect(const char *host, int32_t port); /* Future<i64> */
void *sn_tcp_read(int64_t conn, int32_t max_bytes);    /* Future<string> */
void *sn_tcp_write(int64_t conn, const char *data);    /* Future<void> */
void sn_tcp_close_i64(int64_t handle);

#ifdef __cplusplus
}
#endif

#endif /* SN_RUNTIME_H */
