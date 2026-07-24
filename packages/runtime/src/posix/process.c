#define _POSIX_C_SOURCE 200809L

#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "sn/runtime.h"

static int32_t g_argc = 0;
static char **g_argv = NULL;

void sn_runtime_init(int32_t argc, char **argv) {
  g_argc = argc;
  g_argv = argv;
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
  const char *value = getenv(name);
  if (value == NULL) {
    return NULL;
  }
  return sn_str_concat(value, "");
}

bool sn_process_setenv(const char *name, const char *value) {
  return setenv(name, value, 1) == 0;
}

char *sn_process_cwd(void) {
  char buf[4096];
  if (getcwd(buf, sizeof(buf)) == NULL) {
    return NULL;
  }
  return sn_str_concat(buf, "");
}

void sn_process_exit(int32_t code) {
  exit((int)code);
}
