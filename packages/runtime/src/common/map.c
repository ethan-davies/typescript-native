#include <string.h>

#include "sn/runtime.h"

#define SN_MAP_INITIAL_CAP 8

static SnMap *as_map(void *map) {
  return (SnMap *)map;
}

static void map_grow(SnMap *map) {
  int64_t new_cap = map->cap == 0 ? SN_MAP_INITIAL_CAP : map->cap * 2;
  map->keys = sn_realloc(map->keys, new_cap * (int64_t)sizeof(char *));
  map->vals = sn_realloc(map->vals, new_cap * (int64_t)sizeof(void *));
  map->cap = new_cap;
}

void *sn_map_new(void) {
  SnMap *map = sn_alloc((int64_t)sizeof(SnMap));
  map->len = 0;
  map->cap = SN_MAP_INITIAL_CAP;
  map->keys = sn_alloc(map->cap * (int64_t)sizeof(char *));
  map->vals = sn_alloc(map->cap * (int64_t)sizeof(void *));
  sn_gc_set_type(map, SN_TYPEID_MAP);
  sn_gc_set_type(map->keys, 0);
  sn_gc_set_type(map->vals, 0);
  return map;
}

void sn_map_set(void *map, const char *key, void *val) {
  SnMap *header = as_map(map);
  for (int64_t i = 0; i < header->len; i += 1) {
    if (strcmp(header->keys[i], key) == 0) {
      header->vals[i] = val;
      return;
    }
  }

  if (header->len == header->cap) {
    map_grow(header);
  }

  header->keys[header->len] = (char *)key;
  header->vals[header->len] = val;
  header->len += 1;
}

void *sn_map_get(void *map, const char *key) {
  SnMap *header = as_map(map);
  for (int64_t i = 0; i < header->len; i += 1) {
    if (strcmp(header->keys[i], key) == 0) {
      return header->vals[i];
    }
  }
  return NULL;
}

bool sn_map_contains(void *map, const char *key) {
  SnMap *header = as_map(map);
  for (int64_t i = 0; i < header->len; i += 1) {
    if (strcmp(header->keys[i], key) == 0) {
      return true;
    }
  }
  return false;
}

bool sn_map_remove(void *map, const char *key) {
  SnMap *header = as_map(map);
  for (int64_t i = 0; i < header->len; i += 1) {
    if (strcmp(header->keys[i], key) == 0) {
      for (int64_t j = i; j + 1 < header->len; j += 1) {
        header->keys[j] = header->keys[j + 1];
        header->vals[j] = header->vals[j + 1];
      }
      header->len -= 1;
      return true;
    }
  }
  return false;
}

int32_t sn_map_size(void *map) {
  return (int32_t)as_map(map)->len;
}

void sn_map_clear(void *map) {
  as_map(map)->len = 0;
}

void *sn_map_keys(void *map) {
  SnMap *header = as_map(map);
  void *arr = sn_array_new(0, header->len > 0 ? header->len : 1, (int64_t)sizeof(char *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(char *));
  for (int64_t i = 0; i < header->len; i += 1) {
    char *copy = sn_str_concat(header->keys[i], "");
    sn_array_push(arr, &copy, (int64_t)sizeof(char *));
  }
  return arr;
}

void *sn_map_values(void *map) {
  SnMap *header = as_map(map);
  void *arr = sn_array_new(0, header->len > 0 ? header->len : 1, (int64_t)sizeof(void *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, 0, (int64_t)sizeof(void *));
  for (int64_t i = 0; i < header->len; i += 1) {
    void *val = header->vals[i];
    sn_array_push(arr, &val, (int64_t)sizeof(void *));
  }
  return arr;
}
