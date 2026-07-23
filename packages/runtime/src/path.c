#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

static char *dup_str(const char *s) {
  return sn_str_concat(s, "");
}

char *sn_path_join(const char *a, const char *b) {
  if (a == NULL || a[0] == '\0') {
    return dup_str(b != NULL ? b : "");
  }
  if (b == NULL || b[0] == '\0') {
    return dup_str(a);
  }
  if (b[0] == '/') {
    return dup_str(b);
  }
  size_t a_len = strlen(a);
  bool has_slash = a_len > 0 && a[a_len - 1] == '/';
  if (has_slash) {
    return sn_str_concat(a, b);
  }
  char *mid = sn_str_concat(a, "/");
  char *result = sn_str_concat(mid, b);
  return result;
}

char *sn_path_basename(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return dup_str("");
  }
  const char *slash = strrchr(path, '/');
  if (slash == NULL) {
    return dup_str(path);
  }
  if (slash[1] == '\0') {
    /* Trailing slash — find previous component. */
    if (slash == path) {
      return dup_str("/");
    }
    const char *end = slash;
    while (end > path && end[-1] == '/') {
      end -= 1;
    }
    const char *start = end;
    while (start > path && start[-1] != '/') {
      start -= 1;
    }
    size_t n = (size_t)(end - start);
    char *buf = sn_alloc((int64_t)n + 1);
    memcpy(buf, start, n);
    buf[n] = '\0';
    sn_gc_set_type(buf, SN_TYPEID_STRING);
    return buf;
  }
  return dup_str(slash + 1);
}

char *sn_path_dirname(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return dup_str(".");
  }
  const char *slash = strrchr(path, '/');
  if (slash == NULL) {
    return dup_str(".");
  }
  if (slash == path) {
    return dup_str("/");
  }
  size_t n = (size_t)(slash - path);
  char *buf = sn_alloc((int64_t)n + 1);
  memcpy(buf, path, n);
  buf[n] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_path_extension(const char *path) {
  char *base = sn_path_basename(path);
  const char *dot = strrchr(base, '.');
  if (dot == NULL || dot == base) {
    return dup_str("");
  }
  return dup_str(dot);
}

char *sn_path_normalize(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return dup_str(".");
  }
  /* Simple normalize: collapse // and trailing slash (except root). */
  size_t len = strlen(path);
  char *buf = sn_alloc((int64_t)len + 1);
  size_t out = 0;
  for (size_t i = 0; i < len; i += 1) {
    char c = path[i];
    if (c == '/' && out > 0 && buf[out - 1] == '/') {
      continue;
    }
    buf[out] = c;
    out += 1;
  }
  while (out > 1 && buf[out - 1] == '/') {
    out -= 1;
  }
  buf[out] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_path_absolute(const char *path) {
  if (path != NULL && path[0] == '/') {
    return sn_path_normalize(path);
  }
  char *cwd = sn_process_cwd();
  if (cwd == NULL) {
    return sn_path_normalize(path != NULL ? path : ".");
  }
  char *joined = sn_path_join(cwd, path != NULL ? path : ".");
  return sn_path_normalize(joined);
}
