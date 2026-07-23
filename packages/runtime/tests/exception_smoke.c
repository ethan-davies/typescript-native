#include "sn/runtime.h"

#include <setjmp.h>
#include <stdio.h>
#include <string.h>

static void callee(void) {
  char msg[] = "test error";
  char *error_fields[2];
  error_fields[0] = NULL;
  error_fields[1] = msg;
  sn_throw((void *)error_fields);
}

int main(void) {
  char frame[SN_EH_FRAME_SIZE];
  sn_eh_init_frame(frame, 1, NULL, NULL);
  sn_eh_push(frame);
  if (setjmp(*sn_eh_jmp_buf(frame)) == 0) {
    callee();
    printf("no catch\n");
  } else {
    void *err = sn_eh_caught_exception();
    char **fields = (char **)err;
    printf("caught: %s\n", fields[1]);
  }
  sn_eh_pop(frame);
  return 0;
}
