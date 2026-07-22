#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "tsn/runtime.h"

static void test_alloc(void) {
  assert(sizeof(TsnArray) == TSN_ARRAY_HEADER_SIZE);
  assert(sizeof(TsnMap) == TSN_MAP_HEADER_SIZE);
  /* LP64: i32 type_id, 4-byte pad, then vtable pointer → 16 bytes */
  assert(sizeof(TsnObjectHeader) == 16);
  assert(offsetof(TsnObjectHeader, type_id) == 0);
  assert(offsetof(TsnObjectHeader, vtable) == 8);

  int32_t *buf = (int32_t *)tsn_alloc((int64_t)sizeof(int32_t) * 4);
  assert(buf != NULL);
  buf[0] = 42;
  buf = (int32_t *)tsn_realloc(buf, (int64_t)sizeof(int32_t) * 8);
  assert(buf != NULL);
  assert(buf[0] == 42);
  buf[7] = 99;
  assert(buf[7] == 99);
  tsn_free(buf);
}

static void test_strings(void) {
  char *joined = tsn_str_concat("Hello", " world");
  assert(strcmp(joined, "Hello world") == 0);
  assert(tsn_str_len(joined) == 11);
  tsn_free(joined);
}

static void test_arrays(void) {
  void *arr = tsn_array_new(0, 4, (int64_t)sizeof(int32_t));
  int32_t values[] = {1, 2, 3};
  for (int i = 0; i < 3; i += 1) {
    tsn_array_push(arr, &values[i], (int64_t)sizeof(int32_t));
  }
  assert(tsn_array_length(arr) == 3);

  int32_t needle = 2;
  assert(tsn_array_index_of(arr, &needle, (int64_t)sizeof(int32_t), TSN_CMP_I32) == 1);

  int32_t popped = 0;
  tsn_array_pop(arr, &popped, (int64_t)sizeof(int32_t));
  assert(popped == 3);
  assert(tsn_array_length(arr) == 2);
}

static void test_maps(void) {
  void *map = tsn_map_new();
  char *value_a = tsn_str_concat("first", "");
  char *value_b = tsn_str_concat("second", "");
  tsn_map_set(map, "alpha", value_a);
  tsn_map_set(map, "beta", value_b);
  assert(strcmp((char *)tsn_map_get(map, "alpha"), "first") == 0);

  char *replacement = tsn_str_concat("updated", "");
  tsn_map_set(map, "alpha", replacement);
  assert(strcmp((char *)tsn_map_get(map, "alpha"), "updated") == 0);

  for (int i = 0; i < 10; i += 1) {
    char key[16];
    snprintf(key, sizeof(key), "key-%d", i);
    char *val = tsn_str_concat("v", "");
    tsn_map_set(map, key, val);
  }
  assert(tsn_map_get(map, "key-9") != NULL);
}

static void test_print_and_format(void) {
  char *text = tsn_i32_to_string(42);
  assert(strcmp(text, "42") == 0);
  tsn_free(text);

  void *arr = tsn_array_new(0, 4, (int64_t)sizeof(int32_t));
  int32_t values[] = {1, 2, 3};
  for (int i = 0; i < 3; i += 1) {
    tsn_array_push(arr, &values[i], (int64_t)sizeof(int32_t));
  }
  char *arr_text = tsn_array_to_string(arr, (int64_t)sizeof(int32_t), TSN_FMT_I32);
  assert(strcmp(arr_text, "[1, 2, 3]") == 0);
  tsn_free(arr_text);

  tsn_print_str("runtime smoke");
  tsn_print_space();
  tsn_print_i32(1);
  tsn_print_newline();
}

static void test_typeinfo(void) {
  const TsnTypeInfo *string_ti = tsn_typeinfo_get(TSN_TYPEID_STRING);
  assert(string_ti != NULL);
  assert(string_ti->kind == TSN_KIND_STRING);
  assert(string_ti->size == -1);

  const TsnTypeInfo *array_ti = tsn_typeinfo_get(TSN_TYPEID_ARRAY);
  assert(array_ti != NULL);
  assert(array_ti->kind == TSN_KIND_ARRAY);
  assert(array_ti->size == (int32_t)sizeof(TsnArray));

  const TsnTypeInfo *map_ti = tsn_typeinfo_get(TSN_TYPEID_MAP);
  assert(map_ti != NULL);
  assert(map_ti->kind == TSN_KIND_MAP);
  assert(map_ti->key_ref_class == TSN_REF_PTR);
  assert(map_ti->value_ref_class == TSN_REF_PTR);

  const TsnTypeInfo *closure_ti = tsn_typeinfo_get(TSN_TYPEID_CLOSURE);
  assert(closure_ti != NULL);
  assert(closure_ti->kind == TSN_KIND_CLOSURE);
  assert(closure_ti->field_count == 2);
  assert(closure_ti->fields[1].ref_class == TSN_REF_PTR);

  const TsnTypeInfo *env_ti = tsn_typeinfo_get(TSN_TYPEID_ENV);
  assert(env_ti != NULL);
  assert(env_ti->kind == TSN_KIND_ENV);

  assert(tsn_typeinfo_get(TSN_TYPEID_CLASS_BASE) == NULL);

  static const TsnFieldInfo class_fields[] = {
      {.offset = 16, .size = 8, .ref_class = TSN_REF_PTR, .type_id = TSN_TYPEID_STRING},
  };
  static const TsnTypeInfo class_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE,
      .kind = TSN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = class_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&class_ti);
  const TsnTypeInfo *got = tsn_typeinfo_get(TSN_TYPEID_CLASS_BASE);
  assert(got == &class_ti);
  assert(got->field_count == 1);
  assert(got->fields[0].ref_class == TSN_REF_PTR);
}

int main(void) {
  test_alloc();
  test_strings();
  test_arrays();
  test_maps();
  test_print_and_format();
  test_typeinfo();
  return 0;
}
