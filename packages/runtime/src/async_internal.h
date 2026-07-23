#ifndef SN_ASYNC_INTERNAL_H
#define SN_ASYNC_INTERNAL_H

#include <stdbool.h>
#include <stdint.h>

#include "sn/runtime.h"

typedef struct SnWaiter {
  void *task;
  struct SnWaiter *next;
} SnWaiter;

typedef struct SnFuture {
  int32_t state;
  void *value;
  void *error;
  SnWaiter *waiters;
  /* Composition helpers */
  void *compose_data;
  void (*on_settle)(struct SnFuture *self);
} SnFuture;

#define SN_TASK_RUNNABLE 0
#define SN_TASK_RUNNING 1
#define SN_TASK_SUSPENDED 2
#define SN_TASK_COMPLETED 3
#define SN_TASK_CANCELLED 4

typedef struct SnTask {
  SnFuture *result;
  void *frame;
  SnTaskResumeFn resume;
  SnFuture *awaiting;
  int32_t state;
  int32_t cancelled;
} SnTask;

void sn_async_ensure_init(void);
void sn_scheduler_enqueue(SnTask *task);
void sn_scheduler_run_ready(void);
bool sn_scheduler_has_runnable(void);
int32_t sn_scheduler_active_count(void);
SnTask *sn_scheduler_current(void);

void sn_future_add_waiter(SnFuture *fut, SnTask *task);
void sn_future_remove_waiter(SnFuture *fut, SnTask *task);
void sn_future_wake_waiters(SnFuture *fut);

/* Reactor / timers (implemented in reactor.c / timer.c) */
void sn_reactor_init(void);
void sn_reactor_shutdown(void);
/* Wait up to timeout_ms (-1 = forever, 0 = poll). Wakes ready futures. */
void sn_reactor_wait(int64_t timeout_ms);
void sn_reactor_wake(void);

typedef void (*SnReactorIoCb)(void *userdata, int events);

#define SN_REACTOR_READ 1
#define SN_REACTOR_WRITE 2
#define SN_REACTOR_ERROR 4

void sn_reactor_add_fd(int fd, int events, SnReactorIoCb cb, void *userdata);
void sn_reactor_mod_fd(int fd, int events, SnReactorIoCb cb, void *userdata);
void sn_reactor_del_fd(int fd);

void sn_timer_init(void);
void sn_timer_shutdown(void);
/* Next timer due in ms, or -1 if none. */
int64_t sn_timer_next_deadline_ms(void);
void sn_timer_fire_due(void);

#endif /* SN_ASYNC_INTERNAL_H */
