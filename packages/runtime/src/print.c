#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

typedef struct SnStringBuilder {
  char *buf;
  int64_t cap;
  int64_t len;
} SnStringBuilder;

static void sb_init(SnStringBuilder *sb) {
  sb->cap = 64;
  sb->len = 0;
  sb->buf = sn_alloc(sb->cap);
  sn_gc_set_type(sb->buf, SN_TYPEID_STRING);
  sb->buf[0] = '\0';
}

static void sb_grow(SnStringBuilder *sb, int64_t needed) {
  if (needed <= sb->cap) {
    return;
  }
  int64_t new_cap = sb->cap;
  while (new_cap < needed) {
    new_cap *= 2;
  }
  sb->buf = sn_realloc(sb->buf, new_cap);
  sn_gc_set_type(sb->buf, SN_TYPEID_STRING);
  sb->cap = new_cap;
}

static void sb_append_literal(SnStringBuilder *sb, const char *text) {
  int64_t text_len = (int64_t)strlen(text);
  sb_grow(sb, sb->len + text_len + 1);
  memcpy(sb->buf + sb->len, text, (size_t)text_len);
  sb->len += text_len;
  sb->buf[sb->len] = '\0';
}

static void sb_append_owned(SnStringBuilder *sb, char *text) {
  sb_append_literal(sb, text);
  sn_free(text);
}

static char *sb_finish(SnStringBuilder *sb) {
  return sb->buf;
}

void sn_print_i32(int32_t value) {
  printf("%d", value);
}

void sn_print_i64(int64_t value) {
  printf("%lld", (long long)value);
}

void sn_print_f32(float value) {
  printf("%g", (double)value);
}

void sn_print_f64(double value) {
  printf("%g", value);
}

void sn_print_bool(bool value) {
  fputs(value ? "true" : "false", stdout);
}

void sn_print_char(char value) {
  putchar(value);
}

void sn_print_str(const char *value) {
  fputs(value, stdout);
}

void sn_print_space(void) {
  putchar(' ');
}

void sn_print_newline(void) {
  putchar('\n');
}

void sn_eprint_i32(int32_t value) {
  fprintf(stderr, "%d", value);
}

void sn_eprint_i64(int64_t value) {
  fprintf(stderr, "%lld", (long long)value);
}

void sn_eprint_f32(float value) {
  fprintf(stderr, "%g", (double)value);
}

void sn_eprint_f64(double value) {
  fprintf(stderr, "%g", value);
}

void sn_eprint_bool(bool value) {
  fputs(value ? "true" : "false", stderr);
}

void sn_eprint_char(char value) {
  fputc(value, stderr);
}

void sn_eprint_str(const char *value) {
  fputs(value, stderr);
}

void sn_eprint_space(void) {
  fputc(' ', stderr);
}

void sn_eprint_newline(void) {
  fputc('\n', stderr);
}

char *sn_read_line(void) {
  SnStringBuilder sb;
  sb_init(&sb);
  int ch;
  while ((ch = fgetc(stdin)) != EOF) {
    if (ch == '\n') {
      break;
    }
    if (ch == '\r') {
      int next = fgetc(stdin);
      if (next != '\n' && next != EOF) {
        ungetc(next, stdin);
      }
      break;
    }
    char tmp[2] = {(char)ch, '\0'};
    sb_append_literal(&sb, tmp);
  }
  return sb_finish(&sb);
}

char *sn_i32_to_string(int32_t value) {
  char *buf = sn_alloc(32);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  snprintf(buf, 32, "%d", value);
  return buf;
}

char *sn_i64_to_string(int64_t value) {
  char *buf = sn_alloc(32);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  snprintf(buf, 32, "%lld", (long long)value);
  return buf;
}

char *sn_f32_to_string(float value) {
  char *buf = sn_alloc(32);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  snprintf(buf, 32, "%g", (double)value);
  return buf;
}

char *sn_f64_to_string(double value) {
  char *buf = sn_alloc(32);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  snprintf(buf, 32, "%g", value);
  return buf;
}

char *sn_bool_to_string(bool value) {
  return sn_str_concat(value ? "true" : "false", "");
  /* sn_str_concat copies the literal; empty right operand keeps a fresh heap string */
}

char *sn_char_to_string(char value) {
  char *buf = sn_alloc(2);
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  buf[0] = value;
  buf[1] = '\0';
  return buf;
}

static char *format_array_element(void *arr, int64_t index, int64_t elem_size, int32_t elem_fmt) {
  SnArray *header = (SnArray *)arr;
  void *slot = (char *)header->data + index * elem_size;

  switch (elem_fmt) {
    case SN_FMT_I32:
      return sn_i32_to_string(*(int32_t *)slot);
    case SN_FMT_I64:
      return sn_i64_to_string(*(int64_t *)slot);
    case SN_FMT_F32:
      return sn_f32_to_string(*(float *)slot);
    case SN_FMT_F64:
      return sn_f64_to_string(*(double *)slot);
    case SN_FMT_BOOL:
      return sn_bool_to_string(*(bool *)slot);
    case SN_FMT_CHAR:
      return sn_char_to_string(*(char *)slot);
    case SN_FMT_STRING:
      return sn_str_concat(*(char **)slot, "");
    default:
      abort();
  }
}

char *sn_array_to_string(void *arr, int64_t elem_size, int32_t elem_fmt) {
  SnArray *header = (SnArray *)arr;
  SnStringBuilder sb;
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

char *sn_map_to_string(void *map) {
  SnMap *header = (SnMap *)map;
  SnStringBuilder sb;
  sb_init(&sb);
  sb_append_literal(&sb, "{");
  for (int64_t i = 0; i < header->len; i += 1) {
    if (i > 0) {
      sb_append_literal(&sb, ", ");
    }
    sb_append_literal(&sb, header->keys[i]);
    sb_append_literal(&sb, ": ");
    /* Values are opaque pointers; print as string when non-null. */
    if (header->vals[i] == NULL) {
      sb_append_literal(&sb, "null");
    } else {
      sb_append_literal(&sb, (const char *)header->vals[i]);
    }
  }
  sb_append_literal(&sb, "}");
  return sb_finish(&sb);
}
