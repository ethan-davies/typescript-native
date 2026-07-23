#include "gc.h"

#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

#define SN_GC_DEFAULT_THRESHOLD (1024 * 1024)
#define SN_GC_ROOT_CAP_INITIAL 64
#define SN_GC_GLOBAL_CAP_INITIAL 16
#define SN_GC_HEAP_CAP_INITIAL 64

typedef struct SnGcObject {
  void *ptr;
  int64_t size;
  int32_t type_id;
  int32_t marked;
  /* Array scan metadata (valid when type_id == SN_TYPEID_ARRAY). */
  int32_t elem_ref_class;
  int32_t elem_type_id;
  int64_t elem_size;
  /* Map scan metadata (valid when type_id == SN_TYPEID_MAP). */
  int32_t key_ref_class;
  int32_t key_type_id;
  int32_t value_ref_class;
  int32_t value_type_id;
} SnGcObject;

static SnGcObject *heap = NULL;
static int32_t heap_len = 0;
static int32_t heap_cap = 0;

static void ***roots = NULL;
static int32_t root_len = 0;
static int32_t root_cap = 0;

static void ***globals = NULL;
static int32_t global_len = 0;
static int32_t global_cap = 0;

static int64_t bytes_allocated = 0;
static int64_t threshold = SN_GC_DEFAULT_THRESHOLD;
static int32_t collecting = 0;

/* Runtime-managed exception root (points at TLS slot in exception.c). */
static void **exception_root = NULL;

static void *sys_xrealloc(void *p, size_t n) {
  void *next = realloc(p, n);
  if (next == NULL) {
    abort();
  }
  return next;
}

static int32_t heap_find(void *ptr) {
  for (int32_t i = 0; i < heap_len; i += 1) {
    if (heap[i].ptr == ptr) {
      return i;
    }
  }
  return -1;
}

int32_t sn_gc_find_index(void *ptr) {
  if (ptr == NULL) {
    return -1;
  }
  return heap_find(ptr);
}

static SnGcObject *heap_get(void *ptr) {
  int32_t i = heap_find(ptr);
  return i < 0 ? NULL : &heap[i];
}

void sn_gc_register(void *ptr, int64_t size) {
  if (ptr == NULL) {
    return;
  }
  if (heap_len == heap_cap) {
    int32_t new_cap = heap_cap == 0 ? SN_GC_HEAP_CAP_INITIAL : heap_cap * 2;
    heap = (SnGcObject *)sys_xrealloc(heap, (size_t)new_cap * sizeof(SnGcObject));
    heap_cap = new_cap;
  }
  heap[heap_len].ptr = ptr;
  heap[heap_len].size = size;
  heap[heap_len].type_id = 0;
  heap[heap_len].marked = 0;
  heap[heap_len].elem_ref_class = SN_REF_VALUE;
  heap[heap_len].elem_type_id = 0;
  heap[heap_len].elem_size = 0;
  /* Default map ABI: string keys + pointer values. */
  heap[heap_len].key_ref_class = SN_REF_PTR;
  heap[heap_len].key_type_id = SN_TYPEID_STRING;
  heap[heap_len].value_ref_class = SN_REF_PTR;
  heap[heap_len].value_type_id = 0;
  heap_len += 1;
  bytes_allocated += size;
}

void sn_gc_unregister(void *ptr) {
  if (ptr == NULL) {
    return;
  }
  int32_t i = heap_find(ptr);
  if (i < 0) {
    return;
  }
  bytes_allocated -= heap[i].size;
  if (bytes_allocated < 0) {
    bytes_allocated = 0;
  }
  heap[i] = heap[heap_len - 1];
  heap_len -= 1;
}

void sn_gc_update_at(int32_t index, void *new_ptr, int64_t size) {
  if (index < 0) {
    sn_gc_register(new_ptr, size);
    return;
  }
  if (index >= heap_len) {
    abort();
  }
  bytes_allocated -= heap[index].size;
  bytes_allocated += size;
  heap[index].ptr = new_ptr;
  heap[index].size = size;
}

void sn_gc_set_type(void *ptr, int32_t type_id) {
  SnGcObject *obj = heap_get(ptr);
  if (obj == NULL) {
    return;
  }
  obj->type_id = type_id;
}

void sn_gc_set_array_meta(void *arr, int32_t elem_ref_class, int32_t elem_type_id, int64_t elem_size) {
  SnGcObject *obj = heap_get(arr);
  if (obj == NULL) {
    return;
  }
  obj->type_id = SN_TYPEID_ARRAY;
  obj->elem_ref_class = elem_ref_class;
  obj->elem_type_id = elem_type_id;
  obj->elem_size = elem_size;
}

void sn_gc_set_map_meta(void *map, int32_t key_ref_class, int32_t key_type_id, int32_t value_ref_class,
                         int32_t value_type_id) {
  SnGcObject *obj = heap_get(map);
  if (obj == NULL) {
    return;
  }
  obj->type_id = SN_TYPEID_MAP;
  obj->key_ref_class = key_ref_class;
  obj->key_type_id = key_type_id;
  obj->value_ref_class = value_ref_class;
  obj->value_type_id = value_type_id;
}

void sn_gc_root_push(void **slot) {
  if (slot == NULL) {
    return;
  }
  if (root_len == root_cap) {
    int32_t new_cap = root_cap == 0 ? SN_GC_ROOT_CAP_INITIAL : root_cap * 2;
    roots = (void ***)sys_xrealloc(roots, (size_t)new_cap * sizeof(void **));
    root_cap = new_cap;
  }
  roots[root_len] = slot;
  root_len += 1;
}

void sn_gc_root_pop(int32_t n) {
  if (n < 0) {
    abort();
  }
  if (n > root_len) {
    abort();
  }
  root_len -= n;
}

int32_t sn_gc_root_checkpoint(void) {
  return root_len;
}

void sn_gc_root_restore(int32_t n) {
  if (n < 0 || n > root_len) {
    abort();
  }
  root_len = n;
}

void sn_gc_add_global_root(void **slot) {
  if (slot == NULL) {
    return;
  }
  if (global_len == global_cap) {
    int32_t new_cap = global_cap == 0 ? SN_GC_GLOBAL_CAP_INITIAL : global_cap * 2;
    globals = (void ***)sys_xrealloc(globals, (size_t)new_cap * sizeof(void **));
    global_cap = new_cap;
  }
  globals[global_len] = slot;
  global_len += 1;
}

void sn_gc_set_exception_root(void **slot) {
  exception_root = slot;
}

void sn_gc_set_threshold(int64_t bytes) {
  if (bytes < 0) {
    abort();
  }
  threshold = bytes;
}

int64_t sn_gc_bytes_allocated(void) {
  return bytes_allocated;
}

static void mark_object(void *ptr);

static void mark_fields_at(char *base, const SnTypeInfo *info) {
  if (info == NULL || info->fields == NULL) {
    return;
  }
  for (int32_t i = 0; i < info->field_count; i += 1) {
    const SnFieldInfo *f = &info->fields[i];
    char *slot = base + f->offset;
    if (f->ref_class == SN_REF_PTR) {
      void *child = *(void **)slot;
      mark_object(child);
    } else if (f->ref_class == SN_REF_AGG) {
      const SnTypeInfo *nested = sn_typeinfo_get(f->type_id);
      if (nested != NULL) {
        if (nested->kind == SN_KIND_CLOSURE) {
          /* %__Callable: scan env pointer at offset sizeof(void*). */
          void *env = *(void **)(slot + (size_t)sizeof(void *));
          mark_object(env);
        } else {
          mark_fields_at(slot, nested);
        }
      }
    }
  }
}

static void mark_array(SnGcObject *obj) {
  SnArray *arr = (SnArray *)obj->ptr;
  if (arr->data != NULL) {
    mark_object(arr->data);
  }
  if (obj->elem_ref_class == SN_REF_VALUE || arr->data == NULL || obj->elem_size <= 0) {
    return;
  }
  char *data = (char *)arr->data;
  for (int64_t i = 0; i < arr->length; i += 1) {
    char *elem = data + i * obj->elem_size;
    if (obj->elem_ref_class == SN_REF_PTR) {
      mark_object(*(void **)elem);
    } else if (obj->elem_ref_class == SN_REF_AGG) {
      const SnTypeInfo *elem_ti = sn_typeinfo_get(obj->elem_type_id);
      mark_fields_at(elem, elem_ti);
    }
  }
}

static void mark_map_slot(char *slot, int32_t ref_class, int32_t type_id) {
  if (ref_class == SN_REF_PTR) {
    mark_object(*(void **)slot);
  } else if (ref_class == SN_REF_AGG) {
    const SnTypeInfo *ti = sn_typeinfo_get(type_id);
    mark_fields_at(slot, ti);
  }
}

static void mark_map(SnGcObject *obj) {
  SnMap *map = (SnMap *)obj->ptr;
  if (map->keys != NULL) {
    mark_object(map->keys);
  }
  if (map->vals != NULL) {
    mark_object(map->vals);
  }
  for (int64_t i = 0; i < map->len; i += 1) {
    if (map->keys != NULL) {
      mark_map_slot((char *)&map->keys[i], obj->key_ref_class, obj->key_type_id);
    }
    if (map->vals != NULL) {
      mark_map_slot((char *)&map->vals[i], obj->value_ref_class, obj->value_type_id);
    }
  }
}

static void mark_object(void *ptr) {
  if (ptr == NULL) {
    return;
  }
  SnGcObject *obj = heap_get(ptr);
  if (obj == NULL) {
    /* Not a GC-managed pointer (e.g. string literal). */
    return;
  }
  if (obj->marked) {
    return;
  }
  obj->marked = 1;

  int32_t type_id = obj->type_id;
  if (type_id == 0) {
    /* Opaque buffer (array/map secondary storage) or untyped allocation. */
    return;
  }

  if (type_id == SN_TYPEID_STRING) {
    return;
  }
  if (type_id == SN_TYPEID_ARRAY) {
    mark_array(obj);
    return;
  }
  if (type_id == SN_TYPEID_MAP) {
    mark_map(obj);
    return;
  }
  if (type_id == SN_TYPEID_FUTURE) {
    /* Walk waiter linked list (each waiter is a small GC allocation). */
    typedef struct SnWaiterMark {
      void *task;
      struct SnWaiterMark *next;
    } SnWaiterMark;
    typedef struct SnFutureMark {
      int32_t state;
      void *value;
      void *error;
      SnWaiterMark *waiters;
      void *compose_data;
      void *on_settle;
    } SnFutureMark;
    SnFutureMark *fut = (SnFutureMark *)ptr;
    mark_object(fut->value);
    mark_object(fut->error);
    mark_object(fut->compose_data);
    SnWaiterMark *w = fut->waiters;
    while (w != NULL) {
      mark_object(w);
      mark_object(w->task);
      w = w->next;
    }
    return;
  }

  const SnTypeInfo *info = sn_typeinfo_get(type_id);
  if (info == NULL) {
    return;
  }

  switch (info->kind) {
    case SN_KIND_CLASS:
    case SN_KIND_ENV:
    case SN_KIND_STRUCT:
    case SN_KIND_CLOSURE:
      mark_fields_at((char *)ptr, info);
      break;
    case SN_KIND_ARRAY:
      mark_array(obj);
      break;
    case SN_KIND_MAP:
      mark_map(obj);
      break;
    case SN_KIND_STRING:
    default:
      break;
  }
}

static void mark_root_slot(void **slot) {
  if (slot == NULL) {
    return;
  }
  mark_object(*slot);
}

static void sweep(void) {
  int32_t i = 0;
  while (i < heap_len) {
    if (!heap[i].marked) {
      void *ptr = heap[i].ptr;
      int64_t size = heap[i].size;
      heap[i] = heap[heap_len - 1];
      heap_len -= 1;
      bytes_allocated -= size;
      if (bytes_allocated < 0) {
        bytes_allocated = 0;
      }
      free(ptr);
      continue;
    }
    heap[i].marked = 0;
    i += 1;
  }
}

void sn_gc_collect(void) {
  if (collecting) {
    return;
  }
  collecting = 1;

  for (int32_t i = 0; i < heap_len; i += 1) {
    heap[i].marked = 0;
  }

  for (int32_t i = 0; i < root_len; i += 1) {
    mark_root_slot(roots[i]);
  }
  for (int32_t i = 0; i < global_len; i += 1) {
    mark_root_slot(globals[i]);
  }
  if (exception_root != NULL) {
    mark_root_slot(exception_root);
  }

  sweep();
  collecting = 0;
}

void sn_gc_maybe_collect(void) {
  if (collecting) {
    return;
  }
  if (threshold > 0 && bytes_allocated > threshold) {
    sn_gc_collect();
  }
}
