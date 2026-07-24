#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

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
  size_t len = strlen(contents);
  size_t n = fwrite(contents, 1, len, f);
  fclose(f);
  return n == len;
}

bool sn_fs_append_file(const char *path, const char *contents) {
  FILE *f = fopen(path, "ab");
  if (f == NULL) {
    return false;
  }
  size_t len = strlen(contents);
  size_t n = fwrite(contents, 1, len, f);
  fclose(f);
  return n == len;
}

bool sn_fs_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

bool sn_fs_delete_file(const char *path) {
  return unlink(path) == 0;
}

bool sn_fs_copy_file(const char *src, const char *dst) {
  char *contents = sn_fs_read_file(src);
  if (contents == NULL) {
    return false;
  }
  return sn_fs_write_file(dst, contents);
}

bool sn_fs_move_file(const char *src, const char *dst) {
  if (rename(src, dst) == 0) {
    return true;
  }
  if (!sn_fs_copy_file(src, dst)) {
    return false;
  }
  return sn_fs_delete_file(src);
}

bool sn_fs_create_dir(const char *path) {
  return mkdir(path, 0755) == 0 || errno == EEXIST;
}

bool sn_fs_delete_dir(const char *path) {
  return rmdir(path) == 0;
}

void *sn_fs_list_dir(const char *path) {
  DIR *dir = opendir(path);
  if (dir == NULL) {
    return NULL;
  }
  void *arr = sn_array_new(0, 8, (int64_t)sizeof(char *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(char *));
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    char *name = sn_str_concat(entry->d_name, "");
    sn_array_push(arr, &name, (int64_t)sizeof(char *));
  }
  closedir(dir);
  return arr;
}

bool sn_fs_stat(const char *path, SnFileStat *out) {
  if (path == NULL || out == NULL) {
    return false;
  }
  struct stat st;
  if (stat(path, &st) != 0) {
    return false;
  }
  out->size = (int64_t)st.st_size;
  out->mtime_ms = (int64_t)st.st_mtime * 1000;
  out->is_dir = S_ISDIR(st.st_mode) ? 1 : 0;
  out->is_file = S_ISREG(st.st_mode) ? 1 : 0;
  out->mode = (int32_t)(st.st_mode & 0777);
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
