#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "sn/runtime.h"

static int g_step = 0;
static void *g_fut_a = NULL;
static void *g_fut_b = NULL;

typedef struct FrameA {
  int32_t state;
  void *sleep_fut;
} FrameA;

typedef struct FrameB {
  int32_t state;
} FrameB;

static void resume_a(void *frame_ptr) {
  FrameA *frame = (FrameA *)frame_ptr;
  void *task = sn_task_current();
  if (frame->state == 0) {
    g_step = 1;
    frame->sleep_fut = sn_timer_sleep_ms(30);
    frame->state = 1;
    sn_task_await(task, frame->sleep_fut);
    return;
  }
  if (frame->state == 1) {
    assert(sn_future_is_ready(frame->sleep_fut));
    g_step = 3;
    sn_future_complete_void(g_fut_a);
    frame->state = 2;
  }
}

static void resume_b(void *frame_ptr) {
  FrameB *frame = (FrameB *)frame_ptr;
  (void)frame;
  assert(g_step == 1 || g_step == 3);
  if (g_step == 1) {
    g_step = 2;
  }
  sn_future_complete_void(g_fut_b);
}

static void test_future_states(void) {
  sn_async_init();
  void *f = sn_future_new();
  assert(sn_future_state(f) == SN_FUTURE_PENDING);
  assert(!sn_future_is_ready(f));
  sn_future_complete(f, (void *)(intptr_t)42);
  assert(sn_future_is_ready(f));
  assert(sn_future_state(f) == SN_FUTURE_COMPLETED);
  assert(sn_future_value(f) == (void *)(intptr_t)42);
  /* No re-complete */
  sn_future_complete(f, (void *)(intptr_t)99);
  assert(sn_future_value(f) == (void *)(intptr_t)42);

  void *f2 = sn_future_new();
  sn_future_fail(f2, (void *)(intptr_t)7);
  assert(sn_future_state(f2) == SN_FUTURE_FAILED);
  assert(sn_future_error(f2) == (void *)(intptr_t)7);

  void *f3 = sn_future_new();
  sn_future_cancel(f3);
  assert(sn_future_is_cancelled(f3));
  sn_async_shutdown();
}

static void test_interleaved_sleep(void) {
  sn_async_init();
  g_step = 0;
  g_fut_a = sn_future_new();
  g_fut_b = sn_future_new();

  FrameA *fa = (FrameA *)sn_alloc((int64_t)sizeof(FrameA));
  fa->state = 0;
  fa->sleep_fut = NULL;
  FrameB *fb = (FrameB *)sn_alloc((int64_t)sizeof(FrameB));
  fb->state = 0;

  sn_task_spawn(resume_a, fa, g_fut_a);
  sn_task_spawn(resume_b, fb, g_fut_b);

  sn_event_loop_run(g_fut_a);
  assert(sn_future_is_ready(g_fut_a));
  assert(sn_future_is_ready(g_fut_b));
  assert(g_step == 3);
  sn_async_shutdown();
}

static void resume_immediate(void *frame) {
  (void)frame;
  void *task = sn_task_current();
  /* Complete result future stored as frame pointer for this test. */
  sn_future_complete((void *)frame, (void *)(intptr_t)123);
  (void)task;
}

static void test_await_completed(void) {
  sn_async_init();
  void *fut = sn_future_new();
  sn_future_complete(fut, (void *)(intptr_t)5);
  assert(sn_future_value(fut) == (void *)(intptr_t)5);

  void *done = sn_future_new();
  sn_task_spawn(resume_immediate, done, done);
  sn_event_loop_run(done);
  assert(sn_future_value(done) == (void *)(intptr_t)123);
  sn_async_shutdown();
}

static void test_all_race(void) {
  sn_async_init();
  void *a = sn_future_new();
  void *b = sn_future_new();
  void *arr = sn_array_new(0, 2, (int64_t)sizeof(void *));
  sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_FUTURE, (int64_t)sizeof(void *));
  sn_array_push(arr, &a, (int64_t)sizeof(void *));
  sn_array_push(arr, &b, (int64_t)sizeof(void *));

  void *all = sn_future_all(arr);
  assert(!sn_future_is_ready(all));
  sn_future_complete(a, (void *)(intptr_t)1);
  assert(!sn_future_is_ready(all));
  sn_future_complete(b, (void *)(intptr_t)2);
  assert(sn_future_is_ready(all));
  void *results = sn_future_value(all);
  assert(sn_array_length(results) == 2);

  void *c = sn_future_new();
  void *d = sn_timer_sleep_ms(50);
  void *arr2 = sn_array_new(0, 2, (int64_t)sizeof(void *));
  sn_gc_set_array_meta(arr2, SN_REF_PTR, SN_TYPEID_FUTURE, (int64_t)sizeof(void *));
  sn_array_push(arr2, &c, (int64_t)sizeof(void *));
  sn_array_push(arr2, &d, (int64_t)sizeof(void *));
  void *race = sn_future_race(arr2);
  sn_future_complete(c, (void *)(intptr_t)9);
  assert(sn_future_is_ready(race));
  assert(sn_future_value(race) == (void *)(intptr_t)9);
  sn_async_shutdown();
}

static void test_timer_only(void) {
  sn_async_init();
  void *f = sn_timer_sleep_ms(20);
  sn_event_loop_run(f);
  assert(sn_future_is_ready(f));
  assert(sn_future_state(f) == SN_FUTURE_COMPLETED);
  sn_async_shutdown();
}

int main(void) {
  test_future_states();
  test_await_completed();
  test_timer_only();
  test_interleaved_sleep();
  test_all_race();
  printf("async_smoke: ok\n");
  return 0;
}
