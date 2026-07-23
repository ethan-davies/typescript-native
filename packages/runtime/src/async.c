#include "async_internal.h"

#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

#define QUEUE_CAP_INITIAL 16

static int async_ready = 0;
static SnTask **runnable = NULL;
static int32_t runnable_len = 0;
static int32_t runnable_cap = 0;
static SnTask **all_tasks = NULL;
static int32_t all_tasks_len = 0;
static int32_t all_tasks_cap = 0;
static SnTask *current_task = NULL;
static int32_t active_count = 0;

/* Global roots so GC sees scheduler queues. */
static void *root_runnable_arr = NULL;
static void *root_tasks_arr = NULL;

static void *sys_xrealloc(void *p, size_t n) {
  void *next = realloc(p, n);
  if (next == NULL) {
    abort();
  }
  return next;
}

static void ensure_runnable_cap(int32_t need) {
  if (need <= runnable_cap) {
    return;
  }
  int32_t new_cap = runnable_cap == 0 ? QUEUE_CAP_INITIAL : runnable_cap;
  while (new_cap < need) {
    new_cap *= 2;
  }
  runnable = (SnTask **)sys_xrealloc(runnable, (size_t)new_cap * sizeof(SnTask *));
  runnable_cap = new_cap;
}

static void ensure_tasks_cap(int32_t need) {
  if (need <= all_tasks_cap) {
    return;
  }
  int32_t new_cap = all_tasks_cap == 0 ? QUEUE_CAP_INITIAL : all_tasks_cap;
  while (new_cap < need) {
    new_cap *= 2;
  }
  all_tasks = (SnTask **)sys_xrealloc(all_tasks, (size_t)new_cap * sizeof(SnTask *));
  all_tasks_cap = new_cap;
}

static void refresh_global_roots(void) {
  /* Keep first slots of rooted arrays pointing at live task/future graphs via
   * a small GC-managed pointer array we update each mutation. */
  if (root_tasks_arr == NULL) {
    root_tasks_arr = sn_array_new(0, 8, (int64_t)sizeof(void *));
    sn_gc_set_array_meta(root_tasks_arr, SN_REF_PTR, SN_TYPEID_TASK, (int64_t)sizeof(void *));
    sn_gc_add_global_root((void **)&root_tasks_arr);
  }
  SnArray *arr = (SnArray *)root_tasks_arr;
  /* Rebuild contents to match all_tasks. */
  arr->length = 0;
  for (int32_t i = 0; i < all_tasks_len; i += 1) {
    void *p = all_tasks[i];
    sn_array_push(root_tasks_arr, &p, (int64_t)sizeof(void *));
  }
  (void)root_runnable_arr;
}

void sn_async_ensure_init(void) {
  if (async_ready) {
    return;
  }
  sn_async_init();
}

void sn_async_init(void) {
  if (async_ready) {
    return;
  }
  async_ready = 1;
  runnable_len = 0;
  all_tasks_len = 0;
  current_task = NULL;
  active_count = 0;
  sn_reactor_init();
  sn_timer_init();
  refresh_global_roots();
}

void sn_async_shutdown(void) {
  if (!async_ready) {
    return;
  }
  sn_timer_shutdown();
  sn_reactor_shutdown();
  free(runnable);
  runnable = NULL;
  runnable_len = 0;
  runnable_cap = 0;
  free(all_tasks);
  all_tasks = NULL;
  all_tasks_len = 0;
  all_tasks_cap = 0;
  current_task = NULL;
  active_count = 0;
  root_tasks_arr = NULL;
  root_runnable_arr = NULL;
  async_ready = 0;
}

SnTask *sn_scheduler_current(void) {
  return current_task;
}

void *sn_task_current(void) {
  return current_task;
}

bool sn_scheduler_has_runnable(void) {
  return runnable_len > 0;
}

int32_t sn_scheduler_active_count(void) {
  return active_count;
}

void sn_scheduler_enqueue(SnTask *task) {
  if (task == NULL) {
    return;
  }
  if (task->cancelled || task->state == SN_TASK_COMPLETED || task->state == SN_TASK_CANCELLED) {
    return;
  }
  for (int32_t i = 0; i < runnable_len; i += 1) {
    if (runnable[i] == task) {
      return;
    }
  }
  task->state = SN_TASK_RUNNABLE;
  ensure_runnable_cap(runnable_len + 1);
  runnable[runnable_len] = task;
  runnable_len += 1;
}

static void remove_task_from_all(SnTask *task) {
  for (int32_t i = 0; i < all_tasks_len; i += 1) {
    if (all_tasks[i] == task) {
      all_tasks[i] = all_tasks[all_tasks_len - 1];
      all_tasks_len -= 1;
      refresh_global_roots();
      return;
    }
  }
}

void sn_scheduler_run_ready(void) {
  while (runnable_len > 0) {
    SnTask *task = runnable[0];
    runnable[0] = runnable[runnable_len - 1];
    runnable_len -= 1;
    if (task == NULL) {
      continue;
    }
    if (task->cancelled) {
      task->state = SN_TASK_CANCELLED;
      if (task->result != NULL && task->result->state == SN_FUTURE_PENDING) {
        sn_future_cancel(task->result);
      }
      active_count -= 1;
      remove_task_from_all(task);
      continue;
    }
    current_task = task;
    task->state = SN_TASK_RUNNING;
    task->resume(task->frame);
    current_task = NULL;
    if (task->state == SN_TASK_RUNNING) {
      /* Resume returned without suspending → task finished its turn as completed. */
      task->state = SN_TASK_COMPLETED;
      active_count -= 1;
      remove_task_from_all(task);
    } else if (task->state == SN_TASK_CANCELLED) {
      active_count -= 1;
      remove_task_from_all(task);
    }
    /* SUSPENDED: stays in all_tasks, not in runnable. */
  }
}

void *sn_future_new(void) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_alloc((int64_t)sizeof(SnFuture));
  memset(fut, 0, sizeof(SnFuture));
  fut->state = SN_FUTURE_PENDING;
  sn_gc_set_type(fut, SN_TYPEID_FUTURE);
  return fut;
}

void sn_future_add_waiter(SnFuture *fut, SnTask *task) {
  if (fut == NULL || task == NULL) {
    return;
  }
  SnWaiter *w = (SnWaiter *)sn_alloc((int64_t)sizeof(SnWaiter));
  w->task = task;
  w->next = fut->waiters;
  fut->waiters = w;
}

void sn_future_remove_waiter(SnFuture *fut, SnTask *task) {
  if (fut == NULL || task == NULL) {
    return;
  }
  SnWaiter **pp = &fut->waiters;
  while (*pp != NULL) {
    if ((*pp)->task == task) {
      SnWaiter *dead = *pp;
      *pp = dead->next;
      dead->task = NULL;
      dead->next = NULL;
      return;
    }
    pp = &(*pp)->next;
  }
}

void sn_future_wake_waiters(SnFuture *fut) {
  if (fut == NULL) {
    return;
  }
  SnWaiter *w = fut->waiters;
  fut->waiters = NULL;
  while (w != NULL) {
    SnWaiter *next = w->next;
    SnTask *task = (SnTask *)w->task;
    w->task = NULL;
    w->next = NULL;
    if (task != NULL && !task->cancelled && task->state == SN_TASK_SUSPENDED) {
      task->awaiting = NULL;
      sn_scheduler_enqueue(task);
    }
    w = next;
  }
}

static void settle(SnFuture *fut, int32_t state, void *value, void *error) {
  if (fut == NULL || fut->state != SN_FUTURE_PENDING) {
    return;
  }
  fut->state = state;
  fut->value = value;
  fut->error = error;
  if (fut->on_settle != NULL) {
    fut->on_settle(fut);
  }
  sn_future_wake_waiters(fut);
}

void sn_future_complete(void *fut, void *value) {
  settle((SnFuture *)fut, SN_FUTURE_COMPLETED, value, NULL);
}

void sn_future_complete_void(void *fut) {
  settle((SnFuture *)fut, SN_FUTURE_COMPLETED, NULL, NULL);
}

void sn_future_fail(void *fut, void *error) {
  settle((SnFuture *)fut, SN_FUTURE_FAILED, NULL, error);
}

void sn_future_cancel(void *fut) {
  settle((SnFuture *)fut, SN_FUTURE_CANCELLED, NULL, NULL);
}

bool sn_future_is_ready(void *fut) {
  SnFuture *f = (SnFuture *)fut;
  return f != NULL && f->state != SN_FUTURE_PENDING;
}

bool sn_future_is_cancelled(void *fut) {
  SnFuture *f = (SnFuture *)fut;
  return f != NULL && f->state == SN_FUTURE_CANCELLED;
}

int32_t sn_future_state(void *fut) {
  SnFuture *f = (SnFuture *)fut;
  return f == NULL ? SN_FUTURE_PENDING : f->state;
}

void *sn_future_value(void *fut) {
  SnFuture *f = (SnFuture *)fut;
  return f == NULL ? NULL : f->value;
}

void *sn_future_error(void *fut) {
  SnFuture *f = (SnFuture *)fut;
  return f == NULL ? NULL : f->error;
}

void *sn_task_spawn(SnTaskResumeFn resume, void *frame, void *result_fut) {
  sn_async_ensure_init();
  if (resume == NULL) {
    abort();
  }
  SnFuture *fut = (SnFuture *)result_fut;
  if (fut == NULL) {
    fut = (SnFuture *)sn_future_new();
  }
  SnTask *task = (SnTask *)sn_alloc((int64_t)sizeof(SnTask));
  memset(task, 0, sizeof(SnTask));
  task->result = fut;
  task->frame = frame;
  task->resume = resume;
  task->state = SN_TASK_RUNNABLE;
  sn_gc_set_type(task, SN_TYPEID_TASK);

  ensure_tasks_cap(all_tasks_len + 1);
  all_tasks[all_tasks_len] = task;
  all_tasks_len += 1;
  active_count += 1;
  refresh_global_roots();
  sn_scheduler_enqueue(task);
  return fut;
}

void sn_task_await(void *task_ptr, void *fut_ptr) {
  SnTask *task = (SnTask *)task_ptr;
  SnFuture *fut = (SnFuture *)fut_ptr;
  if (task == NULL || fut == NULL) {
    return;
  }
  if (task->cancelled) {
    task->state = SN_TASK_CANCELLED;
    if (task->result != NULL && task->result->state == SN_FUTURE_PENDING) {
      sn_future_cancel(task->result);
    }
    return;
  }
  if (fut->state != SN_FUTURE_PENDING) {
    /* Already ready — caller should not suspend; still allow re-entry. */
    sn_scheduler_enqueue(task);
    return;
  }
  task->awaiting = fut;
  task->state = SN_TASK_SUSPENDED;
  sn_future_add_waiter(fut, task);
}

bool sn_task_await_suspend(void *fut_ptr) {
  SnFuture *fut = (SnFuture *)fut_ptr;
  SnTask *task = current_task;
  if (fut == NULL) {
    return false;
  }
  if (fut->state != SN_FUTURE_PENDING) {
    return false;
  }
  if (task == NULL) {
    sn_future_await_run(fut);
    return false;
  }
  sn_task_await(task, fut);
  return true;
}

void sn_future_await_run(void *fut_ptr) {
  SnFuture *fut = (SnFuture *)fut_ptr;
  if (fut == NULL) {
    return;
  }
  SnTask *saved = current_task;
  while (fut->state == SN_FUTURE_PENDING) {
    /* Allow nested scheduler progress for other tasks. */
    current_task = NULL;
    sn_timer_fire_due();
    if (sn_scheduler_has_runnable()) {
      sn_scheduler_run_ready();
    } else {
      int64_t timeout = sn_timer_next_deadline_ms();
      sn_reactor_wait(timeout);
      sn_timer_fire_due();
      sn_scheduler_run_ready();
    }
    current_task = saved;
  }
  current_task = saved;
}

void sn_task_cancel(void *task_ptr) {
  SnTask *task = (SnTask *)task_ptr;
  if (task == NULL || task->cancelled) {
    return;
  }
  task->cancelled = 1;
  if (task->awaiting != NULL) {
    sn_future_remove_waiter(task->awaiting, task);
    task->awaiting = NULL;
  }
  if (task->result != NULL && task->result->state == SN_FUTURE_PENDING) {
    sn_future_cancel(task->result);
  }
  if (task->state == SN_TASK_SUSPENDED || task->state == SN_TASK_RUNNABLE) {
    task->state = SN_TASK_CANCELLED;
  }
}

bool sn_task_is_cancelled(void *task_ptr) {
  SnTask *task = (SnTask *)task_ptr;
  return task != NULL && task->cancelled != 0;
}

void sn_event_loop_poll(void) {
  sn_async_ensure_init();
  sn_timer_fire_due();
  sn_reactor_wait(0);
  sn_scheduler_run_ready();
}

void sn_event_loop_run(void *root_future) {
  sn_async_ensure_init();
  SnFuture *root = (SnFuture *)root_future;
  for (;;) {
    sn_scheduler_run_ready();
    sn_timer_fire_due();
    if (root != NULL && root->state != SN_FUTURE_PENDING && active_count <= 0 &&
        !sn_scheduler_has_runnable()) {
      break;
    }
    if (root != NULL && root->state != SN_FUTURE_PENDING && !sn_scheduler_has_runnable() &&
        sn_timer_next_deadline_ms() < 0 && active_count <= 0) {
      break;
    }
    if (!sn_scheduler_has_runnable()) {
      int64_t timeout = sn_timer_next_deadline_ms();
      if (timeout < 0 && active_count <= 0 &&
          (root == NULL || root->state != SN_FUTURE_PENDING)) {
        break;
      }
      sn_reactor_wait(timeout);
      sn_timer_fire_due();
    }
  }
}

/* --- future all / race --- */

typedef struct SnAllState {
  SnFuture *result;
  void *futures; /* Future*[] */
  void *results; /* void*[] */
  int32_t total;
  int32_t done;
  int32_t failed;
} SnAllState;

typedef struct SnRaceState {
  SnFuture *result;
  void *futures;
  int32_t total;
  int32_t settled;
} SnRaceState;

static void on_all_child(SnFuture *child) {
  SnAllState *st = (SnAllState *)child->compose_data;
  if (st == NULL || st->failed || st->result->state != SN_FUTURE_PENDING) {
    return;
  }
  if (child->state == SN_FUTURE_FAILED) {
    st->failed = 1;
    sn_future_fail(st->result, child->error);
    return;
  }
  if (child->state == SN_FUTURE_CANCELLED) {
    st->failed = 1;
    sn_future_cancel(st->result);
    return;
  }
  /* Find index */
  SnArray *arr = (SnArray *)st->futures;
  void **slots = (void **)arr->data;
  for (int32_t i = 0; i < st->total; i += 1) {
    if (slots[i] == child) {
      void **outs = (void **)((SnArray *)st->results)->data;
      outs[i] = child->value;
      break;
    }
  }
  st->done += 1;
  if (st->done >= st->total) {
    sn_future_complete(st->result, st->results);
  }
}

static void race_child_settle(SnFuture *child) {
  SnRaceState *st = (SnRaceState *)child->compose_data;
  if (st == NULL || st->settled || st->result->state != SN_FUTURE_PENDING) {
    return;
  }
  st->settled = 1;
  if (child->state == SN_FUTURE_COMPLETED) {
    sn_future_complete(st->result, child->value);
  } else if (child->state == SN_FUTURE_FAILED) {
    sn_future_fail(st->result, child->error);
  } else {
    sn_future_cancel(st->result);
  }
}

void *sn_future_all(void *futures_array) {
  sn_async_ensure_init();
  SnFuture *result = (SnFuture *)sn_future_new();
  if (futures_array == NULL) {
    void *empty = sn_array_new(0, 0, (int64_t)sizeof(void *));
    sn_gc_set_array_meta(empty, SN_REF_PTR, 0, (int64_t)sizeof(void *));
    sn_future_complete(result, empty);
    return result;
  }
  SnArray *arr = (SnArray *)futures_array;
  int32_t n = (int32_t)arr->length;
  if (n == 0) {
    void *empty = sn_array_new(0, 0, (int64_t)sizeof(void *));
    sn_gc_set_array_meta(empty, SN_REF_PTR, 0, (int64_t)sizeof(void *));
    sn_future_complete(result, empty);
    return result;
  }

  SnAllState *st = (SnAllState *)sn_alloc((int64_t)sizeof(SnAllState));
  memset(st, 0, sizeof(SnAllState));
  st->result = result;
  st->futures = futures_array;
  st->total = n;
  st->results = sn_array_new(n, n, (int64_t)sizeof(void *));
  sn_gc_set_array_meta(st->results, SN_REF_PTR, 0, (int64_t)sizeof(void *));
  memset(((SnArray *)st->results)->data, 0, (size_t)n * sizeof(void *));

  result->compose_data = st;

  void **slots = (void **)arr->data;
  int32_t already = 0;
  for (int32_t i = 0; i < n; i += 1) {
    SnFuture *child = (SnFuture *)slots[i];
    if (child == NULL) {
      already += 1;
      continue;
    }
    if (child->state != SN_FUTURE_PENDING) {
      if (child->state == SN_FUTURE_FAILED) {
        sn_future_fail(result, child->error);
        return result;
      }
      if (child->state == SN_FUTURE_CANCELLED) {
        sn_future_cancel(result);
        return result;
      }
      void **outs = (void **)((SnArray *)st->results)->data;
      outs[i] = child->value;
      already += 1;
    } else {
      child->compose_data = st;
      child->on_settle = on_all_child;
    }
  }
  st->done = already;
  if (st->done >= st->total && result->state == SN_FUTURE_PENDING) {
    sn_future_complete(result, st->results);
  }
  return result;
}

void *sn_future_race(void *futures_array) {
  sn_async_ensure_init();
  SnFuture *result = (SnFuture *)sn_future_new();
  if (futures_array == NULL) {
    sn_future_cancel(result);
    return result;
  }
  SnArray *arr = (SnArray *)futures_array;
  int32_t n = (int32_t)arr->length;
  if (n == 0) {
    sn_future_cancel(result);
    return result;
  }

  SnRaceState *st = (SnRaceState *)sn_alloc((int64_t)sizeof(SnRaceState));
  memset(st, 0, sizeof(SnRaceState));
  st->result = result;
  st->futures = futures_array;
  st->total = n;
  result->compose_data = st;

  void **slots = (void **)arr->data;
  for (int32_t i = 0; i < n; i += 1) {
    SnFuture *child = (SnFuture *)slots[i];
    if (child == NULL) {
      continue;
    }
    if (child->state != SN_FUTURE_PENDING) {
      st->settled = 1;
      if (child->state == SN_FUTURE_COMPLETED) {
        sn_future_complete(result, child->value);
      } else if (child->state == SN_FUTURE_FAILED) {
        sn_future_fail(result, child->error);
      } else {
        sn_future_cancel(result);
      }
      return result;
    }
    child->compose_data = st;
    child->on_settle = race_child_settle;
  }
  return result;
}
