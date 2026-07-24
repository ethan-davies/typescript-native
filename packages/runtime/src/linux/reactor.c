#define _POSIX_C_SOURCE 200809L

#include "async_internal.h"

#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
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
static intptr_t wake_fd = -1;
static int epfd = -1;

static void wake_cb(void *userdata, int events) {
  (void)userdata;
  (void)events;
  if (wake_fd < 0) {
    return;
  }
  uint64_t n = 0;
  while (read((int)wake_fd, &n, sizeof(n)) > 0) {
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
  epfd = epoll_create1(0);
  if (epfd < 0) {
    abort();
  }
  wake_fd = (intptr_t)eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  if (wake_fd < 0) {
    abort();
  }
  sn_reactor_add_fd(wake_fd, SN_REACTOR_READ, wake_cb, NULL);
}

void sn_reactor_shutdown(void) {
  if (!reactor_ready) {
    return;
  }
  if (wake_fd >= 0) {
    sn_reactor_del_fd(wake_fd);
    close((int)wake_fd);
    wake_fd = -1;
  }
  if (epfd >= 0) {
    close(epfd);
    epfd = -1;
  }
  free(fds);
  fds = NULL;
  fds_len = 0;
  fds_cap = 0;
  reactor_ready = 0;
}

void sn_reactor_wake(void) {
  if (wake_fd < 0) {
    return;
  }
  uint64_t one = 1;
  (void)write((int)wake_fd, &one, sizeof(one));
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

  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = 0;
  if (events & SN_REACTOR_READ) {
    ev.events |= EPOLLIN;
  }
  if (events & SN_REACTOR_WRITE) {
    ev.events |= EPOLLOUT;
  }
  ev.events |= EPOLLERR | EPOLLHUP;
  /* Level-triggered: TLS/OpenSSL WANT_READ/WRITE races badly with edge trigger. */
  ev.data.fd = (int)fd;
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, (int)fd, &ev) != 0) {
    /* ignore; caller may retry */
  }
}

void sn_reactor_mod_fd(intptr_t fd, int events, SnReactorIoCb cb, void *userdata) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    sn_reactor_add_fd(fd, events, cb, userdata);
    return;
  }
  fds[idx].events = events;
  fds[idx].cb = cb;
  fds[idx].userdata = userdata;

  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = 0;
  if (events & SN_REACTOR_READ) {
    ev.events |= EPOLLIN;
  }
  if (events & SN_REACTOR_WRITE) {
    ev.events |= EPOLLOUT;
  }
  ev.events |= EPOLLERR | EPOLLHUP;
  /* Level-triggered: TLS/OpenSSL WANT_READ/WRITE races badly with edge trigger. */
  ev.data.fd = (int)fd;
  epoll_ctl(epfd, EPOLL_CTL_MOD, (int)fd, &ev);
}

void sn_reactor_del_fd(intptr_t fd) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    return;
  }
  fds[idx].active = 0;
  epoll_ctl(epfd, EPOLL_CTL_DEL, (int)fd, NULL);
  fds[idx] = fds[fds_len - 1];
  fds_len -= 1;
}

void sn_reactor_wait(int64_t timeout_ms) {
  if (!reactor_ready) {
    return;
  }

  struct epoll_event events[EVENT_BATCH];
  int to = timeout_ms < 0 ? -1 : (timeout_ms > 2147483647 ? 2147483647 : (int)timeout_ms);
  int n = epoll_wait(epfd, events, EVENT_BATCH, to);
  if (n < 0) {
    return;
  }
  for (int i = 0; i < n; i += 1) {
    intptr_t fd = (intptr_t)events[i].data.fd;
    SnFdEntry *e = entry_for_fd(fd);
    if (e == NULL || e->cb == NULL) {
      continue;
    }
    int ev = 0;
    if (events[i].events & (EPOLLIN | EPOLLHUP | EPOLLRDHUP)) {
      ev |= SN_REACTOR_READ;
    }
    if (events[i].events & EPOLLOUT) {
      ev |= SN_REACTOR_WRITE;
    }
    if (events[i].events & EPOLLERR) {
      ev |= SN_REACTOR_ERROR;
    }
    e->cb(e->userdata, ev);
  }
}
