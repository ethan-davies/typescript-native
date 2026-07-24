#ifndef SN_GC_INTERNAL_H
#define SN_GC_INTERNAL_H

#include <stdint.h>

/* Internal hooks used by alloc.c. Not part of the public SN ABI. */

void sn_gc_register(void *ptr, int64_t size);
void sn_gc_unregister(void *ptr);
/** Look up `ptr` before realloc; returns index or -1. */
int32_t sn_gc_find_index(void *ptr);
/** Update heap entry at `index` after realloc (or register if index < 0). */
void sn_gc_update_at(int32_t index, void *new_ptr, int64_t size);
void sn_gc_maybe_collect(void);

#endif /* SN_GC_INTERNAL_H */
