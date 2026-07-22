#include <assert.h>
#include <setjmp.h>
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

static void test_gc_unreachable(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  int64_t before = tsn_gc_bytes_allocated();
  void *a = tsn_alloc(64);
  tsn_gc_set_type(a, 0);
  assert(tsn_gc_bytes_allocated() >= before + 64);
  /* Never rooted → collect should free. */
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);
}

static void test_gc_rooted_survives(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  void *obj = NULL;
  tsn_gc_root_push(&obj);
  obj = tsn_alloc(128);
  tsn_gc_set_type(obj, 0);
  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  assert(obj != NULL);
  obj = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid - 128);
  tsn_gc_root_pop(1);
}

static void test_gc_cycle(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  static const TsnFieldInfo cycle_fields[] = {
      {.offset = 16, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
  };
  static const TsnTypeInfo cycle_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 1,
      .kind = TSN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = cycle_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&cycle_ti);

  void *a = NULL;
  void *b = NULL;
  tsn_gc_root_push(&a);
  tsn_gc_root_push(&b);

  a = tsn_alloc(24);
  b = tsn_alloc(24);
  tsn_gc_set_type(a, TSN_TYPEID_CLASS_BASE + 1);
  tsn_gc_set_type(b, TSN_TYPEID_CLASS_BASE + 1);
  ((TsnObjectHeader *)a)->type_id = TSN_TYPEID_CLASS_BASE + 1;
  ((TsnObjectHeader *)b)->type_id = TSN_TYPEID_CLASS_BASE + 1;
  ((TsnObjectHeader *)a)->vtable = NULL;
  ((TsnObjectHeader *)b)->vtable = NULL;
  /* friend field at offset 16 */
  *(void **)((char *)a + 16) = b;
  *(void **)((char *)b + 16) = a;

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);

  a = NULL;
  b = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid - 48);
  tsn_gc_root_pop(2);
}

static void test_gc_array_keeps_elements(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  void *arr = NULL;
  tsn_gc_root_push(&arr);

  arr = tsn_array_new(0, 4, (int64_t)sizeof(void *));
  tsn_gc_set_array_meta(arr, TSN_REF_PTR, 0, (int64_t)sizeof(void *));

  void *elem = tsn_alloc(32);
  tsn_gc_set_type(elem, 0);
  tsn_array_push(arr, &elem, (int64_t)sizeof(void *));

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);

  arr = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

static void test_gc_threshold(void) {
  tsn_gc_collect();
  tsn_gc_set_threshold(64);
  /* Unrooted allocs that push past threshold should be collected on next alloc. */
  (void)tsn_alloc(40);
  (void)tsn_alloc(40);
  /* After second alloc, maybe_collect ran; at least some garbage should be gone. */
  void *keep = NULL;
  tsn_gc_root_push(&keep);
  keep = tsn_alloc(16);
  tsn_gc_set_type(keep, 0);
  tsn_gc_collect();
  assert(keep != NULL);
  keep = NULL;
  tsn_gc_root_pop(1);
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
}

static void test_gc_string_literal_root(void) {
  tsn_gc_set_threshold(0);
  void *lit = (void *)"literal";
  tsn_gc_root_push(&lit);
  tsn_gc_collect(); /* must not free or crash */
  assert(strcmp((char *)lit, "literal") == 0);
  tsn_gc_root_pop(1);
}

/* User { header, profile: Profile { name: string } } via nested AGG TypeInfo. */
static void test_gc_nested_struct_in_class(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo profile_fields[] = {
      {.offset = 0, .size = 8, .ref_class = TSN_REF_PTR, .type_id = TSN_TYPEID_STRING},
  };
  static const TsnTypeInfo profile_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 20,
      .kind = TSN_KIND_STRUCT,
      .size = 8,
      .field_count = 1,
      .fields = profile_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  static const TsnFieldInfo user_fields[] = {
      {.offset = 16, .size = 8, .ref_class = TSN_REF_AGG, .type_id = TSN_TYPEID_CLASS_BASE + 20},
  };
  static const TsnTypeInfo user_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 21,
      .kind = TSN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = user_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&profile_ti);
  tsn_typeinfo_register(&user_ti);

  void *user = NULL;
  tsn_gc_root_push(&user);
  user = tsn_alloc(24);
  tsn_gc_set_type(user, TSN_TYPEID_CLASS_BASE + 21);
  ((TsnObjectHeader *)user)->type_id = TSN_TYPEID_CLASS_BASE + 21;
  ((TsnObjectHeader *)user)->vtable = NULL;

  char *name = (char *)tsn_alloc(6);
  memcpy(name, "hello", 6);
  tsn_gc_set_type(name, TSN_TYPEID_STRING);
  *(char **)((char *)user + 16) = name;

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  assert(strcmp(*(char **)((char *)user + 16), "hello") == 0);

  user = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

/* PersonData { name: string }[] scanned as AGG elements. */
static void test_gc_agg_array_elements(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo pdata_fields[] = {
      {.offset = 0, .size = 8, .ref_class = TSN_REF_PTR, .type_id = TSN_TYPEID_STRING},
  };
  static const TsnTypeInfo pdata_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 22,
      .kind = TSN_KIND_STRUCT,
      .size = 8,
      .field_count = 1,
      .fields = pdata_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&pdata_ti);

  void *arr = NULL;
  tsn_gc_root_push(&arr);
  arr = tsn_array_new(0, 2, 8);
  tsn_gc_set_array_meta(arr, TSN_REF_AGG, TSN_TYPEID_CLASS_BASE + 22, 8);

  char *name = (char *)tsn_alloc(4);
  memcpy(name, "ab", 3);
  tsn_gc_set_type(name, TSN_TYPEID_STRING);

  char elem_buf[8];
  *(char **)elem_buf = name;
  tsn_array_push(arr, elem_buf, 8);

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  TsnArray *header = (TsnArray *)arr;
  assert(strcmp(*(char **)header->data, "ab") == 0);

  arr = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

static void test_gc_map_keeps_entries(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  void *map = NULL;
  tsn_gc_root_push(&map);
  map = tsn_map_new();
  tsn_gc_set_map_meta(map, TSN_REF_PTR, TSN_TYPEID_STRING, TSN_REF_PTR, 0);

  char *key = (char *)tsn_alloc(4);
  memcpy(key, "k", 2);
  tsn_gc_set_type(key, TSN_TYPEID_STRING);

  void *val = tsn_alloc(16);
  tsn_gc_set_type(val, 0);
  tsn_map_set(map, key, val);

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  assert(tsn_map_get(map, "k") == val);

  map = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

/* Closure env with PTR to Person keeps Person alive. */
static void test_gc_closure_env_keeps_capture(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo person_fields[] = {
      {.offset = 16, .size = 8, .ref_class = TSN_REF_PTR, .type_id = TSN_TYPEID_STRING},
  };
  static const TsnTypeInfo person_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 23,
      .kind = TSN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = person_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  static const TsnFieldInfo env_fields[] = {
      {.offset = 0, .size = 8, .ref_class = TSN_REF_PTR, .type_id = TSN_TYPEID_CLASS_BASE + 23},
  };
  static const TsnTypeInfo env_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 24,
      .kind = TSN_KIND_ENV,
      .size = 8,
      .field_count = 1,
      .fields = env_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&person_ti);
  tsn_typeinfo_register(&env_ti);

  void *env = NULL;
  tsn_gc_root_push(&env);
  env = tsn_alloc(8);
  tsn_gc_set_type(env, TSN_TYPEID_CLASS_BASE + 24);

  void *person = tsn_alloc(24);
  tsn_gc_set_type(person, TSN_TYPEID_CLASS_BASE + 23);
  ((TsnObjectHeader *)person)->type_id = TSN_TYPEID_CLASS_BASE + 23;
  ((TsnObjectHeader *)person)->vtable = NULL;
  char *name = (char *)tsn_alloc(3);
  memcpy(name, "p", 2);
  tsn_gc_set_type(name, TSN_TYPEID_STRING);
  *(char **)((char *)person + 16) = name;
  *(void **)env = person;

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);

  env = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

/* Mutable capture box: TypeInfo scans interior Person*. */
static void test_gc_mutable_box_scans_interior(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo box_fields[] = {
      {.offset = 0, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
  };
  static const TsnTypeInfo box_ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 25,
      .kind = TSN_KIND_STRUCT,
      .size = 8,
      .field_count = 1,
      .fields = box_fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&box_ti);

  void *box = NULL;
  tsn_gc_root_push(&box);
  box = tsn_alloc(8);
  tsn_gc_set_type(box, TSN_TYPEID_CLASS_BASE + 25);

  void *person = tsn_alloc(24);
  tsn_gc_set_type(person, 0);
  *(void **)box = person;

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  assert(*(void **)box == person);

  box = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

/* Error-like class: ObjectHeader + message PTR + payload PTR. */
static void *gc_test_exception_slot = NULL;

static void register_error_with_payload_type(void) {
  static const TsnFieldInfo fields[] = {
      {.offset = 16, .size = 8, .ref_class = TSN_REF_PTR, .type_id = TSN_TYPEID_STRING},
      {.offset = 24, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
  };
  static const TsnTypeInfo ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 30,
      .kind = TSN_KIND_CLASS,
      .size = 32,
      .field_count = 2,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&ti);
}

static void *make_error_with_payload(void *payload) {
  void *err = tsn_alloc(32);
  tsn_gc_set_type(err, TSN_TYPEID_CLASS_BASE + 30);
  ((TsnObjectHeader *)err)->type_id = TSN_TYPEID_CLASS_BASE + 30;
  ((TsnObjectHeader *)err)->vtable = NULL;
  char *msg = (char *)tsn_alloc(6);
  memcpy(msg, "boom", 5);
  tsn_gc_set_type(msg, TSN_TYPEID_STRING);
  *(char **)((char *)err + 16) = msg;
  *(void **)((char *)err + 24) = payload;
  return err;
}

/* Pending exception root keeps Error + nested payload alive across GC. */
static void test_gc_pending_exception_keeps_payload(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  register_error_with_payload_type();

  void *payload = tsn_alloc(64);
  tsn_gc_set_type(payload, 0);
  gc_test_exception_slot = make_error_with_payload(payload);
  tsn_gc_set_exception_root(&gc_test_exception_slot);

  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  assert(*(void **)((char *)gc_test_exception_slot + 24) == payload);

  gc_test_exception_slot = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
}

/* Catch local root keeps exception after TLS is cleared. */
static void test_gc_caught_exception_local_root(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  register_error_with_payload_type();

  void *payload = tsn_alloc(32);
  tsn_gc_set_type(payload, 0);
  gc_test_exception_slot = make_error_with_payload(payload);
  tsn_gc_set_exception_root(&gc_test_exception_slot);

  void *caught = NULL;
  tsn_gc_root_push(&caught);
  caught = gc_test_exception_slot;
  gc_test_exception_slot = NULL; /* clear pending exception */
  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);
  assert(*(void **)((char *)caught + 24) == payload);

  caught = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

static void throw_with_rooted_local(void) {
  void *local = NULL;
  tsn_gc_root_push(&local);
  local = tsn_alloc(48);
  tsn_gc_set_type(local, 0);
  void *payload = tsn_alloc(16);
  tsn_gc_set_type(payload, 0);
  void *err = make_error_with_payload(payload);
  tsn_throw(err);
}

/* Cross-frame throw restores shadow-stack roots; GC during catch is safe. */
static void test_gc_exception_unwind_restores_roots(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  register_error_with_payload_type();

  void *outer = NULL;
  void *caught = NULL;
  tsn_gc_root_push(&outer);
  tsn_gc_root_push(&caught);
  outer = tsn_alloc(24);
  tsn_gc_set_type(outer, 0);
  memset(outer, 0xAB, 24);

  char frame[TSN_EH_FRAME_SIZE];
  tsn_eh_init_frame(frame, 1, NULL, NULL);
  tsn_eh_push(frame);

  if (setjmp(*tsn_eh_jmp_buf(frame)) == 0) {
    throw_with_rooted_local();
    assert(0 && "should not return");
  } else {
    caught = tsn_eh_caught_exception();
    tsn_eh_clear_exception();
    tsn_eh_pop(frame);

    /* Abandoned callee locals may be freed; outer + caught graph must survive. */
    tsn_gc_collect();
    assert(caught != NULL);
    assert(*(unsigned char *)outer == 0xAB);
    assert(*(void **)((char *)caught + 24) != NULL);
    int64_t mid = tsn_gc_bytes_allocated();
    tsn_gc_collect();
    assert(tsn_gc_bytes_allocated() == mid);
  }

  caught = NULL;
  outer = NULL;
  tsn_gc_collect();
  tsn_gc_root_pop(2);
}

static int32_t finally_ran = 0;

static void finally_thunk(void *ctx) {
  (void)ctx;
  finally_ran = 1;
  tsn_gc_collect(); /* GC during finally-only unwind must be safe */
}

static void throw_through_finally(void) {
  void *local = NULL;
  tsn_gc_root_push(&local);
  local = tsn_alloc(40);
  tsn_gc_set_type(local, 0);
  void *err = make_error_with_payload(NULL);
  tsn_throw(err);
}

/* Finally-only frames restore roots before finally runs; outer catch still works. */
static void test_gc_during_finally_unwind(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  register_error_with_payload_type();
  finally_ran = 0;

  void *caught = NULL;
  tsn_gc_root_push(&caught);

  char catch_frame[TSN_EH_FRAME_SIZE];
  char finally_frame[TSN_EH_FRAME_SIZE];
  tsn_eh_init_frame(catch_frame, 1, NULL, NULL);
  tsn_eh_push(catch_frame);

  if (setjmp(*tsn_eh_jmp_buf(catch_frame)) == 0) {
    tsn_eh_init_frame(finally_frame, 0, finally_thunk, NULL);
    tsn_eh_push(finally_frame);
    throw_through_finally();
    assert(0);
  } else {
    assert(finally_ran == 1);
    caught = tsn_eh_caught_exception();
    tsn_eh_clear_exception();
    tsn_eh_pop(catch_frame);
    tsn_gc_collect();
    assert(caught != NULL);
  }

  caught = NULL;
  tsn_gc_collect();
  tsn_gc_root_pop(1);
}

/* After catch clears TLS and drops local, exception graph is reclaimed. */
static void test_gc_unreachable_after_exception_cleared(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  register_error_with_payload_type();

  int64_t before = tsn_gc_bytes_allocated();
  tsn_gc_set_exception_root(&gc_test_exception_slot);
  void *payload = tsn_alloc(20);
  tsn_gc_set_type(payload, 0);
  gc_test_exception_slot = make_error_with_payload(payload);

  void *caught = NULL;
  tsn_gc_root_push(&caught);
  caught = gc_test_exception_slot;
  gc_test_exception_slot = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() > before);

  caught = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);
  tsn_gc_root_pop(1);
}

/* Long-lived global root survives many GC cycles. */
static void test_gc_global_root_survives_cycles(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static void *global_obj = NULL;
  tsn_gc_add_global_root(&global_obj);
  global_obj = tsn_alloc(64);
  tsn_gc_set_type(global_obj, 0);
  memset(global_obj, 0x5A, 64);
  int64_t mid = tsn_gc_bytes_allocated();

  for (int i = 0; i < 20; i += 1) {
    void *junk = tsn_alloc(32);
    tsn_gc_set_type(junk, 0);
    (void)junk;
    tsn_gc_collect();
    assert(tsn_gc_bytes_allocated() == mid);
    assert(*(unsigned char *)global_obj == 0x5A);
  }

  global_obj = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid - 64);
}

/* Rooted object graph survives repeated collection; fields stay intact. */
static void test_gc_repeated_cycles_preserve_survivors(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo fields[] = {
      {.offset = 16, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
  };
  static const TsnTypeInfo ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 31,
      .kind = TSN_KIND_CLASS,
      .size = 24,
      .field_count = 1,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&ti);

  void *a = NULL;
  tsn_gc_root_push(&a);
  a = tsn_alloc(24);
  tsn_gc_set_type(a, TSN_TYPEID_CLASS_BASE + 31);
  ((TsnObjectHeader *)a)->type_id = TSN_TYPEID_CLASS_BASE + 31;
  ((TsnObjectHeader *)a)->vtable = NULL;
  void *b = tsn_alloc(24);
  tsn_gc_set_type(b, 0);
  *(void **)((char *)a + 16) = b;
  int64_t mid = tsn_gc_bytes_allocated();

  for (int i = 0; i < 15; i += 1) {
    tsn_gc_collect();
    assert(tsn_gc_bytes_allocated() == mid);
    assert(*(void **)((char *)a + 16) == b);
  }

  a = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() < mid);
  tsn_gc_root_pop(1);
}

/* Unreachable chain A→B→C is fully reclaimed. */
static void test_gc_unreachable_chain(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo fields[] = {
      {.offset = 0, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
  };
  static const TsnTypeInfo ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 32,
      .kind = TSN_KIND_CLASS,
      .size = 8,
      .field_count = 1,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&ti);

  int64_t before = tsn_gc_bytes_allocated();
  void *a = NULL;
  tsn_gc_root_push(&a);
  a = tsn_alloc(8);
  tsn_gc_set_type(a, TSN_TYPEID_CLASS_BASE + 32);
  void *b = tsn_alloc(8);
  tsn_gc_set_type(b, TSN_TYPEID_CLASS_BASE + 32);
  void *c = tsn_alloc(8);
  tsn_gc_set_type(c, TSN_TYPEID_CLASS_BASE + 32);
  *(void **)a = b;
  *(void **)b = c;
  *(void **)c = NULL;

  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before + 24);

  a = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);
  tsn_gc_root_pop(1);
}

/* Large unreachable graph is reclaimed without crash. */
static void test_gc_large_unreachable_graph(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  static const TsnFieldInfo fields[] = {
      {.offset = 0, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
      {.offset = 8, .size = 8, .ref_class = TSN_REF_PTR, .type_id = 0},
  };
  static const TsnTypeInfo ti = {
      .type_id = TSN_TYPEID_CLASS_BASE + 33,
      .kind = TSN_KIND_CLASS,
      .size = 16,
      .field_count = 2,
      .fields = fields,
      .elem_type_id = 0,
      .elem_ref_class = TSN_REF_VALUE,
      .key_type_id = 0,
      .key_ref_class = TSN_REF_VALUE,
      .value_type_id = 0,
      .value_ref_class = TSN_REF_VALUE,
  };
  tsn_typeinfo_register(&ti);

  int64_t before = tsn_gc_bytes_allocated();
  void *root = NULL;
  tsn_gc_root_push(&root);
  root = tsn_alloc(16);
  tsn_gc_set_type(root, TSN_TYPEID_CLASS_BASE + 33);
  void *prev = root;
  for (int i = 0; i < 64; i += 1) {
    void *n = tsn_alloc(16);
    tsn_gc_set_type(n, TSN_TYPEID_CLASS_BASE + 33);
    *(void **)prev = n;
    *((void **)prev + 1) = NULL;
    prev = n;
  }
  *(void **)prev = NULL;
  *((void **)prev + 1) = NULL;

  int64_t mid = tsn_gc_bytes_allocated();
  assert(mid > before);
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);

  root = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);
  tsn_gc_root_pop(1);
}

/* Reassignment drops the previous object. */
static void test_gc_unreachable_after_reassignment(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();

  void *obj = NULL;
  tsn_gc_root_push(&obj);
  obj = tsn_alloc(80);
  tsn_gc_set_type(obj, 0);
  int64_t mid = tsn_gc_bytes_allocated();
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid);

  obj = tsn_alloc(16);
  tsn_gc_set_type(obj, 0);
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == mid - 80 + 16);

  obj = NULL;
  tsn_gc_collect();
  tsn_gc_root_pop(1);
}

/* Scope exit (root_pop) makes locals unreachable. */
static void test_gc_unreachable_after_scope_exit(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  int64_t before = tsn_gc_bytes_allocated();

  {
    void *local = NULL;
    tsn_gc_root_push(&local);
    local = tsn_alloc(56);
    tsn_gc_set_type(local, 0);
    tsn_gc_collect();
    assert(tsn_gc_bytes_allocated() == before + 56);
    local = NULL;
    tsn_gc_root_pop(1);
  }

  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);
}

/* Allocation after GC is tracked and later collectable. */
static void test_gc_alloc_after_collect(void) {
  tsn_gc_set_threshold(0);
  tsn_gc_collect();
  int64_t before = tsn_gc_bytes_allocated();

  void *a = tsn_alloc(32);
  tsn_gc_set_type(a, 0);
  (void)a;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);

  void *b = NULL;
  tsn_gc_root_push(&b);
  b = tsn_alloc(48);
  tsn_gc_set_type(b, 0);
  assert(tsn_gc_bytes_allocated() == before + 48);
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before + 48);

  b = NULL;
  tsn_gc_collect();
  assert(tsn_gc_bytes_allocated() == before);
  tsn_gc_root_pop(1);
}

/* Root checkpoint/restore drops abandoned slots without under/overflow. */
static void test_gc_root_checkpoint_restore(void) {
  void *a = NULL;
  void *b = NULL;
  tsn_gc_root_push(&a);
  int32_t cp = tsn_gc_root_checkpoint();
  tsn_gc_root_push(&b);
  a = tsn_alloc(8);
  tsn_gc_set_type(a, 0);
  b = tsn_alloc(8);
  tsn_gc_set_type(b, 0);
  tsn_gc_root_restore(cp);
  /* b's root slot is gone; clearing a keeps only a if we re-push — just ensure restore works */
  tsn_gc_collect();
  tsn_gc_root_pop(1);
}

int main(void) {
  test_alloc();
  test_strings();
  test_arrays();
  test_maps();
  test_print_and_format();
  test_typeinfo();
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
