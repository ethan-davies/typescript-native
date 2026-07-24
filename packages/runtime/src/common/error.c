#include "error.h"

#include <stdio.h>
#include <string.h>

#include "sn/runtime.h"

void *sn_error_from_errno(int err, const char *context) {
  char buf[512];
  const char *sys = strerror(err);
  if (sys == NULL) {
    sys = "unknown error";
  }
  if (context != NULL && context[0] != '\0') {
    snprintf(buf, sizeof(buf), "%s: %s", context, sys);
  } else {
    snprintf(buf, sizeof(buf), "%s", sys);
  }
  return sn_error_new(buf);
}

void *sn_error_from_code(const char *code, const char *message) {
  char buf[512];
  const char *c = code != NULL ? code : "Error";
  const char *m = message != NULL ? message : "";
  if (m[0] != '\0') {
    snprintf(buf, sizeof(buf), "%s: %s", c, m);
  } else {
    snprintf(buf, sizeof(buf), "%s", c);
  }
  return sn_error_new(buf);
}
