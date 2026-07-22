#include "tsn/runtime.h"

#include <setjmp.h>
#include <stdio.h>
#include <string.h>

static void callee(void) {
  char msg[] = "test error";
  char *error_fields[2];
  error_fields[0] = NULL;
  error_fields[1] = msg;
  tsn_throw((void *)error_fields);
}

int main(void) {
  char frame[TSN_EH_FRAME_SIZE];
  tsn_eh_init_frame(frame, 1, NULL, NULL);
  tsn_eh_push(frame);
  if (setjmp(*tsn_eh_jmp_buf(frame)) == 0) {
    callee();
    printf("no catch\n");
  } else {
    void *err = tsn_eh_caught_exception();
    char **fields = (char **)err;
    printf("caught: %s\n", fields[1]);
  }
  tsn_eh_pop(frame);
  return 0;
}
