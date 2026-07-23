#include <ctype.h>
#include <stdint.h>
#include <string.h>

#include "sn/runtime.h"

static const char BASE64_TABLE[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *sn_base64_encode(const char *data) {
  if (data == NULL) {
    data = "";
  }
  size_t len = strlen(data);
  size_t out_len = ((len + 2) / 3) * 4;
  char *out = sn_alloc((int64_t)out_len + 1);
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    unsigned char a = (unsigned char)data[i];
    unsigned char b = (i + 1 < len) ? (unsigned char)data[i + 1] : 0;
    unsigned char c = (i + 2 < len) ? (unsigned char)data[i + 2] : 0;
    uint32_t triple = ((uint32_t)a << 16) | ((uint32_t)b << 8) | (uint32_t)c;
    out[o++] = BASE64_TABLE[(triple >> 18) & 63];
    out[o++] = BASE64_TABLE[(triple >> 12) & 63];
    out[o++] = (i + 1 < len) ? BASE64_TABLE[(triple >> 6) & 63] : '=';
    out[o++] = (i + 2 < len) ? BASE64_TABLE[triple & 63] : '=';
  }
  out[o] = '\0';
  sn_gc_set_type(out, SN_TYPEID_STRING);
  return out;
}

static int base64_value(char c) {
  if (c >= 'A' && c <= 'Z') {
    return c - 'A';
  }
  if (c >= 'a' && c <= 'z') {
    return c - 'a' + 26;
  }
  if (c >= '0' && c <= '9') {
    return c - '0' + 52;
  }
  if (c == '+') {
    return 62;
  }
  if (c == '/') {
    return 63;
  }
  return -1;
}

char *sn_base64_decode(const char *data) {
  if (data == NULL) {
    return NULL;
  }
  size_t len = strlen(data);
  if (len % 4 != 0) {
    return NULL;
  }
  size_t pad = 0;
  if (len >= 1 && data[len - 1] == '=') {
    pad += 1;
  }
  if (len >= 2 && data[len - 2] == '=') {
    pad += 1;
  }
  size_t out_len = (len / 4) * 3 - pad;
  char *out = sn_alloc((int64_t)out_len + 1);
  size_t o = 0;
  for (size_t i = 0; i < len; i += 4) {
    int v0 = base64_value(data[i]);
    int v1 = base64_value(data[i + 1]);
    int v2 = data[i + 2] == '=' ? 0 : base64_value(data[i + 2]);
    int v3 = data[i + 3] == '=' ? 0 : base64_value(data[i + 3]);
    if (v0 < 0 || v1 < 0 || (data[i + 2] != '=' && v2 < 0) || (data[i + 3] != '=' && v3 < 0)) {
      return NULL;
    }
    uint32_t triple = ((uint32_t)v0 << 18) | ((uint32_t)v1 << 12) | ((uint32_t)v2 << 6) | (uint32_t)v3;
    if (o < out_len) {
      out[o++] = (char)((triple >> 16) & 0xff);
    }
    if (o < out_len) {
      out[o++] = (char)((triple >> 8) & 0xff);
    }
    if (o < out_len) {
      out[o++] = (char)(triple & 0xff);
    }
  }
  out[out_len] = '\0';
  sn_gc_set_type(out, SN_TYPEID_STRING);
  return out;
}

static char hex_digit(unsigned char v) {
  return (char)(v < 10 ? ('0' + v) : ('a' + (v - 10)));
}

char *sn_hex_encode(const char *data) {
  if (data == NULL) {
    data = "";
  }
  size_t len = strlen(data);
  char *out = sn_alloc((int64_t)len * 2 + 1);
  for (size_t i = 0; i < len; i += 1) {
    unsigned char c = (unsigned char)data[i];
    out[i * 2] = hex_digit((unsigned char)(c >> 4));
    out[i * 2 + 1] = hex_digit((unsigned char)(c & 0xf));
  }
  out[len * 2] = '\0';
  sn_gc_set_type(out, SN_TYPEID_STRING);
  return out;
}

static int hex_value(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

char *sn_hex_decode(const char *data) {
  if (data == NULL) {
    return NULL;
  }
  size_t len = strlen(data);
  if (len % 2 != 0) {
    return NULL;
  }
  size_t out_len = len / 2;
  char *out = sn_alloc((int64_t)out_len + 1);
  for (size_t i = 0; i < out_len; i += 1) {
    int hi = hex_value(data[i * 2]);
    int lo = hex_value(data[i * 2 + 1]);
    if (hi < 0 || lo < 0) {
      return NULL;
    }
    out[i] = (char)((hi << 4) | lo);
  }
  out[out_len] = '\0';
  sn_gc_set_type(out, SN_TYPEID_STRING);
  return out;
}

int32_t sn_utf8_byte_len(const char *s) {
  return sn_str_len(s);
}

bool sn_utf8_is_valid(const char *s) {
  if (s == NULL) {
    return false;
  }
  const unsigned char *p = (const unsigned char *)s;
  while (*p != '\0') {
    if (*p <= 0x7f) {
      p += 1;
      continue;
    }
    if ((*p & 0xe0) == 0xc0) {
      if ((p[1] & 0xc0) != 0x80) {
        return false;
      }
      p += 2;
      continue;
    }
    if ((*p & 0xf0) == 0xe0) {
      if ((p[1] & 0xc0) != 0x80 || (p[2] & 0xc0) != 0x80) {
        return false;
      }
      p += 3;
      continue;
    }
    if ((*p & 0xf8) == 0xf0) {
      if ((p[1] & 0xc0) != 0x80 || (p[2] & 0xc0) != 0x80 || (p[3] & 0xc0) != 0x80) {
        return false;
      }
      p += 4;
      continue;
    }
    return false;
  }
  return true;
}
