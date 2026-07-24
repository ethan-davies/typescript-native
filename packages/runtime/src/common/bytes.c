#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

static int64_t handle_of(void *p) {
  return (int64_t)(intptr_t)p;
}

static SnBytes *bytes_of(int64_t handle) {
  return (SnBytes *)(intptr_t)handle;
}

void *sn_bytes_new(int64_t length) {
  if (length < 0) {
    length = 0;
  }
  int64_t cap = length > 0 ? length : 4;
  SnBytes *b = (SnBytes *)sn_alloc((int64_t)sizeof(SnBytes));
  b->length = length;
  b->capacity = cap;
  b->data = (uint8_t *)sn_alloc(cap);
  if (length > 0) {
    memset(b->data, 0, (size_t)length);
  }
  sn_gc_set_type(b, SN_TYPEID_BYTES);
  sn_gc_set_type(b->data, 0);
  return b;
}

void *sn_bytes_with_capacity(int64_t capacity) {
  if (capacity < 0) {
    capacity = 0;
  }
  if (capacity == 0) {
    capacity = 4;
  }
  SnBytes *b = (SnBytes *)sn_alloc((int64_t)sizeof(SnBytes));
  b->length = 0;
  b->capacity = capacity;
  b->data = (uint8_t *)sn_alloc(capacity);
  sn_gc_set_type(b, SN_TYPEID_BYTES);
  sn_gc_set_type(b->data, 0);
  return b;
}

int64_t sn_bytes_from_ptr(void *bytes) {
  return handle_of(bytes);
}

void *sn_bytes_to_ptr(int64_t handle) {
  return (void *)(intptr_t)handle;
}

int64_t sn_bytes_len(int64_t handle) {
  SnBytes *b = bytes_of(handle);
  if (b == NULL) {
    return 0;
  }
  return b->length;
}

int32_t sn_bytes_get(int64_t handle, int32_t index) {
  SnBytes *b = bytes_of(handle);
  if (b == NULL || index < 0 || (int64_t)index >= b->length) {
    return 0;
  }
  return (int32_t)b->data[index];
}

void sn_bytes_set(int64_t handle, int32_t index, int32_t value) {
  SnBytes *b = bytes_of(handle);
  if (b == NULL || index < 0 || (int64_t)index >= b->length) {
    return;
  }
  b->data[index] = (uint8_t)(value & 0xff);
}

int64_t sn_bytes_slice(int64_t handle, int32_t start, int32_t end) {
  SnBytes *b = bytes_of(handle);
  if (b == NULL) {
    return handle_of(sn_bytes_new(0));
  }
  if (start < 0) {
    start = 0;
  }
  if (end < start) {
    end = start;
  }
  if ((int64_t)end > b->length) {
    end = (int32_t)b->length;
  }
  if ((int64_t)start > b->length) {
    start = (int32_t)b->length;
    end = start;
  }
  int64_t n = (int64_t)end - (int64_t)start;
  SnBytes *out = (SnBytes *)sn_bytes_new(n);
  if (n > 0) {
    memcpy(out->data, b->data + start, (size_t)n);
  }
  return handle_of(out);
}

int64_t sn_bytes_from_cstr(const char *s) {
  if (s == NULL) {
    return handle_of(sn_bytes_new(0));
  }
  int64_t n = (int64_t)strlen(s);
  SnBytes *b = (SnBytes *)sn_bytes_new(n);
  if (n > 0) {
    memcpy(b->data, s, (size_t)n);
  }
  return handle_of(b);
}

static int utf8_valid(const uint8_t *data, int64_t len) {
  int64_t i = 0;
  while (i < len) {
    uint8_t c = data[i];
    if (c <= 0x7f) {
      i += 1;
      continue;
    }
    int need = 0;
    if ((c & 0xe0) == 0xc0) {
      need = 1;
    } else if ((c & 0xf0) == 0xe0) {
      need = 2;
    } else if ((c & 0xf8) == 0xf0) {
      need = 3;
    } else {
      return 0;
    }
    if (i + need >= len) {
      return 0;
    }
    for (int j = 1; j <= need; j += 1) {
      if ((data[i + j] & 0xc0) != 0x80) {
        return 0;
      }
    }
    i += need + 1;
  }
  return 1;
}

char *sn_bytes_to_utf8(int64_t handle) {
  SnBytes *b = bytes_of(handle);
  if (b == NULL) {
    return sn_str_concat("", "");
  }
  if (!utf8_valid(b->data, b->length)) {
    return NULL;
  }
  char *s = (char *)sn_alloc(b->length + 1);
  if (b->length > 0) {
    memcpy(s, b->data, (size_t)b->length);
  }
  s[b->length] = '\0';
  sn_gc_set_type(s, SN_TYPEID_STRING);
  return s;
}

int64_t sn_bytes_concat(int64_t left, int64_t right) {
  SnBytes *a = bytes_of(left);
  SnBytes *b = bytes_of(right);
  int64_t al = a != NULL ? a->length : 0;
  int64_t bl = b != NULL ? b->length : 0;
  SnBytes *out = (SnBytes *)sn_bytes_new(al + bl);
  if (al > 0) {
    memcpy(out->data, a->data, (size_t)al);
  }
  if (bl > 0) {
    memcpy(out->data + al, b->data, (size_t)bl);
  }
  return handle_of(out);
}

/* Used by net/tls: create from raw buffer (copies). */
int64_t sn_bytes_copy_from(const void *data, int64_t length) {
  if (length < 0) {
    length = 0;
  }
  SnBytes *b = (SnBytes *)sn_bytes_new(length);
  if (length > 0 && data != NULL) {
    memcpy(b->data, data, (size_t)length);
  }
  return handle_of(b);
}
