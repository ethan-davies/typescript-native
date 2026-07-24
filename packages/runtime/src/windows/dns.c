#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include "async_internal.h"
#include "winsock.h"

#include <process.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

typedef struct DnsAddrList {
  char **addrs;
  int32_t count;
} DnsAddrList;

typedef struct DnsJob {
  char *host;
  SnFuture *future;
  struct DnsJob *next;
} DnsJob;

typedef struct DnsResult {
  SnFuture *future;
  DnsAddrList *addrs;
  int failed;
  struct DnsResult *next;
} DnsResult;

static CRITICAL_SECTION dns_mu;
static CONDITION_VARIABLE dns_cv;
static DnsJob *dns_queue = NULL;
static int dns_worker_started = 0;
static int dns_sync_ready = 0;

static CRITICAL_SECTION dns_result_mu;
static DnsResult *dns_results = NULL;

static void ensure_dns_sync(void) {
  if (dns_sync_ready) {
    return;
  }
  InitializeCriticalSection(&dns_mu);
  InitializeConditionVariable(&dns_cv);
  InitializeCriticalSection(&dns_result_mu);
  dns_sync_ready = 1;
}

static char *sn_strdup(const char *s) {
  size_t n = strlen(s) + 1;
  char *p = (char *)malloc(n);
  if (p == NULL) {
    abort();
  }
  memcpy(p, s, n);
  return p;
}

static void *make_error(const char *msg) {
  void *err = sn_alloc(16 + (int64_t)sizeof(void *));
  memset(err, 0, 16 + sizeof(void *));
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE;
  ((SnObjectHeader *)err)->vtable = NULL;
  char *m = sn_str_concat(msg, "");
  *((char **)((char *)err + 16)) = m;
  return err;
}

static DnsAddrList *resolve_host_sys(const char *host) {
  sn_winsock_ensure();
  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo *res = NULL;
  if (getaddrinfo(host, NULL, &hints, &res) != 0) {
    return NULL;
  }
  char **tmp = NULL;
  int32_t count = 0;
  int32_t cap = 0;
  for (struct addrinfo *ai = res; ai != NULL; ai = ai->ai_next) {
    char buf[INET6_ADDRSTRLEN];
    const void *addr = NULL;
    if (ai->ai_family == AF_INET) {
      addr = &((struct sockaddr_in *)ai->ai_addr)->sin_addr;
    } else if (ai->ai_family == AF_INET6) {
      addr = &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr;
    } else {
      continue;
    }
    if (inet_ntop(ai->ai_family, addr, buf, sizeof(buf)) == NULL) {
      continue;
    }
    int dup = 0;
    for (int32_t i = 0; i < count; i += 1) {
      if (strcmp(tmp[i], buf) == 0) {
        dup = 1;
        break;
      }
    }
    if (dup) {
      continue;
    }
    if (count == cap) {
      int32_t ncap = cap == 0 ? 4 : cap * 2;
      char **next = (char **)realloc(tmp, (size_t)ncap * sizeof(char *));
      if (next == NULL) {
        abort();
      }
      tmp = next;
      cap = ncap;
    }
    tmp[count] = sn_strdup(buf);
    count += 1;
  }
  freeaddrinfo(res);
  DnsAddrList *list = (DnsAddrList *)malloc(sizeof(DnsAddrList));
  if (list == NULL) {
    abort();
  }
  list->addrs = tmp;
  list->count = count;
  return list;
}

static void free_addr_list(DnsAddrList *list) {
  if (list == NULL) {
    return;
  }
  for (int32_t i = 0; i < list->count; i += 1) {
    free(list->addrs[i]);
  }
  free(list->addrs);
  free(list);
}

static void dns_drain_results(void) {
  for (;;) {
    EnterCriticalSection(&dns_result_mu);
    DnsResult *r = dns_results;
    if (r != NULL) {
      dns_results = r->next;
    }
    LeaveCriticalSection(&dns_result_mu);
    if (r == NULL) {
      break;
    }
    if (r->future != NULL && r->future->state == SN_FUTURE_PENDING) {
      if (r->failed || r->addrs == NULL) {
        sn_future_fail(r->future, make_error("dns resolve failed"));
      } else {
        void *arr = sn_array_new(0, r->addrs->count > 0 ? r->addrs->count : 4, (int64_t)sizeof(void *));
        sn_gc_set_array_meta(arr, SN_REF_PTR, SN_TYPEID_STRING, (int64_t)sizeof(void *));
        for (int32_t i = 0; i < r->addrs->count; i += 1) {
          char *s = sn_str_concat(r->addrs->addrs[i], "");
          sn_array_push(arr, &s, (int64_t)sizeof(void *));
        }
        sn_future_complete(r->future, arr);
      }
    }
    free_addr_list(r->addrs);
    free(r);
  }
}

void sn_dns_poll_results(void) {
  if (!dns_sync_ready) {
    return;
  }
  dns_drain_results();
}

static unsigned __stdcall dns_worker_main(void *arg) {
  (void)arg;
  for (;;) {
    EnterCriticalSection(&dns_mu);
    while (dns_queue == NULL) {
      SleepConditionVariableCS(&dns_cv, &dns_mu, INFINITE);
    }
    DnsJob *job = dns_queue;
    dns_queue = job->next;
    LeaveCriticalSection(&dns_mu);

    DnsAddrList *addrs = resolve_host_sys(job->host);
    DnsResult *r = (DnsResult *)malloc(sizeof(DnsResult));
    if (r == NULL) {
      abort();
    }
    r->future = job->future;
    r->addrs = addrs;
    r->failed = addrs == NULL;
    r->next = NULL;
    EnterCriticalSection(&dns_result_mu);
    r->next = dns_results;
    dns_results = r;
    LeaveCriticalSection(&dns_result_mu);
    free(job->host);
    free(job);
    sn_reactor_wake();
  }
  return 0;
}

static void ensure_dns_worker(void) {
  ensure_dns_sync();
  if (dns_worker_started) {
    return;
  }
  EnterCriticalSection(&dns_mu);
  if (!dns_worker_started) {
    uintptr_t th = _beginthreadex(NULL, 0, dns_worker_main, NULL, 0, NULL);
    if (th == 0) {
      abort();
    }
    CloseHandle((HANDLE)th);
    dns_worker_started = 1;
  }
  LeaveCriticalSection(&dns_mu);
}

void *sn_dns_resolve(const char *host) {
  sn_winsock_ensure();
  sn_async_ensure_init();
  ensure_dns_worker();
  SnFuture *fut = (SnFuture *)sn_future_new();
  if (host == NULL || host[0] == '\0') {
    sn_future_fail(fut, make_error("empty hostname"));
    return fut;
  }
  DnsJob *job = (DnsJob *)malloc(sizeof(DnsJob));
  if (job == NULL) {
    abort();
  }
  job->host = sn_strdup(host);
  job->future = fut;
  job->next = NULL;
  EnterCriticalSection(&dns_mu);
  job->next = dns_queue;
  dns_queue = job;
  WakeConditionVariable(&dns_cv);
  LeaveCriticalSection(&dns_mu);
  return fut;
}
