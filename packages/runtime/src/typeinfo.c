#include <stdlib.h>

#include "tsn/runtime.h"

/* Builtin TypeInfo entries for reserved type_ids 1–5.
 * Array/map elem/key/value classifications are filled by per-instantiation
 * metadata later; builtins describe the header shapes only. */

static const TsnTypeInfo BUILTIN_STRING = {
    .type_id = TSN_TYPEID_STRING,
    .kind = TSN_KIND_STRING,
    .size = -1, /* NUL-terminated, variable length */
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = TSN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = TSN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = TSN_REF_VALUE,
};

static const TsnTypeInfo BUILTIN_ARRAY = {
    .type_id = TSN_TYPEID_ARRAY,
    .kind = TSN_KIND_ARRAY,
    .size = (int32_t)sizeof(TsnArray),
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0, /* specialized by compiler later */
    .elem_ref_class = TSN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = TSN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = TSN_REF_VALUE,
};

static const TsnTypeInfo BUILTIN_MAP = {
    .type_id = TSN_TYPEID_MAP,
    .kind = TSN_KIND_MAP,
    .size = (int32_t)sizeof(TsnMap),
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = TSN_REF_VALUE,
    .key_type_id = TSN_TYPEID_STRING,
    .key_ref_class = TSN_REF_PTR,
    .value_type_id = 0,
    .value_ref_class = TSN_REF_PTR,
};

/* Closure handle is { ptr code, ptr env } — 16 bytes on LP64; not always heap. */
static const TsnFieldInfo CLOSURE_FIELDS[] = {
    {.offset = 0, .size = (int32_t)sizeof(void *), .ref_class = TSN_REF_VALUE, .type_id = 0},
    {.offset = (int32_t)sizeof(void *),
     .size = (int32_t)sizeof(void *),
     .ref_class = TSN_REF_PTR,
     .type_id = TSN_TYPEID_ENV},
};

static const TsnTypeInfo BUILTIN_CLOSURE = {
    .type_id = TSN_TYPEID_CLOSURE,
    .kind = TSN_KIND_CLOSURE,
    .size = (int32_t)(2 * sizeof(void *)),
    .field_count = 2,
    .fields = CLOSURE_FIELDS,
    .elem_type_id = 0,
    .elem_ref_class = TSN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = TSN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = TSN_REF_VALUE,
};

static const TsnTypeInfo BUILTIN_ENV = {
    .type_id = TSN_TYPEID_ENV,
    .kind = TSN_KIND_ENV,
    .size = -1, /* capture layout is per-closure */
    .field_count = 0,
    .fields = NULL,
    .elem_type_id = 0,
    .elem_ref_class = TSN_REF_VALUE,
    .key_type_id = 0,
    .key_ref_class = TSN_REF_VALUE,
    .value_type_id = 0,
    .value_ref_class = TSN_REF_VALUE,
};

static const TsnTypeInfo *builtins_by_id(int32_t type_id) {
  switch (type_id) {
    case TSN_TYPEID_STRING:
      return &BUILTIN_STRING;
    case TSN_TYPEID_ARRAY:
      return &BUILTIN_ARRAY;
    case TSN_TYPEID_MAP:
      return &BUILTIN_MAP;
    case TSN_TYPEID_CLOSURE:
      return &BUILTIN_CLOSURE;
    case TSN_TYPEID_ENV:
      return &BUILTIN_ENV;
    default:
      return NULL;
  }
}

#define REGISTERED_CAP_INITIAL 32

static const TsnTypeInfo **registered = NULL;
static int32_t registered_len = 0;
static int32_t registered_cap = 0;

void tsn_typeinfo_register(const TsnTypeInfo *info) {
  if (info == NULL || info->type_id < TSN_TYPEID_CLASS_BASE) {
    abort();
  }
  if (registered_len == registered_cap) {
    int32_t new_cap = registered_cap == 0 ? REGISTERED_CAP_INITIAL : registered_cap * 2;
    const TsnTypeInfo **next =
        (const TsnTypeInfo **)tsn_realloc(registered, (int64_t)new_cap * (int64_t)sizeof(*next));
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

const TsnTypeInfo *tsn_typeinfo_get(int32_t type_id) {
  const TsnTypeInfo *builtin = builtins_by_id(type_id);
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
