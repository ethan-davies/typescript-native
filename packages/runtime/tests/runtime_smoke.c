#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "tsn/runtime.h"

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

int main(void) {
  test_strings();
  test_arrays();
  test_maps();
  test_print_and_format();
  return 0;
}
