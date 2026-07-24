#include <stdlib.h>

#include "gc.h"
#include "sn/runtime.h"

void *sn_alloc(int64_t size) {
  if (size < 0) {
    abort();
  }
  sn_gc_maybe_collect();
  void *ptr = malloc((size_t)size);
  if (ptr == NULL) {
    abort();
  }
  sn_gc_register(ptr, size);
  return ptr;
}

void *sn_realloc(void *ptr, int64_t size) {
  if (size < 0) {
    abort();
  }
  sn_gc_maybe_collect();
  if (ptr == NULL) {
    return sn_alloc(size);
  }
  /* Resolve side-table index before realloc may move/free the block. */
  int32_t index = sn_gc_find_index(ptr);
  void *next = realloc(ptr, (size_t)size);
  if (next == NULL) {
    abort();
  }
  sn_gc_update_at(index, next, size);
  return next;
}

void sn_free(void *ptr) {
  if (ptr == NULL) {
    return;
  }
  sn_gc_unregister(ptr);
  free(ptr);
}
