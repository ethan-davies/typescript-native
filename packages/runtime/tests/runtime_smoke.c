#include <assert.h>
#include <setjmp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "sn/runtime.h"

static void test_alloc(void) {
  assert(sizeof(SnArray) == SN_ARRAY_HEADER_SIZE);
  assert(sizeof(SnMap) == SN_MAP_HEADER_SIZE);
  /* LP64: i32 type_id, 4-byte pad, then vtable pointer → 16 bytes */
  assert(sizeof(SnObjectHeader) == 16);
  assert(offsetof(SnObjectHeader, type_id) == 0);
  assert(offsetof(SnObjectHeader, vtable) == 8);

  int32_t *buf = (int32_t *)sn_alloc((int64_t)sizeof(int32_t) * 4);
  assert(buf != NULL);
  buf[0] = 42;
  buf = (int32_t *)sn_realloc(buf, (int64_t)sizeof(int32_t) * 8);
  assert(buf != NULL);
  assert(buf[0] == 42);
  buf[7] = 99;
  assert(buf[7] == 99);
  sn_free(buf);
}

static void test_strings(void) {
  char *joined = sn_str_concat("Hello", " world");
  assert(strcmp(joined, "Hello world") == 0);
  assert(sn_str_len(joined) == 11);
  sn_free(joined);

  assert(sn_str_contains("hello", "ell"));
  assert(!sn_str_contains("hello", "xyz"));
  assert(sn_str_starts_with("hello", "he"));
  assert(sn_str_ends_with("hello", "lo"));
  assert(sn_str_index_of("hello", "ll") == 2);

  char *sub = sn_str_substring("hello", 1, 4);
  assert(strcmp(sub, "ell") == 0);
  sn_free(sub);

  char *trimmed = sn_str_trim("  hi  ");
  assert(strcmp(trimmed, "hi") == 0);
  sn_free(trimmed);

  char *upper = sn_str_to_upper("AbC");
  assert(strcmp(upper, "ABC") == 0);
  sn_free(upper);

  char *lower = sn_str_to_lower("AbC");
  assert(strcmp(lower, "abc") == 0);
  sn_free(lower);

  char *replaced = sn_str_replace("hello", "ll", "y");
  assert(strcmp(replaced, "heyo") == 0);
  sn_free(replaced);

  void *parts = sn_str_split("a,b,c", ",");
  assert(sn_array_length(parts) == 3);

  assert(sn_str_char_at("hello", 1) == 'e');
  assert(sn_str_last_index_of("banana", "an") == 3);

  char *repeated = sn_str_repeat("ab", 3);
  assert(strcmp(repeated, "ababab") == 0);
  sn_free(repeated);

  char *padded = sn_str_pad_start("42", 5, "0");
  assert(strcmp(padded, "00042") == 0);
  sn_free(padded);

  char *joined_parts = sn_str_join(parts, "-");
  assert(strcmp(joined_parts, "a-b-c") == 0);
  sn_free(joined_parts);
}

static void test_arrays(void) {
  void *arr = sn_array_new(0, 4, (int64_t)sizeof(int32_t));
  int32_t values[] = {1, 2, 3};
  for (int i = 0; i < 3; i += 1) {
    sn_array_push(arr, &values[i], (int64_t)sizeof(int32_t));
  }
  assert(sn_array_length(arr) == 3);

  int32_t needle = 2;
  assert(sn_array_index_of(arr, &needle, (int64_t)sizeof(int32_t), SN_CMP_I32) == 1);

  int32_t popped = 0;
  sn_array_pop(arr, &popped, (int64_t)sizeof(int32_t));
  assert(popped == 3);
  assert(sn_array_length(arr) == 2);
}

static void test_maps(void) {
  void *map = sn_map_new();
  char *value_a = sn_str_concat("first", "");
  char *value_b = sn_str_concat("second", "");
  sn_map_set(map, "alpha", value_a);
  sn_map_set(map, "beta", value_b);
  assert(strcmp((char *)sn_map_get(map, "alpha"), "first") == 0);

  char *replacement = sn_str_concat("updated", "");
  sn_map_set(map, "alpha", replacement);
  assert(strcmp((char *)sn_map_get(map, "alpha"), "updated") == 0);

  for (int i = 0; i < 10; i += 1) {
    char key[16];
    snprintf(key, sizeof(key), "key-%d", i);
    char *val = sn_str_concat("v", "");
    sn_map_set(map, key, val);
  }
  assert(sn_map_get(map, "key-9") != NULL);
}

static void test_math(void) {
  assert(sn_math_abs(-3.5) == 3.5);
  assert(sn_math_sqrt(25.0) == 5.0);
  assert(sn_math_floor(3.9) == 3.0);
  assert(sn_math_ceil(3.1) == 4.0);
  assert(sn_math_pow(2.0, 10.0) == 1024.0);
  assert(sn_math_abs_i32(-7) == 7);
  assert(sn_math_min_i32(3, 7) == 3);
  assert(sn_math_max_i64(3, 7) == 7);
}

static void test_random(void) {
  sn_random_seed(12345);
  double a = sn_random();
  double b = sn_random();
  assert(a >= 0.0 && a < 1.0);
  assert(b >= 0.0 && b < 1.0);
  assert(a != b);

  sn_random_seed(99);
  int32_t n = sn_random_int(1, 6);
  assert(n >= 1 && n <= 6);

  double f = sn_random_float(2.0, 5.0);
  assert(f >= 2.0 && f < 5.0);
}

static void test_print_and_format(void) {
  char *text = sn_i32_to_string(42);
  assert(strcmp(text, "42") == 0);
  sn_free(text);

  void *arr = sn_array_new(0, 4, (int64_t)sizeof(int32_t));
  int32_t values[] = {1, 2, 3};
  for (int i = 0; i < 3; i += 1) {
    sn_array_push(arr, &values[i], (int64_t)sizeof(int32_t));
  }
  char *arr_text = sn_array_to_string(arr, (int64_t)sizeof(int32_t), SN_FMT_I32);
  assert(strcmp(arr_text, "[1, 2, 3]") == 0);
  sn_free(arr_text);

  sn_print_str("runtime smoke");
  sn_print_space();
  sn_print_i32(1);
  sn_print_newline();
}

static void test_typeinfo(void) {
  const SnTypeInfo *string_ti = sn_typeinfo_get(SN_TYPEID_STRING);
  assert(string_ti != NULL);
  assert(string_ti->kind == SN_KIND_STRING);
  assert(string_ti->size == -1);

  const SnTypeInfo *array_ti = sn_typeinfo_get(SN_TYPEID_ARRAY);
  assert(array_ti != NULL);
  assert(array_ti->kind == SN_KIND_ARRAY);
  assert(array_ti->size == (int32_t)sizeof(SnArray));

  const SnTypeInfo *map_ti = sn_typeinfo_get(SN_TYPEID_MAP);
  assert(map_ti != NULL);
  assert(map_ti->kind == SN_KIND_MAP);
  assert(map_ti->key_ref_class == SN_REF_PTR);
  assert(map_ti->value_ref_class == SN_REF_PTR);

  const SnTypeInfo *closure_ti = sn_typeinfo_get(SN_TYPEID_CLOSURE);
  assert(closure_ti != NULL);
  assert(closure_ti->kind == SN_KIND_CLOSURE);
  assert(closure_ti->field_count == 2);
  assert(closure_ti->fields[1].ref_class == SN_REF_PTR);

  const SnTypeInfo *env_ti = sn_typeinfo_get(SN_TYPEID_ENV);
  assert(env_ti != NULL);
  assert(env_ti->kind == SN_KIND_ENV);

  assert(sn_typeinfo_get(SN_TYPEID_CLASS_BASE) == NULL);

  static const SnFieldInfo class_fields[] = {
      {.offset = 16, .size = 8, .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_STRING},
  };
  static const SnTypeInfo class_ti = {
      .type_id = SN_TYPEID_CLASS_BASE,
      .kind = SN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = class_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
      .parent_type_id = 0,
  };
  sn_typeinfo_register(&class_ti);
  const SnTypeInfo *got = sn_typeinfo_get(SN_TYPEID_CLASS_BASE);
  assert(got == &class_ti);
  assert(got->field_count == 1);
  assert(got->fields[0].ref_class == SN_REF_PTR);
  assert(got->parent_type_id == 0);
}

static void test_is_instance(void) {
  typedef struct {
    SnObjectHeader header;
  } BaseObj;

  static const SnTypeInfo base_ti = {
      .type_id = SN_TYPEID_CLASS_BASE,
      .kind = SN_KIND_CLASS,
      .size = (int32_t)sizeof(BaseObj),
      .field_count = 0,
      .fields = NULL,
      .parent_type_id = 0,
  };
  static const SnTypeInfo sub_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 1,
      .kind = SN_KIND_CLASS,
      .size = (int32_t)sizeof(BaseObj),
      .field_count = 0,
      .fields = NULL,
      .parent_type_id = SN_TYPEID_CLASS_BASE,
  };
  sn_typeinfo_register(&base_ti);
  sn_typeinfo_register(&sub_ti);

  BaseObj *sub = (BaseObj *)sn_alloc((int64_t)sizeof(BaseObj));
  sub->header.type_id = SN_TYPEID_CLASS_BASE + 1;
  sub->header.vtable = NULL;
  sn_gc_set_type(sub, SN_TYPEID_CLASS_BASE + 1);

  assert(sn_is_instance(sub, SN_TYPEID_CLASS_BASE + 1));
  assert(sn_is_instance(sub, SN_TYPEID_CLASS_BASE));
  assert(!sn_is_instance(sub, SN_TYPEID_CLASS_BASE + 2));
  assert(!sn_is_instance(NULL, SN_TYPEID_CLASS_BASE));
}

static void test_gc_unreachable(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  int64_t before = sn_gc_bytes_allocated();
  void *a = sn_alloc(64);
  sn_gc_set_type(a, 0);
  assert(sn_gc_bytes_allocated() >= before + 64);
  /* Never rooted → collect should free. */
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);
}

static void test_gc_rooted_survives(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  void *obj = NULL;
  sn_gc_root_push(&obj);
  obj = sn_alloc(128);
  sn_gc_set_type(obj, 0);
  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  assert(obj != NULL);
  obj = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid - 128);
  sn_gc_root_pop(1);
}

static void test_gc_cycle(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  static const SnFieldInfo cycle_fields[] = {
      {.offset = 16, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
  };
  static const SnTypeInfo cycle_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 1,
      .kind = SN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = cycle_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&cycle_ti);

  void *a = NULL;
  void *b = NULL;
  sn_gc_root_push(&a);
  sn_gc_root_push(&b);

  a = sn_alloc(24);
  b = sn_alloc(24);
  sn_gc_set_type(a, SN_TYPEID_CLASS_BASE + 1);
  sn_gc_set_type(b, SN_TYPEID_CLASS_BASE + 1);
  ((SnObjectHeader *)a)->type_id = SN_TYPEID_CLASS_BASE + 1;
  ((SnObjectHeader *)b)->type_id = SN_TYPEID_CLASS_BASE + 1;
  ((SnObjectHeader *)a)->vtable = NULL;
  ((SnObjectHeader *)b)->vtable = NULL;
  /* friend field at offset 16 */
  *(void **)((char *)a + 16) = b;
  *(void **)((char *)b + 16) = a;

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);

  a = NULL;
  b = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid - 48);
  sn_gc_root_pop(2);
}

static void test_gc_array_keeps_elements(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  void *arr = NULL;
  sn_gc_root_push(&arr);

  arr = sn_array_new(0, 4, (int64_t)sizeof(void *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, 0, (int64_t)sizeof(void *));

  void *elem = sn_alloc(32);
  sn_gc_set_type(elem, 0);
  sn_array_push(arr, &elem, (int64_t)sizeof(void *));

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);

  arr = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

static void test_gc_threshold(void) {
  sn_gc_collect();
  sn_gc_set_threshold(64);
  /* Unrooted allocs that push past threshold should be collected on next alloc. */
  (void)sn_alloc(40);
  (void)sn_alloc(40);
  /* After second alloc, maybe_collect ran; at least some garbage should be gone. */
  void *keep = NULL;
  sn_gc_root_push(&keep);
  keep = sn_alloc(16);
  sn_gc_set_type(keep, 0);
  sn_gc_collect();
  assert(keep != NULL);
  keep = NULL;
  sn_gc_root_pop(1);
  sn_gc_set_threshold(0);
  sn_gc_collect();
}

static void test_gc_string_literal_root(void) {
  sn_gc_set_threshold(0);
  void *lit = (void *)"literal";
  sn_gc_root_push(&lit);
  sn_gc_collect(); /* must not free or crash */
  assert(strcmp((char *)lit, "literal") == 0);
  sn_gc_root_pop(1);
}

/* User { header, profile: Profile { name: string } } via nested AGG TypeInfo. */
static void test_gc_nested_struct_in_class(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo profile_fields[] = {
      {.offset = 0, .size = 8, .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_STRING},
  };
  static const SnTypeInfo profile_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 20,
      .kind = SN_KIND_STRUCT,
      .size = 8,
      .field_count = 1,
      .fields = profile_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  static const SnFieldInfo user_fields[] = {
      {.offset = 16, .size = 8, .ref_class = SN_REF_AGG, .type_id = SN_TYPEID_CLASS_BASE + 20},
  };
  static const SnTypeInfo user_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 21,
      .kind = SN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = user_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&profile_ti);
  sn_typeinfo_register(&user_ti);

  void *user = NULL;
  sn_gc_root_push(&user);
  user = sn_alloc(24);
  sn_gc_set_type(user, SN_TYPEID_CLASS_BASE + 21);
  ((SnObjectHeader *)user)->type_id = SN_TYPEID_CLASS_BASE + 21;
  ((SnObjectHeader *)user)->vtable = NULL;

  char *name = (char *)sn_alloc(6);
  memcpy(name, "hello", 6);
  sn_gc_set_type(name, SN_TYPEID_STRING);
  *(char **)((char *)user + 16) = name;

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  assert(strcmp(*(char **)((char *)user + 16), "hello") == 0);

  user = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

/* PersonData { name: string }[] scanned as AGG elements. */
static void test_gc_agg_array_elements(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo pdata_fields[] = {
      {.offset = 0, .size = 8, .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_STRING},
  };
  static const SnTypeInfo pdata_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 22,
      .kind = SN_KIND_STRUCT,
      .size = 8,
      .field_count = 1,
      .fields = pdata_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&pdata_ti);

  void *arr = NULL;
  sn_gc_root_push(&arr);
  arr = sn_array_new(0, 2, 8);
  sn_gc_set_array_meta(arr, SN_REF_AGG, SN_TYPEID_CLASS_BASE + 22, 8);

  char *name = (char *)sn_alloc(4);
  memcpy(name, "ab", 3);
  sn_gc_set_type(name, SN_TYPEID_STRING);

  char elem_buf[8];
  *(char **)elem_buf = name;
  sn_array_push(arr, elem_buf, 8);

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  SnArray *header = (SnArray *)arr;
  assert(strcmp(*(char **)header->data, "ab") == 0);

  arr = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

static void test_gc_map_keeps_entries(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  void *map = NULL;
  sn_gc_root_push(&map);
  map = sn_map_new();
  sn_gc_set_map_meta(map, SN_REF_PTR, SN_TYPEID_STRING, SN_REF_PTR, 0);

  char *key = (char *)sn_alloc(4);
  memcpy(key, "k", 2);
  sn_gc_set_type(key, SN_TYPEID_STRING);

  void *val = sn_alloc(16);
  sn_gc_set_type(val, 0);
  sn_map_set(map, key, val);

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  assert(sn_map_get(map, "k") == val);

  map = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

/* Closure env with PTR to Person keeps Person alive. */
static void test_gc_closure_env_keeps_capture(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo person_fields[] = {
      {.offset = 16, .size = 8, .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_STRING},
  };
  static const SnTypeInfo person_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 23,
      .kind = SN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = person_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  static const SnFieldInfo env_fields[] = {
      {.offset = 0, .size = 8, .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_CLASS_BASE + 23},
  };
  static const SnTypeInfo env_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 24,
      .kind = SN_KIND_ENV,
      .size = 8,
      .field_count = 1,
      .fields = env_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&person_ti);
  sn_typeinfo_register(&env_ti);

  void *env = NULL;
  sn_gc_root_push(&env);
  env = sn_alloc(8);
  sn_gc_set_type(env, SN_TYPEID_CLASS_BASE + 24);

  void *person = sn_alloc(24);
  sn_gc_set_type(person, SN_TYPEID_CLASS_BASE + 23);
  ((SnObjectHeader *)person)->type_id = SN_TYPEID_CLASS_BASE + 23;
  ((SnObjectHeader *)person)->vtable = NULL;
  char *name = (char *)sn_alloc(3);
  memcpy(name, "p", 2);
  sn_gc_set_type(name, SN_TYPEID_STRING);
  *(char **)((char *)person + 16) = name;
  *(void **)env = person;

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);

  env = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

/* Mutable capture box: TypeInfo scans interior Person*. */
static void test_gc_mutable_box_scans_interior(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo box_fields[] = {
      {.offset = 0, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
  };
  static const SnTypeInfo box_ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 25,
      .kind = SN_KIND_STRUCT,
      .size = 8,
      .field_count = 1,
      .fields = box_fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&box_ti);

  void *box = NULL;
  sn_gc_root_push(&box);
  box = sn_alloc(8);
  sn_gc_set_type(box, SN_TYPEID_CLASS_BASE + 25);

  void *person = sn_alloc(24);
  sn_gc_set_type(person, 0);
  *(void **)box = person;

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  assert(*(void **)box == person);

  box = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

/* Error-like class: ObjectHeader + message PTR + payload PTR. */
static void *gc_test_exception_slot = NULL;

static void register_error_with_payload_type(void) {
  static const SnFieldInfo fields[] = {
      {.offset = 16, .size = 8, .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_STRING},
      {.offset = 24, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
  };
  static const SnTypeInfo ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 30,
      .kind = SN_KIND_CLASS,
      .size = 32,
      .field_count = 2,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&ti);
}

static void *make_error_with_payload(void *payload) {
  void *err = sn_alloc(32);
  sn_gc_set_type(err, SN_TYPEID_CLASS_BASE + 30);
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE + 30;
  ((SnObjectHeader *)err)->vtable = NULL;
  char *msg = (char *)sn_alloc(6);
  memcpy(msg, "boom", 5);
  sn_gc_set_type(msg, SN_TYPEID_STRING);
  *(char **)((char *)err + 16) = msg;
  *(void **)((char *)err + 24) = payload;
  return err;
}

/* Pending exception root keeps Error + nested payload alive across GC. */
static void test_gc_pending_exception_keeps_payload(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  register_error_with_payload_type();

  void *payload = sn_alloc(64);
  sn_gc_set_type(payload, 0);
  gc_test_exception_slot = make_error_with_payload(payload);
  sn_gc_set_exception_root(&gc_test_exception_slot);

  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  assert(*(void **)((char *)gc_test_exception_slot + 24) == payload);

  gc_test_exception_slot = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
}

/* Catch local root keeps exception after TLS is cleared. */
static void test_gc_caught_exception_local_root(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  register_error_with_payload_type();

  void *payload = sn_alloc(32);
  sn_gc_set_type(payload, 0);
  gc_test_exception_slot = make_error_with_payload(payload);
  sn_gc_set_exception_root(&gc_test_exception_slot);

  void *caught = NULL;
  sn_gc_root_push(&caught);
  caught = gc_test_exception_slot;
  gc_test_exception_slot = NULL; /* clear pending exception */
  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);
  assert(*(void **)((char *)caught + 24) == payload);

  caught = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

static void throw_with_rooted_local(void) {
  void *local = NULL;
  sn_gc_root_push(&local);
  local = sn_alloc(48);
  sn_gc_set_type(local, 0);
  void *payload = sn_alloc(16);
  sn_gc_set_type(payload, 0);
  void *err = make_error_with_payload(payload);
  sn_throw(err);
}

/* Cross-frame throw restores shadow-stack roots; GC during catch is safe. */
static void test_gc_exception_unwind_restores_roots(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  register_error_with_payload_type();

  void *outer = NULL;
  void *caught = NULL;
  sn_gc_root_push(&outer);
  sn_gc_root_push(&caught);
  outer = sn_alloc(24);
  sn_gc_set_type(outer, 0);
  memset(outer, 0xAB, 24);

  char frame[SN_EH_FRAME_SIZE];
  sn_eh_init_frame(frame, 1, NULL, NULL);
  sn_eh_push(frame);

  if (setjmp(*sn_eh_jmp_buf(frame)) == 0) {
    throw_with_rooted_local();
    assert(0 && "should not return");
  } else {
    caught = sn_eh_caught_exception();
    sn_eh_clear_exception();
    sn_eh_pop(frame);

    /* Abandoned callee locals may be freed; outer + caught graph must survive. */
    sn_gc_collect();
    assert(caught != NULL);
    assert(*(unsigned char *)outer == 0xAB);
    assert(*(void **)((char *)caught + 24) != NULL);
    int64_t mid = sn_gc_bytes_allocated();
    sn_gc_collect();
    assert(sn_gc_bytes_allocated() == mid);
  }

  caught = NULL;
  outer = NULL;
  sn_gc_collect();
  sn_gc_root_pop(2);
}

static int32_t finally_ran = 0;

static void finally_thunk(void *ctx) {
  (void)ctx;
  finally_ran = 1;
  sn_gc_collect(); /* GC during finally-only unwind must be safe */
}

static void throw_through_finally(void) {
  void *local = NULL;
  sn_gc_root_push(&local);
  local = sn_alloc(40);
  sn_gc_set_type(local, 0);
  void *err = make_error_with_payload(NULL);
  sn_throw(err);
}

/* Finally-only frames restore roots before finally runs; outer catch still works. */
static void test_gc_during_finally_unwind(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  register_error_with_payload_type();
  finally_ran = 0;

  void *caught = NULL;
  sn_gc_root_push(&caught);

  char catch_frame[SN_EH_FRAME_SIZE];
  char finally_frame[SN_EH_FRAME_SIZE];
  sn_eh_init_frame(catch_frame, 1, NULL, NULL);
  sn_eh_push(catch_frame);

  if (setjmp(*sn_eh_jmp_buf(catch_frame)) == 0) {
    sn_eh_init_frame(finally_frame, 0, finally_thunk, NULL);
    sn_eh_push(finally_frame);
    throw_through_finally();
    assert(0);
  } else {
    assert(finally_ran == 1);
    caught = sn_eh_caught_exception();
    sn_eh_clear_exception();
    sn_eh_pop(catch_frame);
    sn_gc_collect();
    assert(caught != NULL);
  }

  caught = NULL;
  sn_gc_collect();
  sn_gc_root_pop(1);
}

/* After catch clears TLS and drops local, exception graph is reclaimed. */
static void test_gc_unreachable_after_exception_cleared(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  register_error_with_payload_type();

  int64_t before = sn_gc_bytes_allocated();
  sn_gc_set_exception_root(&gc_test_exception_slot);
  void *payload = sn_alloc(20);
  sn_gc_set_type(payload, 0);
  gc_test_exception_slot = make_error_with_payload(payload);

  void *caught = NULL;
  sn_gc_root_push(&caught);
  caught = gc_test_exception_slot;
  gc_test_exception_slot = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() > before);

  caught = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);
  sn_gc_root_pop(1);
}

/* Long-lived global root survives many GC cycles. */
static void test_gc_global_root_survives_cycles(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static void *global_obj = NULL;
  sn_gc_add_global_root(&global_obj);
  global_obj = sn_alloc(64);
  sn_gc_set_type(global_obj, 0);
  memset(global_obj, 0x5A, 64);
  int64_t mid = sn_gc_bytes_allocated();

  for (int i = 0; i < 20; i += 1) {
    void *junk = sn_alloc(32);
    sn_gc_set_type(junk, 0);
    (void)junk;
    sn_gc_collect();
    assert(sn_gc_bytes_allocated() == mid);
    assert(*(unsigned char *)global_obj == 0x5A);
  }

  global_obj = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid - 64);
}

/* Rooted object graph survives repeated collection; fields stay intact. */
static void test_gc_repeated_cycles_preserve_survivors(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo fields[] = {
      {.offset = 16, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
  };
  static const SnTypeInfo ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 31,
      .kind = SN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&ti);

  void *a = NULL;
  sn_gc_root_push(&a);
  a = sn_alloc(24);
  sn_gc_set_type(a, SN_TYPEID_CLASS_BASE + 31);
  ((SnObjectHeader *)a)->type_id = SN_TYPEID_CLASS_BASE + 31;
  ((SnObjectHeader *)a)->vtable = NULL;
  void *b = sn_alloc(24);
  sn_gc_set_type(b, 0);
  *(void **)((char *)a + 16) = b;
  int64_t mid = sn_gc_bytes_allocated();

  for (int i = 0; i < 15; i += 1) {
    sn_gc_collect();
    assert(sn_gc_bytes_allocated() == mid);
    assert(*(void **)((char *)a + 16) == b);
  }

  a = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() < mid);
  sn_gc_root_pop(1);
}

/* Unreachable chain A→B→C is fully reclaimed. */
static void test_gc_unreachable_chain(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo fields[] = {
      {.offset = 0, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
  };
  static const SnTypeInfo ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 32,
      .kind = SN_KIND_CLASS,
      .size = 8,
      .field_count = 1,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&ti);

  int64_t before = sn_gc_bytes_allocated();
  void *a = NULL;
  sn_gc_root_push(&a);
  a = sn_alloc(8);
  sn_gc_set_type(a, SN_TYPEID_CLASS_BASE + 32);
  void *b = sn_alloc(8);
  sn_gc_set_type(b, SN_TYPEID_CLASS_BASE + 32);
  void *c = sn_alloc(8);
  sn_gc_set_type(c, SN_TYPEID_CLASS_BASE + 32);
  *(void **)a = b;
  *(void **)b = c;
  *(void **)c = NULL;

  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before + 24);

  a = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);
  sn_gc_root_pop(1);
}

/* Large unreachable graph is reclaimed without crash. */
static void test_gc_large_unreachable_graph(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  static const SnFieldInfo fields[] = {
      {.offset = 0, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
      {.offset = 8, .size = 8, .ref_class = SN_REF_PTR, .type_id = 0},
  };
  static const SnTypeInfo ti = {
      .type_id = SN_TYPEID_CLASS_BASE + 33,
      .kind = SN_KIND_CLASS,
      .size = 16,
      .field_count = 2,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = SN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = SN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = SN_REF_VALUE,
  };
  sn_typeinfo_register(&ti);

  int64_t before = sn_gc_bytes_allocated();
  void *root = NULL;
  sn_gc_root_push(&root);
  root = sn_alloc(16);
  sn_gc_set_type(root, SN_TYPEID_CLASS_BASE + 33);
  void *prev = root;
  for (int i = 0; i < 64; i += 1) {
    void *n = sn_alloc(16);
    sn_gc_set_type(n, SN_TYPEID_CLASS_BASE + 33);
    *(void **)prev = n;
    *((void **)prev + 1) = NULL;
    prev = n;
  }
  *(void **)prev = NULL;
  *((void **)prev + 1) = NULL;

  int64_t mid = sn_gc_bytes_allocated();
  assert(mid > before);
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);

  root = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);
  sn_gc_root_pop(1);
}

/* Reassignment drops the previous object. */
static void test_gc_unreachable_after_reassignment(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();

  void *obj = NULL;
  sn_gc_root_push(&obj);
  obj = sn_alloc(80);
  sn_gc_set_type(obj, 0);
  int64_t mid = sn_gc_bytes_allocated();
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid);

  obj = sn_alloc(16);
  sn_gc_set_type(obj, 0);
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == mid - 80 + 16);

  obj = NULL;
  sn_gc_collect();
  sn_gc_root_pop(1);
}

/* Scope exit (root_pop) makes locals unreachable. */
static void test_gc_unreachable_after_scope_exit(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  int64_t before = sn_gc_bytes_allocated();

  {
    void *local = NULL;
    sn_gc_root_push(&local);
    local = sn_alloc(56);
    sn_gc_set_type(local, 0);
    sn_gc_collect();
    assert(sn_gc_bytes_allocated() == before + 56);
    local = NULL;
    sn_gc_root_pop(1);
  }

  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);
}

/* Allocation after GC is tracked and later collectable. */
static void test_gc_alloc_after_collect(void) {
  sn_gc_set_threshold(0);
  sn_gc_collect();
  int64_t before = sn_gc_bytes_allocated();

  void *a = sn_alloc(32);
  sn_gc_set_type(a, 0);
  (void)a;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);

  void *b = NULL;
  sn_gc_root_push(&b);
  b = sn_alloc(48);
  sn_gc_set_type(b, 0);
  assert(sn_gc_bytes_allocated() == before + 48);
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before + 48);

  b = NULL;
  sn_gc_collect();
  assert(sn_gc_bytes_allocated() == before);
  sn_gc_root_pop(1);
}

/* Root checkpoint/restore drops abandoned slots without under/overflow. */
static void test_gc_root_checkpoint_restore(void) {
  void *a = NULL;
  void *b = NULL;
  sn_gc_root_push(&a);
  int32_t cp = sn_gc_root_checkpoint();
  sn_gc_root_push(&b);
  a = sn_alloc(8);
  sn_gc_set_type(a, 0);
  b = sn_alloc(8);
  sn_gc_set_type(b, 0);
  sn_gc_root_restore(cp);
  /* b's root slot is gone; clearing a keeps only a if we re-push — just ensure restore works */
  sn_gc_collect();
  sn_gc_root_pop(1);
}

int main(void) {
  test_alloc();
  test_strings();
  test_arrays();
  test_maps();
  test_math();
  test_random();
  test_print_and_format();
  test_typeinfo();
  test_is_instance();
  test_gc_unreachable();
  test_gc_rooted_survives();
  test_gc_cycle();
  test_gc_array_keeps_elements();
  test_gc_threshold();
  test_gc_string_literal_root();
  test_gc_nested_struct_in_class();
  test_gc_agg_array_elements();
  test_gc_map_keeps_entries();
  test_gc_closure_env_keeps_capture();
  test_gc_mutable_box_scans_interior();
  test_gc_pending_exception_keeps_payload();
  test_gc_caught_exception_local_root();
  test_gc_exception_unwind_restores_roots();
  test_gc_during_finally_unwind();
  test_gc_unreachable_after_exception_cleared();
  test_gc_global_root_survives_cycles();
  test_gc_repeated_cycles_preserve_survivors();
  test_gc_unreachable_chain();
  test_gc_large_unreachable_graph();
  test_gc_unreachable_after_reassignment();
  test_gc_unreachable_after_scope_exit();
  test_gc_alloc_after_collect();
  test_gc_root_checkpoint_restore();
  return 0;
}
