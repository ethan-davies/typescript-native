#include <stdlib.h>

#include "sn/runtime.h"

/* TypeInfo registry uses system malloc — never sn_alloc — so it is not GC-managed. */

/* Builtin TypeInfo entries for reserved type_ids 1–7.
 * Array/map elem/key/value classifications are filled by per-instantiation
 * metadata later; builtins describe the header shapes only. */

static const SnTypeInfo BUILTIN_STRING = {
    .type_id = SN_TYPEID_STRING,
    .kind = SN_KIND_STRING,
    .size = -1, /* NUL-terminated, variable length */
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

static const SnTypeInfo BUILTIN_ARRAY = {
    .type_id = SN_TYPEID_ARRAY,
    .kind = SN_KIND_ARRAY,
    .size = (int32_t)sizeof(SnArray),
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0, /* specialized by compiler later */
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

static const SnTypeInfo BUILTIN_MAP = {
    .type_id = SN_TYPEID_MAP,
    .kind = SN_KIND_MAP,
    .size = (int32_t)sizeof(SnMap),
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = SN_TYPEID_STRING,
    .key_ref_class = SN_REF_PTR,
    .value_type_id = 0,
    .value_ref_class = SN_REF_PTR,
    .parent_type_id = 0,
};

/* Closure handle is { ptr code, ptr env } — 16 bytes on LP64; not always heap. */
static const SnFieldInfo CLOSURE_FIELDS[] = {
    {.offset = 0, .size = (int32_t)sizeof(void *), .ref_class = SN_REF_VALUE, .type_id = 0},
    {.offset = (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_PTR,
     .type_id = SN_TYPEID_ENV},
};

static const SnTypeInfo BUILTIN_CLOSURE = {
    .type_id = SN_TYPEID_CLOSURE,
    .kind = SN_KIND_CLOSURE,
    .size = (int32_t)(2 * sizeof(void *)),
    .field_count = 2,
    .fields = CLOSURE_FIELDS,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

static const SnTypeInfo BUILTIN_ENV = {
    .type_id = SN_TYPEID_ENV,
    .kind = SN_KIND_ENV,
    .size = -1, /* capture layout is per-closure */
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

/* SnFuture: state(i32)+pad, value*, error*, waiters*, compose_data*, on_settle* */
static const SnFieldInfo FUTURE_FIELDS[] = {
    {.offset = 0, .size = 4, .ref_class = SN_REF_VALUE, .type_id = 0},
    {.offset = 8, .size = (int32_t)sizeof(void *), .ref_class = SN_REF_PTR, .type_id = 0},
    {.offset = 8 + (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_PTR,
     .type_id = 0},
    {.offset = 8 + 2 * (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_PTR,
     .type_id = 0},
    {.offset = 8 + 3 * (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_PTR,
     .type_id = 0},
    {.offset = 8 + 4 * (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_VALUE,
     .type_id = 0},
};

static const SnTypeInfo BUILTIN_FUTURE = {
    .type_id = SN_TYPEID_FUTURE,
    .kind = SN_KIND_STRUCT,
    .size = (int32_t)(8 + 5 * sizeof(void *)),
    .field_count = 6,
    .fields = FUTURE_FIELDS,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

/* SnTask: result*, frame*, resume*, awaiting*, state, cancelled */
static const SnFieldInfo TASK_FIELDS[] = {
    {.offset = 0, .size = (int32_t)sizeof(void *), .ref_class = SN_REF_PTR, .type_id = SN_TYPEID_FUTURE},
    {.offset = (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_PTR,
     .type_id = 0},
    {.offset = 2 * (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_VALUE,
     .type_id = 0},
    {.offset = 3 * (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = SN_REF_PTR,
     .type_id = SN_TYPEID_FUTURE},
    {.offset = 4 * (int32_t)sizeof(void *), .size = 4, .ref_class = SN_REF_VALUE, .type_id = 0},
    {.offset = 4 * (int32_t)sizeof(void *) + 4, .size = 4, .ref_class = SN_REF_VALUE, .type_id = 0},
};

static const SnTypeInfo BUILTIN_TASK = {
    .type_id = SN_TYPEID_TASK,
    .kind = SN_KIND_STRUCT,
    .size = (int32_t)(4 * sizeof(void *) + 8),
    .field_count = 6,
    .fields = TASK_FIELDS,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

static const SnTypeInfo BUILTIN_BYTES = {
    .type_id = SN_TYPEID_BYTES,
    .kind = SN_KIND_ARRAY,
    .size = (int32_t)sizeof(SnBytes),
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = SN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = SN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = SN_REF_VALUE,
    .parent_type_id = 0,
};

static const SnTypeInfo *builtins_by_id(int32_t type_id) {
  switch (type_id) {
    case SN_TYPEID_STRING:
      return &BUILTIN_STRING;
    case SN_TYPEID_ARRAY:
      return &BUILTIN_ARRAY;
    case SN_TYPEID_MAP:
      return &BUILTIN_MAP;
    case SN_TYPEID_CLOSURE:
      return &BUILTIN_CLOSURE;
    case SN_TYPEID_ENV:
      return &BUILTIN_ENV;
    case SN_TYPEID_FUTURE:
      return &BUILTIN_FUTURE;
    case SN_TYPEID_TASK:
      return &BUILTIN_TASK;
    case SN_TYPEID_BYTES:
      return &BUILTIN_BYTES;
    default:
      return NULL;
  }
}

#define REGISTERED_CAP_INITIAL 32

static const SnTypeInfo **registered = NULL;
static int32_t registered_len = 0;
static int32_t registered_cap = 0;

void sn_typeinfo_register(const SnTypeInfo *info) {
  if (info == NULL || info->type_id < SN_TYPEID_CLASS_BASE) {
    abort();
  }
  if (registered_len == registered_cap) {
    int32_t new_cap = registered_cap == 0 ? REGISTERED_CAP_INITIAL : registered_cap * 2;
    const SnTypeInfo **next =
        (const SnTypeInfo **)realloc(registered, (size_t)new_cap * sizeof(*next));
    if (next == NULL) {
      abort();
    }
    registered = next;
    registered_cap = new_cap;
  }
  /* Replace existing entry with the same type_id if re-registered. */
  for (int32_t i = 0; i < registered_len; i += 1) {
    if (registered[i]->type_id == info->type_id) {
      registered[i] = info;
      return;
    }
  }
  registered[registered_len] = info;
  registered_len += 1;
}

const SnTypeInfo *sn_typeinfo_get(int32_t type_id) {
  const SnTypeInfo *builtin = builtins_by_id(type_id);
  if (builtin != NULL) {
    return builtin;
  }
  for (int32_t i = 0; i < registered_len; i += 1) {
    if (registered[i]->type_id == type_id) {
      return registered[i];
    }
  }
  return NULL;
}

bool sn_is_instance(void *obj, int32_t type_id) {
  if (obj == NULL || type_id == 0) {
    return false;
  }
  int32_t id = ((SnObjectHeader *)obj)->type_id;
  while (id != 0) {
    if (id == type_id) {
      return true;
    }
    const SnTypeInfo *info = sn_typeinfo_get(id);
    if (info == NULL) {
      return false;
    }
    id = info->parent_type_id;
  }
  return false;
}
