#include "sn/runtime.h"

#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct SnEhFrame {
  struct SnEhFrame *parent;
  jmp_buf buf;
  int has_catch;
  SnFinallyFn finally_fn;
  void *finally_ctx;
  int32_t root_checkpoint;
} SnEhFrame;

_Static_assert(sizeof(SnEhFrame) <= SN_EH_FRAME_SIZE, "SN_EH_FRAME_SIZE is too small");

static _Thread_local struct SnEhFrame *sn_eh_stack = NULL;
static _Thread_local void *sn_eh_current_exception = NULL;
static _Thread_local int sn_eh_exception_root_registered = 0;

static void ensure_exception_root(void) {
  if (!sn_eh_exception_root_registered) {
    sn_gc_set_exception_root(&sn_eh_current_exception);
    sn_eh_exception_root_registered = 1;
  }
}

void sn_eh_init_frame(void *frame, int32_t has_catch, SnFinallyFn finally_fn, void *finally_ctx) {
  SnEhFrame *f = (SnEhFrame *)frame;
  f->parent = NULL;
  f->has_catch = has_catch;
  f->finally_fn = finally_fn;
  f->finally_ctx = finally_ctx;
  f->root_checkpoint = 0;
}

void sn_eh_push(void *frame) {
  ensure_exception_root();
  SnEhFrame *f = (SnEhFrame *)frame;
  f->root_checkpoint = sn_gc_root_checkpoint();
  f->parent = sn_eh_stack;
  sn_eh_stack = f;
}

void sn_eh_pop(void *frame) {
  SnEhFrame *f = (SnEhFrame *)frame;
  if (sn_eh_stack == f) {
    sn_eh_stack = f->parent;
  }
}

void sn_eh_pop_top(void) {
  if (sn_eh_stack != NULL) {
    sn_eh_stack = sn_eh_stack->parent;
  }
}

jmp_buf *sn_eh_jmp_buf(void *frame) {
  return &((SnEhFrame *)frame)->buf;
}

void *sn_eh_caught_exception(void) {
  return sn_eh_current_exception;
}

void sn_eh_clear_exception(void) {
  sn_eh_current_exception = NULL;
}

void *sn_error_new(const char *message) {
  /* Layout must match builtin Error: ObjectHeader (16) + message ptr. */
  void *err = sn_alloc(16 + (int64_t)sizeof(void *));
  memset(err, 0, 16 + sizeof(void *));
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE;
  ((SnObjectHeader *)err)->vtable = NULL;
  const char *msg = message != NULL ? message : "";
  char *m = sn_str_concat(msg, "");
  *((char **)((char *)err + 16)) = m;
  return err;
}

void sn_uncaught_exception(void *error) {
  char *message = "";
  if (error != NULL) {
    void **fields = (void **)error;
    if (fields[1] != NULL) {
      message = (char *)fields[1];
    }
  }
  fprintf(stderr, "Uncaught Error: %s\n", message);
}

void sn_throw(void *error) {
  ensure_exception_root();
  sn_eh_current_exception = error;
  struct SnEhFrame *f = sn_eh_stack;
  while (f != NULL) {
    if (f->has_catch) {
      sn_gc_root_restore(f->root_checkpoint);
      longjmp(f->buf, 1);
    }
    sn_gc_root_restore(f->root_checkpoint);
    if (f->finally_fn != NULL) {
      f->finally_fn(f->finally_ctx);
    }
    sn_eh_stack = f->parent;
    f = sn_eh_stack;
  }
  sn_uncaught_exception(error);
  abort();
}
