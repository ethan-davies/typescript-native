#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

#define SN_PATH_MAX_PARTS 256

static char *dup_str(const char *s) {
  return sn_str_concat(s, "");
}

bool sn_path_is_absolute(const char *path) {
  return path != NULL && path[0] == '/';
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

static int split_parts(const char *path, char **parts, int max_parts, bool *absolute_out) {
  *absolute_out = false;
  const char *p = path != NULL ? path : "";
  if (p[0] == '/') {
    *absolute_out = true;
    while (p[0] == '/') {
      p += 1;
    }
  }

  int count = 0;
  while (*p != '\0' && count < max_parts) {
    while (*p == '/') {
      p += 1;
    }
    if (*p == '\0') {
      break;
    }
    const char *start = p;
    while (*p != '\0' && *p != '/') {
      p += 1;
    }
    size_t n = (size_t)(p - start);
    if (n == 1 && start[0] == '.') {
      continue;
    }
    if (n == 2 && start[0] == '.' && start[1] == '.') {
      if (count > 0 && strcmp(parts[count - 1], "..") != 0) {
        count -= 1;
      } else if (!*absolute_out) {
        parts[count++] = dup_str("..");
      }
      continue;
    }
    char *part = sn_alloc((int64_t)n + 1);
    memcpy(part, start, n);
    part[n] = '\0';
    sn_gc_set_type(part, SN_TYPEID_STRING);
    parts[count++] = part;
  }
  return count;
}

static char *join_parts(bool absolute, char **parts, int count) {
  if (count == 0) {
    return absolute ? dup_str("/") : dup_str(".");
  }

  size_t len = absolute ? 1 : 0;
  for (int i = 0; i < count; i += 1) {
    if (i > 0) {
      len += 1;
    }
    len += strlen(parts[i]);
  }

  char *buf = sn_alloc((int64_t)len + 1);
  size_t out = 0;
  if (absolute) {
    buf[out++] = '/';
  }
  for (int i = 0; i < count; i += 1) {
    if (i > 0) {
      buf[out++] = '/';
    }
    size_t n = strlen(parts[i]);
    memcpy(buf + out, parts[i], n);
    out += n;
  }
  buf[out] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_path_normalize(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return dup_str(".");
  }
  char *parts[SN_PATH_MAX_PARTS];
  bool absolute = false;
  int count = split_parts(path, parts, SN_PATH_MAX_PARTS, &absolute);
  return join_parts(absolute, parts, count);
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

char *sn_path_resolve(const char *path) {
  return sn_path_absolute(path);
}

char *sn_path_relative(const char *from, const char *to) {
  char *from_abs = sn_path_absolute(from != NULL ? from : ".");
  char *to_abs = sn_path_absolute(to != NULL ? to : ".");

  char *from_parts[SN_PATH_MAX_PARTS];
  char *to_parts[SN_PATH_MAX_PARTS];
  bool from_abs_flag = false;
  bool to_abs_flag = false;
  int from_n = split_parts(from_abs, from_parts, SN_PATH_MAX_PARTS, &from_abs_flag);
  int to_n = split_parts(to_abs, to_parts, SN_PATH_MAX_PARTS, &to_abs_flag);
  (void)from_abs_flag;
  (void)to_abs_flag;

  int common = 0;
  while (common < from_n && common < to_n && strcmp(from_parts[common], to_parts[common]) == 0) {
    common += 1;
  }

  int up = from_n - common;
  int down = to_n - common;
  if (up == 0 && down == 0) {
    return dup_str(".");
  }

  size_t len = 0;
  for (int i = 0; i < up; i += 1) {
    if (i > 0) {
      len += 1;
    }
    len += 2;
  }
  for (int i = 0; i < down; i += 1) {
    if (up > 0 || i > 0) {
      len += 1;
    }
    len += strlen(to_parts[common + i]);
  }

  char *buf = sn_alloc((int64_t)len + 1);
  size_t out = 0;
  for (int i = 0; i < up; i += 1) {
    if (i > 0) {
      buf[out++] = '/';
    }
    buf[out++] = '.';
    buf[out++] = '.';
  }
  for (int i = 0; i < down; i += 1) {
    if (up > 0 || i > 0) {
      buf[out++] = '/';
    }
    size_t n = strlen(to_parts[common + i]);
    memcpy(buf + out, to_parts[common + i], n);
    out += n;
  }
  buf[out] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}
