#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "tsn/runtime.h"

static TsnArray *as_array(void *arr) {
  return (TsnArray *)arr;
}

static int64_t grow_capacity(int64_t capacity) {
  if (capacity == 0) {
    return 4;
  }
  return capacity * 2;
}

static bool values_equal(const void *left, const void *right, int32_t cmp_kind) {
  switch (cmp_kind) {
    case TSN_CMP_I32:
      return *(const int32_t *)left == *(const int32_t *)right;
    case TSN_CMP_I64:
      return *(const int64_t *)left == *(const int64_t *)right;
    case TSN_CMP_F32:
      return *(const float *)left == *(const float *)right;
    case TSN_CMP_F64:
      return *(const double *)left == *(const double *)right;
    case TSN_CMP_BOOL:
      return *(const bool *)left == *(const bool *)right;
    case TSN_CMP_CHAR:
      return *(const char *)left == *(const char *)right;
    case TSN_CMP_STRING:
      return strcmp(*(const char *const *)left, *(const char *const *)right) == 0;
    case TSN_CMP_PTR:
      return *(const void *const *)left == *(const void *const *)right;
    default:
      abort();
  }
}

void *tsn_array_new(int64_t length, int64_t capacity, int64_t elem_size) {
  if (length < 0 || capacity < length || elem_size <= 0) {
    abort();
  }
  if (capacity == 0 && length > 0) {
    capacity = length;
  }
  if (capacity == 0) {
    capacity = 4;
  }

  TsnArray *arr = tsn_alloc((int64_t)sizeof(TsnArray));
  arr->length = length;
  arr->capacity = capacity;
  arr->data = tsn_alloc(capacity * elem_size);
  return arr;
}

int32_t tsn_array_length(void *arr) {
  return (int32_t)as_array(arr)->length;
}

static void array_grow(TsnArray *arr, int64_t elem_size) {
  int64_t new_cap = grow_capacity(arr->capacity);
  arr->data = tsn_realloc(arr->data, new_cap * elem_size);
  arr->capacity = new_cap;
}

void tsn_array_push(void *arr, void *value, int64_t elem_size) {
  TsnArray *header = as_array(arr);
  if (header->length == header->capacity) {
    array_grow(header, elem_size);
  }
  char *slot = (char *)header->data + header->length * elem_size;
  memcpy(slot, value, (size_t)elem_size);
  header->length += 1;
}

void tsn_array_pop(void *arr, void *dest, int64_t elem_size) {
  TsnArray *header = as_array(arr);
  if (header->length == 0) {
    abort();
  }
  header->length -= 1;
  char *slot = (char *)header->data + header->length * elem_size;
  memcpy(dest, slot, (size_t)elem_size);
}

int32_t tsn_array_index_of(void *arr, void *needle, int64_t elem_size, int32_t cmp_kind) {
  TsnArray *header = as_array(arr);
  for (int64_t i = 0; i < header->length; i += 1) {
    void *slot = (char *)header->data + i * elem_size;
    if (values_equal(slot, needle, cmp_kind)) {
      return (int32_t)i;
    }
  }
  return -1;
}
