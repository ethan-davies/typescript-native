#include "tsn/runtime.h"

#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct TsnEhFrame {
  struct TsnEhFrame *parent;
  jmp_buf buf;
  int has_catch;
  TsnFinallyFn finally_fn;
  void *finally_ctx;
} TsnEhFrame;

_Static_assert(sizeof(TsnEhFrame) <= TSN_EH_FRAME_SIZE, "TSN_EH_FRAME_SIZE is too small");

static _Thread_local struct TsnEhFrame *tsn_eh_stack = NULL;
static _Thread_local void *tsn_eh_current_exception = NULL;

void tsn_eh_init_frame(void *frame, int32_t has_catch, TsnFinallyFn finally_fn, void *finally_ctx) {
  TsnEhFrame *f = (TsnEhFrame *)frame;
  f->parent = NULL;
  f->has_catch = has_catch;
  f->finally_fn = finally_fn;
  f->finally_ctx = finally_ctx;
}

void tsn_eh_push(void *frame) {
  TsnEhFrame *f = (TsnEhFrame *)frame;
  f->parent = tsn_eh_stack;
  tsn_eh_stack = f;
}

void tsn_eh_pop(void *frame) {
  TsnEhFrame *f = (TsnEhFrame *)frame;
  if (tsn_eh_stack == f) {
    tsn_eh_stack = f->parent;
  }
}

jmp_buf *tsn_eh_jmp_buf(void *frame) {
  return &((TsnEhFrame *)frame)->buf;
}

void *tsn_eh_caught_exception(void) {
  return tsn_eh_current_exception;
}

void tsn_uncaught_exception(void *error) {
  char *message = "";
  if (error != NULL) {
    void **fields = (void **)error;
    if (fields[1] != NULL) {
      message = (char *)fields[1];
    }
  }
  fprintf(stderr, "Uncaught Error: %s\n", message);
}

void tsn_throw(void *error) {
  tsn_eh_current_exception = error;
  struct TsnEhFrame *f = tsn_eh_stack;
  while (f != NULL) {
    if (f->has_catch) {
      longjmp(f->buf, 1);
    }
    if (f->finally_fn != NULL) {
      f->finally_fn(f->finally_ctx);
    }
    tsn_eh_stack = f->parent;
    f = tsn_eh_stack;
  }
  tsn_uncaught_exception(error);
  abort();
}
