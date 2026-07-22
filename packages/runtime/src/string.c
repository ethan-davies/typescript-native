#include <string.h>

#include "tsn/runtime.h"

int32_t tsn_str_len(const char *s) {
  return (int32_t)strlen(s);
}

char *tsn_str_concat(const char *left, const char *right) {
  size_t left_len = strlen(left);
  size_t right_len = strlen(right);
  char *buf = tsn_alloc((int64_t)(left_len + right_len + 1));
  memcpy(buf, left, left_len);
  memcpy(buf + left_len, right, right_len + 1);
  return buf;
}
