#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <ctype.h>
#include <string.h>

#include "sn/runtime.h"

#define SN_PATH_MAX_PARTS 256

static char *dup_str(const char *s) {
  return sn_str_concat(s != NULL ? s : "", "");
}

static bool is_sep(char c) {
  return c == '\\' || c == '/';
}

static bool is_drive_letter(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

bool sn_path_is_absolute(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return false;
  }
  /* Rooted (\foo) or UNC (\\server\share). */
  if (is_sep(path[0])) {
    return true;
  }
  /* Drive-absolute: C:\ or C:/ */
  if (is_drive_letter(path[0]) && path[1] == ':' && is_sep(path[2])) {
    return true;
  }
  return false;
}

char *sn_path_join(const char *a, const char *b) {
  if (a == NULL || a[0] == '\0') {
    return dup_str(b != NULL ? b : "");
  }
  if (b == NULL || b[0] == '\0') {
    return dup_str(a);
  }
  if (sn_path_is_absolute(b)) {
    return dup_str(b);
  }
  size_t a_len = strlen(a);
  bool has_sep = a_len > 0 && is_sep(a[a_len - 1]);
  if (has_sep) {
    return sn_str_concat(a, b);
  }
  char *mid = sn_str_concat(a, "\\");
  return sn_str_concat(mid, b);
}

static const char *find_last_sep(const char *path) {
  const char *last = NULL;
  for (const char *p = path; *p != '\0'; p += 1) {
    if (is_sep(*p)) {
      last = p;
    }
  }
  return last;
}

char *sn_path_basename(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return dup_str("");
  }
  const char *sep = find_last_sep(path);
  if (sep == NULL) {
    return dup_str(path);
  }
  if (sep[1] == '\0') {
    if (sep == path) {
      return dup_str("\\");
    }
    const char *end = sep;
    while (end > path && is_sep(end[-1])) {
      end -= 1;
    }
    const char *start = end;
    while (start > path && !is_sep(start[-1])) {
      start -= 1;
    }
    size_t n = (size_t)(end - start);
    if (n == 0) {
      return dup_str("\\");
    }
    char *buf = sn_alloc((int64_t)n + 1);
    memcpy(buf, start, n);
    buf[n] = '\0';
    sn_gc_set_type(buf, SN_TYPEID_STRING);
    return buf;
  }
  return dup_str(sep + 1);
}

char *sn_path_dirname(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return dup_str(".");
  }
  const char *sep = find_last_sep(path);
  if (sep == NULL) {
    if (is_drive_letter(path[0]) && path[1] == ':' && path[2] != '\0') {
      char *buf = sn_alloc(3);
      buf[0] = path[0];
      buf[1] = ':';
      buf[2] = '\0';
      sn_gc_set_type(buf, SN_TYPEID_STRING);
      return buf;
    }
    return dup_str(".");
  }
  if (sep == path) {
    return dup_str("\\");
  }
  /* Keep drive root: C:\ */
  if (sep == path + 2 && is_drive_letter(path[0]) && path[1] == ':') {
    char *buf = sn_alloc(4);
    buf[0] = path[0];
    buf[1] = ':';
    buf[2] = '\\';
    buf[3] = '\0';
    sn_gc_set_type(buf, SN_TYPEID_STRING);
    return buf;
  }
  size_t n = (size_t)(sep - path);
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

static int split_parts(const char *path, char **parts, int max_parts, bool *absolute_out,
                       bool *unc_out, char *drive_out) {
  drive_out[0] = '\0';
  *absolute_out = false;
  *unc_out = false;
  const char *p = path != NULL ? path : "";

  if (is_drive_letter(p[0]) && p[1] == ':') {
    drive_out[0] = (char)toupper((unsigned char)p[0]);
    drive_out[1] = ':';
    drive_out[2] = '\0';
    p += 2;
  }
  if (is_sep(p[0]) && is_sep(p[1])) {
    *absolute_out = true;
    *unc_out = true;
    p += 2;
    while (is_sep(p[0])) {
      p += 1;
    }
  } else if (is_sep(p[0])) {
    *absolute_out = true;
    while (is_sep(p[0])) {
      p += 1;
    }
  }

  int count = 0;
  while (*p != '\0' && count < max_parts) {
    while (is_sep(*p)) {
      p += 1;
    }
    if (*p == '\0') {
      break;
    }
    const char *start = p;
    while (*p != '\0' && !is_sep(*p)) {
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

static char *join_parts(const char *drive, bool absolute, bool unc, char **parts, int count) {
  if (count == 0) {
    if (drive != NULL && drive[0] != '\0') {
      if (absolute) {
        char *buf = sn_alloc(4);
        buf[0] = drive[0];
        buf[1] = ':';
        buf[2] = '\\';
        buf[3] = '\0';
        sn_gc_set_type(buf, SN_TYPEID_STRING);
        return buf;
      }
      return dup_str(drive);
    }
    if (unc) {
      return dup_str("\\\\");
    }
    return absolute ? dup_str("\\") : dup_str(".");
  }

  size_t len = 0;
  if (drive != NULL && drive[0] != '\0') {
    len += 2;
  }
  if (unc) {
    len += 2;
  } else if (absolute) {
    len += 1;
  }
  for (int i = 0; i < count; i += 1) {
    if (i > 0) {
      len += 1;
    }
    len += strlen(parts[i]);
  }

  char *buf = sn_alloc((int64_t)len + 1);
  size_t out = 0;
  if (drive != NULL && drive[0] != '\0') {
    buf[out++] = drive[0];
    buf[out++] = ':';
  }
  if (unc) {
    buf[out++] = '\\';
    buf[out++] = '\\';
  } else if (absolute) {
    buf[out++] = '\\';
  }
  for (int i = 0; i < count; i += 1) {
    if (i > 0) {
      buf[out++] = '\\';
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
  bool unc = false;
  char drive[4];
  int count = split_parts(path, parts, SN_PATH_MAX_PARTS, &absolute, &unc, drive);
  return join_parts(drive[0] != '\0' ? drive : NULL, absolute, unc, parts, count);
}

char *sn_path_absolute(const char *path) {
  const char *input = path != NULL ? path : ".";
  char buf[MAX_PATH];
  DWORD n = GetFullPathNameA(input, (DWORD)sizeof(buf), buf, NULL);
  if (n == 0 || n >= sizeof(buf)) {
    char *cwd = sn_process_cwd();
    if (cwd == NULL) {
      return sn_path_normalize(input);
    }
    char *joined = sn_path_join(cwd, input);
    return sn_path_normalize(joined);
  }
  return sn_path_normalize(buf);
}

char *sn_path_resolve(const char *path) {
  return sn_path_absolute(path);
}

static int cmp_part_ci(const char *a, const char *b) {
  while (*a != '\0' && *b != '\0') {
    int ca = tolower((unsigned char)*a);
    int cb = tolower((unsigned char)*b);
    if (ca != cb) {
      return ca - cb;
    }
    a += 1;
    b += 1;
  }
  return (unsigned char)*a - (unsigned char)*b;
}

char *sn_path_relative(const char *from, const char *to) {
  char *from_abs = sn_path_absolute(from != NULL ? from : ".");
  char *to_abs = sn_path_absolute(to != NULL ? to : ".");

  char *from_parts[SN_PATH_MAX_PARTS];
  char *to_parts[SN_PATH_MAX_PARTS];
  bool from_abs_flag = false;
  bool to_abs_flag = false;
  bool from_unc = false;
  bool to_unc = false;
  char from_drive[4];
  char to_drive[4];
  int from_n =
      split_parts(from_abs, from_parts, SN_PATH_MAX_PARTS, &from_abs_flag, &from_unc, from_drive);
  int to_n = split_parts(to_abs, to_parts, SN_PATH_MAX_PARTS, &to_abs_flag, &to_unc, to_drive);
  (void)from_abs_flag;
  (void)to_abs_flag;

  if (from_unc != to_unc) {
    return to_abs;
  }

  if (from_drive[0] != '\0' && to_drive[0] != '\0' && from_drive[0] != to_drive[0]) {
    return to_abs;
  }

  int common = 0;
  while (common < from_n && common < to_n && cmp_part_ci(from_parts[common], to_parts[common]) == 0) {
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
      buf[out++] = '\\';
    }
    buf[out++] = '.';
    buf[out++] = '.';
  }
  for (int i = 0; i < down; i += 1) {
    if (up > 0 || i > 0) {
      buf[out++] = '\\';
    }
    size_t n = strlen(to_parts[common + i]);
    memcpy(buf + out, to_parts[common + i], n);
    out += n;
  }
  buf[out] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}
