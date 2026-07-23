#define _POSIX_C_SOURCE 200809L

#include "async_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/epoll.h>
#include <sys/eventfd.h>
#define SN_USE_EPOLL 1
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
#include <sys/event.h>
#include <sys/time.h>
#include <sys/types.h>
#define SN_USE_KQUEUE 1
#else
#include <poll.h>
#define SN_USE_POLL 1
#endif

typedef struct SnFdEntry {
  int fd;
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
static int wake_rfd = -1;
static int wake_wfd = -1;

#if defined(SN_USE_EPOLL)
static int epfd = -1;
#elif defined(SN_USE_KQUEUE)
static int kqfd = -1;
#endif

static void wake_cb(void *userdata, int events) {
  (void)userdata;
  (void)events;
  if (wake_rfd < 0) {
    return;
  }
#if defined(__linux__)
  uint64_t n = 0;
  while (read(wake_rfd, &n, sizeof(n)) > 0) {
  }
#else
  char buf[64];
  while (read(wake_rfd, buf, sizeof(buf)) > 0) {
  }
#endif
}

static void *sys_xrealloc(void *p, size_t n) {
  void *next = realloc(p, n);
  if (next == NULL) {
    abort();
  }
  return next;
}

static int32_t find_fd(int fd) {
  for (int32_t i = 0; i < fds_len; i += 1) {
    if (fds[i].active && fds[i].fd == fd) {
      return i;
    }
  }
  return -1;
}

void sn_reactor_init(void) {
  if (reactor_ready) {
    return;
  }
  reactor_ready = 1;
  fds_len = 0;
#if defined(SN_USE_EPOLL)
  epfd = epoll_create1(0);
  if (epfd < 0) {
    abort();
  }
#elif defined(SN_USE_KQUEUE)
  kqfd = kqueue();
  if (kqfd < 0) {
    abort();
  }
#endif
#if defined(__linux__)
  wake_rfd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  wake_wfd = wake_rfd;
  if (wake_rfd < 0) {
    abort();
  }
#else
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
    wake_rfd = pipefd[0];
    wake_wfd = pipefd[1];
  }
#endif
  sn_reactor_add_fd(wake_rfd, SN_REACTOR_READ, wake_cb, NULL);
}

void sn_reactor_shutdown(void) {
  if (!reactor_ready) {
    return;
  }
  if (wake_rfd >= 0) {
    sn_reactor_del_fd(wake_rfd);
    close(wake_rfd);
    if (wake_wfd >= 0 && wake_wfd != wake_rfd) {
      close(wake_wfd);
    }
    wake_rfd = -1;
    wake_wfd = -1;
  }
#if defined(SN_USE_EPOLL)
  if (epfd >= 0) {
    close(epfd);
    epfd = -1;
  }
#elif defined(SN_USE_KQUEUE)
  if (kqfd >= 0) {
    close(kqfd);
    kqfd = -1;
  }
#endif
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
#if defined(__linux__)
  uint64_t one = 1;
  (void)write(wake_wfd, &one, sizeof(one));
#else
  char b = 1;
  (void)write(wake_wfd, &b, 1);
#endif
}

static void ensure_fd_cap(void) {
  if (fds_len < fds_cap) {
    return;
  }
  int32_t new_cap = fds_cap == 0 ? FD_CAP_INITIAL : fds_cap * 2;
  fds = (SnFdEntry *)sys_xrealloc(fds, (size_t)new_cap * sizeof(SnFdEntry));
  fds_cap = new_cap;
}

void sn_reactor_add_fd(int fd, int events, SnReactorIoCb cb, void *userdata) {
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

#if defined(SN_USE_EPOLL)
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
  ev.data.fd = fd;
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev) != 0) {
    /* fall through; poll path not used */
  }
#elif defined(SN_USE_KQUEUE)
  struct kevent kev[2];
  int n = 0;
  if (events & SN_REACTOR_READ) {
    EV_SET(&kev[n++], fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, userdata);
  }
  if (events & SN_REACTOR_WRITE) {
    EV_SET(&kev[n++], fd, EVFILT_WRITE, EV_ADD | EV_CLEAR, 0, 0, userdata);
  }
  if (n > 0) {
    kevent(kqfd, kev, n, NULL, 0, NULL);
  }
#else
  (void)events;
  (void)userdata;
#endif
}

void sn_reactor_mod_fd(int fd, int events, SnReactorIoCb cb, void *userdata) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    sn_reactor_add_fd(fd, events, cb, userdata);
    return;
  }
  fds[idx].events = events;
  fds[idx].cb = cb;
  fds[idx].userdata = userdata;
#if defined(SN_USE_EPOLL)
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
  ev.data.fd = fd;
  epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev);
#elif defined(SN_USE_KQUEUE)
  sn_reactor_del_fd(fd);
  fds[idx].active = 1;
  sn_reactor_add_fd(fd, events, cb, userdata);
#endif
}

void sn_reactor_del_fd(int fd) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    return;
  }
  fds[idx].active = 0;
#if defined(SN_USE_EPOLL)
  epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);
#elif defined(SN_USE_KQUEUE)
  struct kevent kev[2];
  EV_SET(&kev[0], fd, EVFILT_READ, EV_DELETE, 0, 0, NULL);
  EV_SET(&kev[1], fd, EVFILT_WRITE, EV_DELETE, 0, 0, NULL);
  kevent(kqfd, kev, 2, NULL, 0, NULL);
#endif
  /* Compact */
  fds[idx] = fds[fds_len - 1];
  fds_len -= 1;
}

static SnFdEntry *entry_for_fd(int fd) {
  int32_t idx = find_fd(fd);
  return idx < 0 ? NULL : &fds[idx];
}

void sn_reactor_wait(int64_t timeout_ms) {
  if (!reactor_ready) {
    return;
  }

#if defined(SN_USE_EPOLL)
  struct epoll_event events[EVENT_BATCH];
  int to = timeout_ms < 0 ? -1 : (timeout_ms > 2147483647 ? 2147483647 : (int)timeout_ms);
  int n = epoll_wait(epfd, events, EVENT_BATCH, to);
  if (n < 0) {
    if (errno == EINTR) {
      return;
    }
    return;
  }
  for (int i = 0; i < n; i += 1) {
    int fd = events[i].data.fd;
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
#elif defined(SN_USE_KQUEUE)
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
    int fd = (int)events[i].ident;
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
#else
  /* poll fallback */
  if (fds_len == 0) {
    if (timeout_ms > 0) {
      struct timespec ts;
      ts.tv_sec = (time_t)(timeout_ms / 1000);
      ts.tv_nsec = (long)((timeout_ms % 1000) * 1000000);
      nanosleep(&ts, NULL);
    }
    return;
  }
  struct pollfd *pfds = (struct pollfd *)calloc((size_t)fds_len, sizeof(struct pollfd));
  if (pfds == NULL) {
    abort();
  }
  int32_t nfd = 0;
  for (int32_t i = 0; i < fds_len; i += 1) {
    if (!fds[i].active) {
      continue;
    }
    pfds[nfd].fd = fds[i].fd;
    pfds[nfd].events = 0;
    if (fds[i].events & SN_REACTOR_READ) {
      pfds[nfd].events |= POLLIN;
    }
    if (fds[i].events & SN_REACTOR_WRITE) {
      pfds[nfd].events |= POLLOUT;
    }
    nfd += 1;
  }
  int to = timeout_ms < 0 ? -1 : (int)timeout_ms;
  int n = poll(pfds, (nfds_t)nfd, to);
  if (n > 0) {
    for (int32_t i = 0; i < nfd; i += 1) {
      if (pfds[i].revents == 0) {
        continue;
      }
      SnFdEntry *e = entry_for_fd(pfds[i].fd);
      if (e == NULL || e->cb == NULL) {
        continue;
      }
      int ev = 0;
      if (pfds[i].revents & (POLLIN | POLLHUP)) {
        ev |= SN_REACTOR_READ;
      }
      if (pfds[i].revents & POLLOUT) {
        ev |= SN_REACTOR_WRITE;
      }
      if (pfds[i].revents & POLLERR) {
        ev |= SN_REACTOR_ERROR;
      }
      e->cb(e->userdata, ev);
    }
  }
  free(pfds);
#endif
}
