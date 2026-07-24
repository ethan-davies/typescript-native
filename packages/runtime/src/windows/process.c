#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

static int32_t g_argc = 0;
static char **g_argv = NULL;

void sn_runtime_init(int32_t argc, char **argv) {
  g_argc = argc;
  g_argv = argv;
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
}

void *sn_process_args(void) {
  void *arr = sn_array_new(0, g_argc > 0 ? g_argc : 1, (int64_t)sizeof(char *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(char *));
  for (int32_t i = 0; i < g_argc; i += 1) {
    char *copy = sn_str_concat(g_argv[i] != NULL ? g_argv[i] : "", "");
    sn_array_push(arr, &copy, (int64_t)sizeof(char *));
  }
  return arr;
}

char *sn_process_getenv(const char *name) {
  if (name == NULL) {
    return NULL;
  }
  DWORD needed = GetEnvironmentVariableA(name, NULL, 0);
  if (needed == 0) {
    return NULL;
  }
  char *buf = sn_alloc((int64_t)needed);
  DWORD n = GetEnvironmentVariableA(name, buf, needed);
  if (n == 0 || n >= needed) {
    return NULL;
  }
  sn_gc_set_type(buf, SN_TYPEID_STRING);
  return buf;
}

bool sn_process_setenv(const char *name, const char *value) {
  if (name == NULL || value == NULL) {
    return false;
  }
  return _putenv_s(name, value) == 0;
}

char *sn_process_cwd(void) {
  char buf[MAX_PATH];
  DWORD n = GetCurrentDirectoryA((DWORD)sizeof(buf), buf);
  if (n == 0 || n >= sizeof(buf)) {
    return NULL;
  }
  return sn_str_concat(buf, "");
}

void sn_process_exit(int32_t code) {
  exit((int)code);
}
