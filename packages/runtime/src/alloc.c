#include <stdlib.h>

#include "tsn/runtime.h"

void *tsn_alloc(int64_t size) {
  if (size < 0) {
    abort();
  }
  void *ptr = malloc((size_t)size);
  if (ptr == NULL) {
    abort();
  }
  return ptr;
}

void *tsn_realloc(void *ptr, int64_t size) {
  if (size < 0) {
    abort();
  }
  void *next = realloc(ptr, (size_t)size);
  if (next == NULL) {
    abort();
  }
  return next;
}

void tsn_free(void *ptr) {
  free(ptr);
}
