#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tsn/runtime.h"

typedef struct TsnStringBuilder {
  char *buf;
  int64_t cap;
  int64_t len;
} TsnStringBuilder;

static void sb_init(TsnStringBuilder *sb) {
  sb->cap = 64;
  sb->len = 0;
  sb->buf = tsn_alloc(sb->cap);
  sb->buf[0] = '\0';
}

static void sb_grow(TsnStringBuilder *sb, int64_t needed) {
  if (needed <= sb->cap) {
    return;
  }
  int64_t new_cap = sb->cap;
  while (new_cap < needed) {
    new_cap *= 2;
  }
  sb->buf = tsn_realloc(sb->buf, new_cap);
  sb->cap = new_cap;
}

static void sb_append_literal(TsnStringBuilder *sb, const char *text) {
  int64_t text_len = (int64_t)strlen(text);
  sb_grow(sb, sb->len + text_len + 1);
  memcpy(sb->buf + sb->len, text, (size_t)text_len);
  sb->len += text_len;
  sb->buf[sb->len] = '\0';
}

static void sb_append_owned(TsnStringBuilder *sb, char *text) {
  sb_append_literal(sb, text);
  tsn_free(text);
}

static char *sb_finish(TsnStringBuilder *sb) {
  return sb->buf;
}

void tsn_print_i32(int32_t value) {
  printf("%d", value);
}

void tsn_print_i64(int64_t value) {
  printf("%lld", (long long)value);
}

void tsn_print_f32(float value) {
  printf("%g", (double)value);
}

void tsn_print_f64(double value) {
  printf("%g", value);
}

void tsn_print_bool(bool value) {
  fputs(value ? "true" : "false", stdout);
}

void tsn_print_char(char value) {
  putchar(value);
}

void tsn_print_str(const char *value) {
  fputs(value, stdout);
}

void tsn_print_space(void) {
  putchar(' ');
}

void tsn_print_newline(void) {
  putchar('\n');
}

char *tsn_i32_to_string(int32_t value) {
  char *buf = tsn_alloc(32);
  snprintf(buf, 32, "%d", value);
  return buf;
}

char *tsn_i64_to_string(int64_t value) {
  char *buf = tsn_alloc(32);
  snprintf(buf, 32, "%lld", (long long)value);
  return buf;
}

char *tsn_f32_to_string(float value) {
  char *buf = tsn_alloc(32);
  snprintf(buf, 32, "%g", (double)value);
  return buf;
}

char *tsn_f64_to_string(double value) {
  char *buf = tsn_alloc(32);
  snprintf(buf, 32, "%g", value);
  return buf;
}

char *tsn_bool_to_string(bool value) {
  return tsn_str_concat(value ? "true" : "false", "");
  /* tsn_str_concat copies the literal; empty right operand keeps a fresh heap string */
}

char *tsn_char_to_string(char value) {
  char *buf = tsn_alloc(2);
  buf[0] = value;
  buf[1] = '\0';
  return buf;
}

static char *format_array_element(void *arr, int64_t index, int64_t elem_size, int32_t elem_fmt) {
  TsnArray *header = (TsnArray *)arr;
  void *slot = (char *)header->data + index * elem_size;

  switch (elem_fmt) {
    case TSN_FMT_I32:
      return tsn_i32_to_string(*(int32_t *)slot);
    case TSN_FMT_I64:
      return tsn_i64_to_string(*(int64_t *)slot);
    case TSN_FMT_F32:
      return tsn_f32_to_string(*(float *)slot);
    case TSN_FMT_F64:
      return tsn_f64_to_string(*(double *)slot);
    case TSN_FMT_BOOL:
      return tsn_bool_to_string(*(bool *)slot);
    case TSN_FMT_CHAR:
      return tsn_char_to_string(*(char *)slot);
    case TSN_FMT_STRING:
      return tsn_str_concat(*(char **)slot, "");
    default:
      abort();
  }
}

char *tsn_array_to_string(void *arr, int64_t elem_size, int32_t elem_fmt) {
  TsnArray *header = (TsnArray *)arr;
  TsnStringBuilder sb;
  sb_init(&sb);
  sb_append_literal(&sb, "[");

  for (int64_t i = 0; i < header->length; i += 1) {
    if (i > 0) {
      sb_append_literal(&sb, ", ");
    }
    sb_append_owned(&sb, format_array_element(arr, i, elem_size, elem_fmt));
  }

  sb_append_literal(&sb, "]");
  return sb_finish(&sb);
}
