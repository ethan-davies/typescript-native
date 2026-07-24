#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <windows.h>

#include "async_internal.h"
#include "winsock.h"

#include <stdlib.h>
#include <string.h>

typedef struct SnFdEntry {
  intptr_t fd;
  int events;
  SnReactorIoCb cb;
  void *userdata;
  int active;
} SnFdEntry;

#define FD_CAP_INITIAL 16
#define WAKE_KEY ((ULONG_PTR)1)
#define POLL_SLICE_MS 50

static int reactor_ready = 0;
static SnFdEntry *fds = NULL;
static int32_t fds_len = 0;
static int32_t fds_cap = 0;
static HANDLE iocp = NULL;
static HANDLE wake_event = NULL;
static WSAPOLLFD *pollfds = NULL;
static int32_t pollfds_cap = 0;

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

static void ensure_pollfds_cap(int32_t need) {
  if (need <= pollfds_cap) {
    return;
  }
  int32_t new_cap = pollfds_cap == 0 ? FD_CAP_INITIAL : pollfds_cap;
  while (new_cap < need) {
    new_cap *= 2;
  }
  pollfds = (WSAPOLLFD *)sys_xrealloc(pollfds, (size_t)new_cap * sizeof(WSAPOLLFD));
  pollfds_cap = new_cap;
}

static SnFdEntry *entry_for_fd(intptr_t fd) {
  int32_t idx = find_fd(fd);
  return idx < 0 ? NULL : &fds[idx];
}

static int drain_iocp_wakes(DWORD timeout_ms) {
  int woke = 0;
  for (;;) {
    DWORD bytes = 0;
    ULONG_PTR key = 0;
    OVERLAPPED *ov = NULL;
    BOOL ok = GetQueuedCompletionStatus(iocp, &bytes, &key, &ov, woke ? 0 : timeout_ms);
    if (!ok) {
      DWORD err = GetLastError();
      if (err == WAIT_TIMEOUT) {
        break;
      }
      if (ov == NULL) {
        break;
      }
      continue;
    }
    if (key == WAKE_KEY) {
      woke = 1;
      timeout_ms = 0;
      continue;
    }
    /* Unexpected completion; treat as wake so the loop re-checks sockets. */
    woke = 1;
    timeout_ms = 0;
  }
  return woke;
}

void sn_reactor_init(void) {
  if (reactor_ready) {
    return;
  }
  sn_winsock_ensure();
  reactor_ready = 1;
  fds_len = 0;
  iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (iocp == NULL) {
    abort();
  }
  wake_event = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (wake_event == NULL) {
    abort();
  }
}

void sn_reactor_shutdown(void) {
  if (!reactor_ready) {
    return;
  }
  if (wake_event != NULL) {
    CloseHandle(wake_event);
    wake_event = NULL;
  }
  if (iocp != NULL) {
    CloseHandle(iocp);
    iocp = NULL;
  }
  free(fds);
  fds = NULL;
  free(pollfds);
  pollfds = NULL;
  fds_len = 0;
  fds_cap = 0;
  pollfds_cap = 0;
  reactor_ready = 0;
}

void sn_reactor_wake(void) {
  if (!reactor_ready) {
    return;
  }
  if (wake_event != NULL) {
    SetEvent(wake_event);
  }
  if (iocp != NULL) {
    PostQueuedCompletionStatus(iocp, 0, WAKE_KEY, NULL);
  }
}

void sn_reactor_add_fd(intptr_t fd, int events, SnReactorIoCb cb, void *userdata) {
  if (fd < 0 || cb == NULL || !reactor_ready) {
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

  /* Associate with IOCP (readiness still comes from WSAPoll). */
  CreateIoCompletionPort((HANDLE)(SOCKET)fd, iocp, (ULONG_PTR)fd, 0);
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
}

void sn_reactor_del_fd(intptr_t fd) {
  int32_t idx = find_fd(fd);
  if (idx < 0) {
    return;
  }
  fds[idx].active = 0;
  fds[idx] = fds[fds_len - 1];
  fds_len -= 1;
}

static int poll_ready_once(void) {
  int32_t nactive = 0;
  for (int32_t i = 0; i < fds_len; i += 1) {
    if (fds[i].active) {
      nactive += 1;
    }
  }
  if (nactive == 0) {
    return 0;
  }
  ensure_pollfds_cap(nactive);
  int32_t npoll = 0;
  for (int32_t i = 0; i < fds_len; i += 1) {
    if (!fds[i].active) {
      continue;
    }
    pollfds[npoll].fd = (SOCKET)fds[i].fd;
    pollfds[npoll].events = 0;
    pollfds[npoll].revents = 0;
    if (fds[i].events & SN_REACTOR_READ) {
      pollfds[npoll].events = (SHORT)(pollfds[npoll].events | POLLRDNORM | POLLRDBAND);
    }
    if (fds[i].events & SN_REACTOR_WRITE) {
      pollfds[npoll].events = (SHORT)(pollfds[npoll].events | POLLWRNORM);
    }
    npoll += 1;
  }
  int n = WSAPoll(pollfds, (ULONG)npoll, 0);
  if (n <= 0) {
    return 0;
  }
  int fired = 0;
  for (int32_t i = 0; i < npoll; i += 1) {
    if (pollfds[i].revents == 0) {
      continue;
    }
    SnFdEntry *e = entry_for_fd((intptr_t)pollfds[i].fd);
    if (e == NULL || e->cb == NULL) {
      continue;
    }
    int ev = 0;
    if (pollfds[i].revents & (POLLRDNORM | POLLRDBAND | POLLHUP)) {
      ev |= SN_REACTOR_READ;
    }
    if (pollfds[i].revents & POLLWRNORM) {
      ev |= SN_REACTOR_WRITE;
    }
    if (pollfds[i].revents & (POLLERR | POLLNVAL)) {
      ev |= SN_REACTOR_ERROR;
    }
    if (ev != 0) {
      e->cb(e->userdata, ev);
      fired = 1;
    }
  }
  return fired;
}

void sn_reactor_wait(int64_t timeout_ms) {
  if (!reactor_ready) {
    return;
  }

  DWORD start = GetTickCount();
  for (;;) {
    if (drain_iocp_wakes(0)) {
      (void)poll_ready_once();
      return;
    }
    if (poll_ready_once()) {
      return;
    }

    if (timeout_ms == 0) {
      return;
    }

    DWORD elapsed = GetTickCount() - start;
    DWORD remaining;
    if (timeout_ms < 0) {
      remaining = POLL_SLICE_MS;
    } else if (elapsed >= (DWORD)timeout_ms) {
      return;
    } else {
      remaining = (DWORD)timeout_ms - elapsed;
      if (remaining > POLL_SLICE_MS) {
        remaining = POLL_SLICE_MS;
      }
    }

    /* Block on wake event (IOCP is drained via GetQueuedCompletionStatus). */
    DWORD wr = WaitForSingleObject(wake_event, remaining);
    (void)drain_iocp_wakes(0);
    if (wr == WAIT_OBJECT_0) {
      (void)poll_ready_once();
      return;
    }
    if (timeout_ms >= 0) {
      elapsed = GetTickCount() - start;
      if (elapsed >= (DWORD)timeout_ms) {
        (void)poll_ready_once();
        return;
      }
    }
  }
}
