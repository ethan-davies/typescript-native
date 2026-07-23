#include <ctype.h>
#include <string.h>

#include "sn/runtime.h"

int32_t sn_str_len(const char *s) {
  return (int32_t)strlen(s);
}

char *sn_str_concat(const char *left, const char *right) {
  size_t left_len = strlen(left);
  size_t right_len = strlen(right);
  char *buf = sn_alloc((int64_t)(left_len + right_len + 1));
  memcpy(buf, left, left_len);
  memcpy(buf + left_len, right, right_len + 1);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

int32_t sn_str_index_of(const char *haystack, const char *needle) {
  if (needle[0] == '\0') {
    return 0;
  }
  const char *found = strstr(haystack, needle);
  if (found == NULL) {
    return -1;
  }
  return (int32_t)(found - haystack);
}

bool sn_str_contains(const char *haystack, const char *needle) {
  return sn_str_index_of(haystack, needle) >= 0;
}

bool sn_str_starts_with(const char *s, const char *prefix) {
  size_t n = strlen(prefix);
  return strncmp(s, prefix, n) == 0;
}

bool sn_str_ends_with(const char *s, const char *suffix) {
  size_t s_len = strlen(s);
  size_t n = strlen(suffix);
  if (n > s_len) {
    return false;
  }
  return strcmp(s + (s_len - n), suffix) == 0;
}

char *sn_str_substring(const char *s, int32_t start, int32_t end) {
  int32_t len = sn_str_len(s);
  if (start < 0) {
    start = 0;
  }
  if (end > len) {
    end = len;
  }
  if (start > end) {
    start = end;
  }
  int32_t n = end - start;
  char *buf = sn_alloc((int64_t)n + 1);
  memcpy(buf, s + start, (size_t)n);
  buf[n] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

static bool is_ascii_space(unsigned char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

char *sn_str_trim(const char *s) {
  const char *start = s;
  while (*start != '\0' && is_ascii_space((unsigned char)*start)) {
    start += 1;
  }
  const char *end = start + strlen(start);
  while (end > start && is_ascii_space((unsigned char)end[-1])) {
    end -= 1;
  }
  size_t n = (size_t)(end - start);
  char *buf = sn_alloc((int64_t)n + 1);
  memcpy(buf, start, n);
  buf[n] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_str_to_upper(const char *s) {
  size_t n = strlen(s);
  char *buf = sn_alloc((int64_t)n + 1);
  for (size_t i = 0; i < n; i += 1) {
    buf[i] = (char)toupper((unsigned char)s[i]);
  }
  buf[n] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_str_to_lower(const char *s) {
  size_t n = strlen(s);
  char *buf = sn_alloc((int64_t)n + 1);
  for (size_t i = 0; i < n; i += 1) {
    buf[i] = (char)tolower((unsigned char)s[i]);
  }
  buf[n] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_str_replace(const char *s, const char *from, const char *to) {
  if (from[0] == '\0') {
    return sn_str_concat(s, "");
  }
  const char *found = strstr(s, from);
  if (found == NULL) {
    return sn_str_concat(s, "");
  }
  size_t prefix_len = (size_t)(found - s);
  size_t from_len = strlen(from);
  size_t to_len = strlen(to);
  size_t suffix_len = strlen(found + from_len);
  char *buf = sn_alloc((int64_t)(prefix_len + to_len + suffix_len + 1));
  memcpy(buf, s, prefix_len);
  memcpy(buf + prefix_len, to, to_len);
  memcpy(buf + prefix_len + to_len, found + from_len, suffix_len + 1);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

char *sn_str_split(const char *s, const char *sep) {
  /* Returns a string[] of parts. Empty separator splits into characters. */
  size_t sep_len = strlen(sep);
  int64_t count = 0;

  if (sep_len == 0) {
    count = (int64_t)strlen(s);
    void *arr = sn_array_new(0, count > 0 ? count : 1, (int64_t)sizeof(char *));
    sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(char *));
    for (int64_t i = 0; i < count; i += 1) {
      char *part = sn_alloc(2);
      part[0] = s[i];
      part[1] = '\0';
      sn_gc_set_type(part, SN_TYPEID_STRING);
      sn_array_push(arr, &part, (int64_t)sizeof(char *));
    }
    return (char *)arr;
  }

  const char *cursor = s;
  while (true) {
    const char *found = strstr(cursor, sep);
    count += 1;
    if (found == NULL) {
      break;
    }
    cursor = found + sep_len;
  }

  void *arr = sn_array_new(0, count > 0 ? count : 1, (int64_t)sizeof(char *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(char *));
  cursor = s;
  for (int64_t i = 0; i < count; i += 1) {
    const char *found = strstr(cursor, sep);
    size_t part_len = found == NULL ? strlen(cursor) : (size_t)(found - cursor);
    char *part = sn_alloc((int64_t)part_len + 1);
    memcpy(part, cursor, part_len);
    part[part_len] = '\0';
    sn_gc_set_type(part, SN_TYPEID_STRING);
    sn_array_push(arr, &part, (int64_t)sizeof(char *));
    if (found == NULL) {
      break;
    }
    cursor = found + sep_len;
  }
  return (char *)arr;
}

char sn_str_char_at(const char *s, int32_t index) {
  int32_t len = sn_str_len(s);
  if (index < 0 || index >= len) {
    return '\0';
  }
  return s[index];
}

char *sn_str_repeat(const char *s, int32_t count) {
  if (count <= 0) {
    char *empty = sn_alloc(1);
    empty[0] = '\0';
    sn_gc_set_type(empty, SN_TYPEID_STRING);
    return empty;
  }
  size_t n = strlen(s);
  char *buf = sn_alloc((int64_t)n * (int64_t)count + 1);
  for (int32_t i = 0; i < count; i += 1) {
    memcpy(buf + ((size_t)i * n), s, n);
  }
  buf[(size_t)n * (size_t)count] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

static char *pad_with(const char *s, int32_t target_len, const char *pad, bool at_start) {
  int32_t len = sn_str_len(s);
  if (target_len <= len) {
    return sn_str_concat(s, "");
  }
  const char *pad_src = (pad != NULL && pad[0] != '\0') ? pad : " ";
  size_t pad_len = strlen(pad_src);
  int32_t need = target_len - len;
  char *filler = sn_alloc((int64_t)need + 1);
  for (int32_t i = 0; i < need; i += 1) {
    filler[i] = pad_src[(size_t)i % pad_len];
  }
  filler[need] = '\0';
  sn_gc_set_type(filler, SN_TYPEID_STRING);
  char *result = at_start ? sn_str_concat(filler, s) : sn_str_concat(s, filler);
  sn_free(filler);
  return result;
}

char *sn_str_pad_start(const char *s, int32_t target_len, const char *pad) {
  return pad_with(s, target_len, pad, true);
}

char *sn_str_pad_end(const char *s, int32_t target_len, const char *pad) {
  return pad_with(s, target_len, pad, false);
}

char *sn_str_join(void *parts, const char *sep) {
  SnArray *header = (SnArray *)parts;
  if (header->length == 0) {
    char *empty = sn_alloc(1);
    empty[0] = '\0';
    sn_gc_set_type(empty, SN_TYPEID_STRING);
    return empty;
  }
  size_t sep_len = strlen(sep);
  size_t total = 0;
  for (int64_t i = 0; i < header->length; i += 1) {
    char **slot = (char **)((char *)header->data + i * (int64_t)sizeof(char *));
    total += strlen(*slot);
    if (i + 1 < header->length) {
      total += sep_len;
    }
  }
  char *buf = sn_alloc((int64_t)total + 1);
  size_t cursor = 0;
  for (int64_t i = 0; i < header->length; i += 1) {
    char **slot = (char **)((char *)header->data + i * (int64_t)sizeof(char *));
    size_t part_len = strlen(*slot);
    memcpy(buf + cursor, *slot, part_len);
    cursor += part_len;
    if (i + 1 < header->length) {
      memcpy(buf + cursor, sep, sep_len);
      cursor += sep_len;
    }
  }
  buf[total] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

int32_t sn_str_last_index_of(const char *haystack, const char *needle) {
  if (needle[0] == '\0') {
    return sn_str_len(haystack);
  }
  size_t needle_len = strlen(needle);
  size_t hay_len = strlen(haystack);
  if (needle_len > hay_len) {
    return -1;
  }
  for (size_t i = hay_len - needle_len + 1; i > 0; i -= 1) {
    size_t start = i - 1;
    if (strncmp(haystack + start, needle, needle_len) == 0) {
      return (int32_t)start;
    }
  }
  return -1;
}
