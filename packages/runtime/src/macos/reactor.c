#define _POSIX_C_SOURCE 200809L

#include "async_internal.h"

#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

typedef struct SnFdEntry {
  intptr_t fd;
  int events;
  SnReactorIoCb cb;
  void *userdata;
  int active;
} SnFdEntry;

#define FD_CAP_INITIAL 16
#define EVENT_BATCH 64

static int reactor_ready = 0;
static SnFdEntry *fds = NULL;
static int32_t fds_len = 0;
static int32_t fds_cap = 0;
static intptr_t wake_rfd = -1;
static intptr_t wake_wfd = -1;
static int kqfd = -1;

static void wake_cb(void *userdata, int events) {
  (void)userdata;
  (void)events;
  if (wake_rfd < 0) {
    return;
  }
  char buf[64];
  while (read((int)wake_rfd, buf, sizeof(buf)) > 0) {
  }
}

static void *sys_xrealloc(void *p, size_t n) {
  void *next = realloc(p, n);
  if (next == NULL) {
    abort();
  }
  return next;
}

static int32_t find_fd(intptr_t fd) {
  for (int32_t i = 0; i < fds_len; i += 1) {
    if (fds[i].active && fds[i].fd == fd) {
      return i;
    }
  }
  return -1;
}

static void ensure_fd_cap(void) {
  if (fds_len < fds_cap) {
    return;
  }
  int32_t new_cap = fds_cap == 0 ? FD_CAP_INITIAL : fds_cap * 2;
  fds = (SnFdEntry *)sys_xrealloc(fds, (size_t)new_cap * sizeof(SnFdEntry));
  fds_cap = new_cap;
}

static SnFdEntry *entry_for_fd(intptr_t fd) {
  int32_t idx = find_fd(fd);
  return idx < 0 ? NULL : &fds[idx];
}

void sn_reactor_init(void) {
  if (reactor_ready) {
    return;
  }
  reactor_ready = 1;
  fds_len = 0;
  kqfd = kqueue();
  if (kqfd < 0) {
    abort();
  }
  {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
      abort();
    }
    int fl0 = fcntl(pipefd[0], F_GETFL, 0);
    int fl1 = fcntl(pipefd[1], F_GETFL, 0);
    if (fl0 >= 0) {
      fcntl(pipefd[0], F_SETFL, fl0 | O_NONBLOCK);
    }
    if (fl1 >= 0) {
      fcntl(pipefd[1], F_SETFL, fl1 | O_NONBLOCK);
    }
    wake_rfd = (intptr_t)pipefd[0];
    wake_wfd = (intptr_t)pipefd[1];
  }
  sn_reactor_add_fd(wake_rfd, SN_REACTOR_READ, wake_cb, NULL);
}

void sn_reactor_shutdown(void) {
  if (!reactor_ready) {
    return;
  }
  if (wake_rfd >= 0) {
    sn_reactor_del_fd(wake_rfd);
    close((int)wake_rfd);
    if (wake_wfd >= 0 && wake_wfd != wake_rfd) {
      close((int)wake_wfd);
    }
    wake_rfd = -1;
    wake_wfd = -1;
  }
  if (kqfd >= 0) {
    close(kqfd);
    kqfd = -1;
  }
  free(fds);
  fds = NULL;
  fds_len = 0;
  fds_cap = 0;
  reactor_ready = 0;
}

void sn_reactor_wake(void) {
  if (wake_wfd < 0) {
    return;
  }
  char b = 1;
  (void)write((int)wake_wfd, &b, 1);
}

void sn_reactor_add_fd(intptr_t fd, int events, SnReactorIoCb cb, void *userdata) {
  if (fd < 0 || cb == NULL) {
    return;
  }
  int32_t idx = find_fd(fd);
  if (idx >= 0) {
    sn_reactor_mod_fd(fd, events, cb, userdata);
    return;
  }
  ensure_fd_cap();
  idx = fds_len;
  fds_len += 1;
  fds[idx].fd = fd;
  fds[idx].events = events;
  fds[idx].cb = cb;
  fds[idx].userdata = userdata;
  fds[idx].active = 1;

  /* Level-triggered (EV_ADD only, no EV_CLEAR): TLS/OpenSSL WANT_READ/WRITE
   * races badly with edge trigger. */
  struct kevent kev[2];
  int n = 0;
  if (events & SN_REACTOR_READ) {
    EV_SET(&kev[n++], (uintptr_t)fd, EVFILT_READ, EV_ADD, 0, 0, userdata);
  }
  if (events & SN_REACTOR_WRITE) {
    EV_SET(&kev[n++], (uintptr_t)fd, EVFILT_WRITE, EV_ADD, 0, 0, userdata);
  }
  if (n > 0) {
    kevent(kqfd, kev, n, NULL, 0, NULL);
  }
}

void sn_reactor_mod_fd(intptr_t fd, int events, SnReactorIoCb cb, void *userdata) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    sn_reactor_add_fd(fd, events, cb, userdata);
    return;
  }
  sn_reactor_del_fd(fd);
  sn_reactor_add_fd(fd, events, cb, userdata);
}

void sn_reactor_del_fd(intptr_t fd) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    return;
  }
  fds[idx].active = 0;
  struct kevent kev[2];
  EV_SET(&kev[0], (uintptr_t)fd, EVFILT_READ, EV_DELETE, 0, 0, NULL);
  EV_SET(&kev[1], (uintptr_t)fd, EVFILT_WRITE, EV_DELETE, 0, 0, NULL);
  kevent(kqfd, kev, 2, NULL, 0, NULL);
  fds[idx] = fds[fds_len - 1];
  fds_len -= 1;
}

void sn_reactor_wait(int64_t timeout_ms) {
  if (!reactor_ready) {
    return;
  }

  struct kevent events[EVENT_BATCH];
  struct timespec ts;
  struct timespec *tsp = NULL;
  if (timeout_ms >= 0) {
    ts.tv_sec = (time_t)(timeout_ms / 1000);
    ts.tv_nsec = (long)((timeout_ms % 1000) * 1000000);
    tsp = &ts;
  }
  int n = kevent(kqfd, NULL, 0, events, EVENT_BATCH, tsp);
  if (n < 0) {
    return;
  }
  for (int i = 0; i < n; i += 1) {
    intptr_t fd = (intptr_t)events[i].ident;
    SnFdEntry *e = entry_for_fd(fd);
    if (e == NULL || e->cb == NULL) {
      continue;
    }
    int ev = 0;
    if (events[i].filter == EVFILT_READ) {
      ev |= SN_REACTOR_READ;
    }
    if (events[i].filter == EVFILT_WRITE) {
      ev |= SN_REACTOR_WRITE;
    }
    if (events[i].flags & EV_ERROR) {
      ev |= SN_REACTOR_ERROR;
    }
    e->cb(e->userdata, ev);
  }
}
