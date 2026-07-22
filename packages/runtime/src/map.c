#include <string.h>

#include "tsn/runtime.h"

#define TSN_MAP_INITIAL_CAP 8

static TsnMap *as_map(void *map) {
  return (TsnMap *)map;
}

static void map_grow(TsnMap *map) {
  int64_t new_cap = map->cap == 0 ? TSN_MAP_INITIAL_CAP : map->cap * 2;
  map->keys = tsn_realloc(map->keys, new_cap * (int64_t)sizeof(char *));
  map->vals = tsn_realloc(map->vals, new_cap * (int64_t)sizeof(void *));
  map->cap = new_cap;
}

void *tsn_map_new(void) {
  TsnMap *map = tsn_alloc((int64_t)sizeof(TsnMap));
  map->len = 0;
  map->cap = TSN_MAP_INITIAL_CAP;
  map->keys = tsn_alloc(map->cap * (int64_t)sizeof(char *));
  map->vals = tsn_alloc(map->cap * (int64_t)sizeof(void *));
  return map;
}

void tsn_map_set(void *map, const char *key, void *val) {
  TsnMap *header = as_map(map);
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

void *tsn_map_get(void *map, const char *key) {
  TsnMap *header = as_map(map);
  for (int64_t i = 0; i < header->len; i += 1) {
    if (strcmp(header->keys[i], key) == 0) {
      return header->vals[i];
    }
  }
  return NULL;
}
