#include "async_internal.h"

#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

typedef struct SnTimer {
  int64_t deadline_ms;
  SnFuture *future;
  int active;
} SnTimer;

#define TIMER_CAP_INITIAL 16

static SnTimer *timers = NULL;
static int32_t timers_len = 0;
static int32_t timers_cap = 0;
static int timer_ready = 0;
static void *timers_root = NULL;

static void *sys_xrealloc(void *p, size_t n) {
  void *next = realloc(p, n);
  if (next == NULL) {
    abort();
  }
  return next;
}

void sn_timer_init(void) {
  if (timer_ready) {
    return;
  }
  timer_ready = 1;
  timers_len = 0;
  if (timers_root == NULL) {
    timers_root = sn_array_new(0, 8, (int64_t)sizeof(void *));
    sn_gc_set_array_meta(timers_root, SN_REF_PTR, SN_TYPEID_FUTURE, (int64_t)sizeof(void *));
    sn_gc_add_global_root((void **)&timers_root);
  }
}

void sn_timer_shutdown(void) {
  free(timers);
  timers = NULL;
  timers_len = 0;
  timers_cap = 0;
  timers_root = NULL;
  timer_ready = 0;
}

static void refresh_timer_roots(void) {
  if (timers_root == NULL) {
    return;
  }
  SnArray *arr = (SnArray *)timers_root;
  arr->length = 0;
  for (int32_t i = 0; i < timers_len; i += 1) {
    if (timers[i].active && timers[i].future != NULL) {
      void *p = timers[i].future;
      sn_array_push(timers_root, &p, (int64_t)sizeof(void *));
    }
  }
}

int64_t sn_timer_next_deadline_ms(void) {
  if (!timer_ready || timers_len == 0) {
    return -1;
  }
  int64_t now = sn_time_now_ms();
  int64_t best = -1;
  for (int32_t i = 0; i < timers_len; i += 1) {
    if (!timers[i].active) {
      continue;
    }
    int64_t delta = timers[i].deadline_ms - now;
    if (delta < 0) {
      delta = 0;
    }
    if (best < 0 || delta < best) {
      best = delta;
    }
  }
  return best;
}

void sn_timer_fire_due(void) {
  if (!timer_ready) {
    return;
  }
  int64_t now = sn_time_now_ms();
  for (int32_t i = 0; i < timers_len;) {
    if (!timers[i].active) {
      timers[i] = timers[timers_len - 1];
      timers_len -= 1;
      continue;
    }
    if (timers[i].deadline_ms <= now) {
      SnFuture *fut = timers[i].future;
      timers[i].active = 0;
      timers[i] = timers[timers_len - 1];
      timers_len -= 1;
      if (fut != NULL && fut->state == SN_FUTURE_PENDING) {
        sn_future_complete_void(fut);
      }
      continue;
    }
    i += 1;
  }
  refresh_timer_roots();
}

void *sn_timer_sleep_ms(int64_t ms) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  if (ms <= 0) {
    sn_future_complete_void(fut);
    return fut;
  }
  if (timers_len == timers_cap) {
    int32_t new_cap = timers_cap == 0 ? TIMER_CAP_INITIAL : timers_cap * 2;
    timers = (SnTimer *)sys_xrealloc(timers, (size_t)new_cap * sizeof(SnTimer));
    timers_cap = new_cap;
  }
  timers[timers_len].deadline_ms = sn_time_now_ms() + ms;
  timers[timers_len].future = fut;
  timers[timers_len].active = 1;
  timers_len += 1;
  refresh_timer_roots();
  return fut;
}

void sn_timer_cancel(void *fut_ptr) {
  SnFuture *fut = (SnFuture *)fut_ptr;
  if (fut == NULL) {
    return;
  }
  for (int32_t i = 0; i < timers_len; i += 1) {
    if (timers[i].active && timers[i].future == fut) {
      timers[i].active = 0;
      break;
    }
  }
  if (fut->state == SN_FUTURE_PENDING) {
    sn_future_cancel(fut);
  }
  refresh_timer_roots();
}
