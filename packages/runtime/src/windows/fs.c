#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

char *sn_fs_read_file(const char *path) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    return NULL;
  }
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  long size = ftell(f);
  if (size < 0) {
    fclose(f);
    return NULL;
  }
  if (fseek(f, 0, SEEK_SET) != 0) {
    fclose(f);
    return NULL;
  }
  char *buf = sn_alloc((int64_t)size + 1);
  size_t n = fread(buf, 1, (size_t)size, f);
  fclose(f);
  buf[n] = '\0';
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

bool sn_fs_write_file(const char *path, const char *contents) {
  FILE *f = fopen(path, "wb");
  if (f == NULL) {
    return false;
  }
  size_t len = contents != NULL ? strlen(contents) : 0;
  size_t n = fwrite(contents != NULL ? contents : "", 1, len, f);
  fclose(f);
  return n == len;
}

bool sn_fs_append_file(const char *path, const char *contents) {
  FILE *f = fopen(path, "ab");
  if (f == NULL) {
    return false;
  }
  size_t len = contents != NULL ? strlen(contents) : 0;
  size_t n = fwrite(contents != NULL ? contents : "", 1, len, f);
  fclose(f);
  return n == len;
}

bool sn_fs_exists(const char *path) {
  if (path == NULL) {
    return false;
  }
  DWORD attrs = GetFileAttributesA(path);
  return attrs != INVALID_FILE_ATTRIBUTES;
}

bool sn_fs_delete_file(const char *path) {
  return path != NULL && DeleteFileA(path) != 0;
}

bool sn_fs_copy_file(const char *src, const char *dst) {
  if (src == NULL || dst == NULL) {
    return false;
  }
  return CopyFileA(src, dst, FALSE) != 0;
}

bool sn_fs_move_file(const char *src, const char *dst) {
  if (src == NULL || dst == NULL) {
    return false;
  }
  return MoveFileExA(src, dst, MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED) != 0;
}

bool sn_fs_create_dir(const char *path) {
  if (path == NULL) {
    return false;
  }
  if (CreateDirectoryA(path, NULL) != 0) {
    return true;
  }
  return GetLastError() == ERROR_ALREADY_EXISTS;
}

bool sn_fs_delete_dir(const char *path) {
  return path != NULL && RemoveDirectoryA(path) != 0;
}

void *sn_fs_list_dir(const char *path) {
  if (path == NULL) {
    return NULL;
  }

  size_t path_len = strlen(path);
  bool has_sep = path_len > 0 && (path[path_len - 1] == '\\' || path[path_len - 1] == '/');
  size_t pattern_len = path_len + (has_sep ? 1 : 2) + 1; /* path + \ + * + NUL */
  char *pattern = (char *)malloc(pattern_len);
  if (pattern == NULL) {
    return NULL;
  }
  memcpy(pattern, path, path_len);
  size_t out = path_len;
  if (!has_sep) {
    pattern[out++] = '\\';
  }
  pattern[out++] = '*';
  pattern[out] = '\0';

  WIN32_FIND_DATAA data;
  HANDLE handle = FindFirstFileA(pattern, &data);
  free(pattern);
  if (handle == INVALID_HANDLE_VALUE) {
    return NULL;
  }

  void *arr = sn_array_new(0, 8, (int64_t)sizeof(char *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(char *));

  do {
    if (strcmp(data.cFileName, ".") == 0 || strcmp(data.cFileName, "..") == 0) {
      continue;
    }
    char *name = sn_str_concat(data.cFileName, "");
    sn_array_push(arr, &name, (int64_t)sizeof(char *));
  } while (FindNextFileA(handle, &data) != 0);

  FindClose(handle);
  return arr;
}

static int64_t filetime_to_unix_ms(const FILETIME *ft) {
  ULARGE_INTEGER uli;
  uli.LowPart = ft->dwLowDateTime;
  uli.HighPart = ft->dwHighDateTime;
  /* FILETIME is 100-ns intervals since 1601-01-01. */
  return (int64_t)(uli.QuadPart / 10000ULL) - 11644473600000LL;
}

bool sn_fs_stat(const char *path, SnFileStat *out) {
  if (path == NULL || out == NULL) {
    return false;
  }
  WIN32_FILE_ATTRIBUTE_DATA data;
  if (!GetFileAttributesExA(path, GetFileExInfoStandard, &data)) {
    return false;
  }
  ULARGE_INTEGER size;
  size.LowPart = data.nFileSizeLow;
  size.HighPart = data.nFileSizeHigh;
  out->size = (int64_t)size.QuadPart;
  out->mtime_ms = filetime_to_unix_ms(&data.ftLastWriteTime);
  out->is_dir = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? 1 : 0;
  out->is_file = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ? 1 : 0;
  out->mode = 0;
  return true;
}

int64_t sn_fs_size(const char *path) {
  SnFileStat st;
  if (!sn_fs_stat(path, &st)) {
    return -1;
  }
  return st.size;
}

bool sn_fs_is_dir(const char *path) {
  SnFileStat st;
  return sn_fs_stat(path, &st) && st.is_dir != 0;
}

bool sn_fs_is_file(const char *path) {
  SnFileStat st;
  return sn_fs_stat(path, &st) && st.is_file != 0;
}
