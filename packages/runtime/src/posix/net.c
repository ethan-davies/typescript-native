#define _POSIX_C_SOURCE 200809L

#include "async_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include "sn/runtime.h"

typedef struct SnTcpListener {
  int fd;
} SnTcpListener;

typedef struct SnTcpConn {
  int fd;
} SnTcpConn;

typedef struct SnAcceptReq {
  SnTcpListener *listener;
  SnFuture *future;
} SnAcceptReq;

typedef struct SnConnectReq {
  int fd;
  SnFuture *future;
} SnConnectReq;

typedef struct SnReadReq {
  SnTcpConn *conn;
  SnFuture *future;
  int32_t max_bytes;
} SnReadReq;

typedef struct SnWriteReq {
  SnTcpConn *conn;
  SnFuture *future;
  SnBytes *bytes;
  size_t sent;
} SnWriteReq;

static void *box_i64(int64_t v) {
  int64_t *box = (int64_t *)sn_alloc((int64_t)sizeof(int64_t));
  *box = v;
  return box;
}

static int64_t handle_to_i64(void *p) {
  return (int64_t)(intptr_t)p;
}

static void *i64_to_handle(int64_t v) {
  return (void *)(intptr_t)v;
}

static int set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    return -1;
  }
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void *make_error(const char *msg) {
  /* Minimal Error-shaped object: header + message pointer at field index 1.
   * Layout must match builtin Error (ObjectHeader + string*). */
  void *err = sn_alloc(16 + (int64_t)sizeof(void *));
  memset(err, 0, 16 + sizeof(void *));
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE; /* best-effort */
  ((SnObjectHeader *)err)->vtable = NULL;
  char *m = sn_str_concat(msg, "");
  *((char **)((char *)err + 16)) = m;
  return err;
}

static void accept_cb(void *userdata, int events) {
  SnAcceptReq *req = (SnAcceptReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  if (!(events & (SN_REACTOR_READ | SN_REACTOR_ERROR))) {
    return;
  }
  int cfd = accept(req->listener->fd, NULL, NULL);
  if (cfd < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return;
    }
    sn_future_fail(req->future, make_error("accept failed"));
    return;
  }
  set_nonblock(cfd);
  SnTcpConn *conn = (SnTcpConn *)sn_alloc((int64_t)sizeof(SnTcpConn));
  conn->fd = cfd;
  sn_gc_set_type(conn, SN_TYPEID_TCP_CONN);
  sn_reactor_del_fd(req->listener->fd);
  /* Re-arm listener for subsequent accepts only when needed; leave unregistered. */
  sn_future_complete(req->future, box_i64(handle_to_i64(conn)));
}

static void connect_cb(void *userdata, int events) {
  SnConnectReq *req = (SnConnectReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  int err = 0;
  socklen_t len = sizeof(err);
  if (getsockopt(req->fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
    sn_reactor_del_fd(req->fd);
    close(req->fd);
    req->fd = -1;
    sn_future_fail(req->future, make_error("connect failed"));
    return;
  }
  if (!(events & (SN_REACTOR_WRITE | SN_REACTOR_ERROR))) {
    return;
  }
  sn_reactor_del_fd(req->fd);
  SnTcpConn *conn = (SnTcpConn *)sn_alloc((int64_t)sizeof(SnTcpConn));
  conn->fd = req->fd;
  req->fd = -1;
  sn_gc_set_type(conn, SN_TYPEID_TCP_CONN);
  sn_future_complete(req->future, box_i64(handle_to_i64(conn)));
}

static void read_cb(void *userdata, int events) {
  SnReadReq *req = (SnReadReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  if (!(events & (SN_REACTOR_READ | SN_REACTOR_ERROR))) {
    return;
  }
  int32_t maxb = req->max_bytes > 0 ? req->max_bytes : 4096;
  uint8_t *buf = (uint8_t *)malloc((size_t)maxb);
  if (buf == NULL) {
    abort();
  }
  ssize_t n = read(req->conn->fd, buf, (size_t)maxb);
  sn_reactor_del_fd(req->conn->fd);
  if (n < 0) {
    free(buf);
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      sn_reactor_add_fd(req->conn->fd, SN_REACTOR_READ, read_cb, req);
      return;
    }
    sn_future_fail(req->future, make_error("read failed"));
    return;
  }
  int64_t handle = sn_bytes_copy_from(buf, n);
  free(buf);
  sn_future_complete(req->future, box_i64(handle));
}

static void write_cb(void *userdata, int events) {
  SnWriteReq *req = (SnWriteReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  if (!(events & (SN_REACTOR_WRITE | SN_REACTOR_ERROR))) {
    return;
  }
  size_t len = req->bytes != NULL ? (size_t)req->bytes->length : 0;
  const uint8_t *data = req->bytes != NULL ? req->bytes->data : NULL;
  while (req->sent < len) {
    ssize_t n = write(req->conn->fd, data + req->sent, len - req->sent);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return;
      }
      sn_reactor_del_fd(req->conn->fd);
      sn_future_fail(req->future, make_error("write failed"));
      return;
    }
    req->sent += (size_t)n;
  }
  sn_reactor_del_fd(req->conn->fd);
  sn_future_complete_void(req->future);
}

void *sn_tcp_listen(const char *host, int32_t port) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  char portbuf[16];
  snprintf(portbuf, sizeof(portbuf), "%d", (int)port);

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_PASSIVE;

  struct addrinfo *res = NULL;
  int ga = getaddrinfo(host == NULL || host[0] == '\0' ? NULL : host, portbuf, &hints, &res);
  if (ga != 0) {
    sn_future_fail(fut, make_error("getaddrinfo failed"));
    return fut;
  }

  int fd = -1;
  for (struct addrinfo *ai = res; ai != NULL; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) {
      continue;
    }
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    if (bind(fd, ai->ai_addr, ai->ai_addrlen) == 0 && listen(fd, 128) == 0) {
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    sn_future_fail(fut, make_error("listen failed"));
    return fut;
  }
  set_nonblock(fd);
  SnTcpListener *listener = (SnTcpListener *)sn_alloc((int64_t)sizeof(SnTcpListener));
  listener->fd = fd;
  sn_gc_set_type(listener, SN_TYPEID_TCP_LISTENER);
  sn_future_complete(fut, box_i64(handle_to_i64(listener)));
  return fut;
}

void *sn_tcp_accept(int64_t listener_handle) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnTcpListener *listener = (SnTcpListener *)i64_to_handle(listener_handle);
  if (listener == NULL || listener->fd < 0) {
    sn_future_fail(fut, make_error("invalid listener"));
    return fut;
  }
  int cfd = accept(listener->fd, NULL, NULL);
  if (cfd >= 0) {
    set_nonblock(cfd);
    SnTcpConn *conn = (SnTcpConn *)sn_alloc((int64_t)sizeof(SnTcpConn));
    conn->fd = cfd;
    sn_gc_set_type(conn, SN_TYPEID_TCP_CONN);
    sn_future_complete(fut, box_i64(handle_to_i64(conn)));
    return fut;
  }
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    sn_future_fail(fut, make_error("accept failed"));
    return fut;
  }
  SnAcceptReq *req = (SnAcceptReq *)sn_alloc((int64_t)sizeof(SnAcceptReq));
  req->listener = listener;
  req->future = fut;
  sn_reactor_add_fd(listener->fd, SN_REACTOR_READ, accept_cb, req);
  return fut;
}

void *sn_tcp_connect(const char *host, int32_t port) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  char portbuf[16];
  snprintf(portbuf, sizeof(portbuf), "%d", (int)port);

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;

  struct addrinfo *res = NULL;
  if (getaddrinfo(host, portbuf, &hints, &res) != 0) {
    sn_future_fail(fut, make_error("getaddrinfo failed"));
    return fut;
  }

  int fd = -1;
  int pending = 0;
  for (struct addrinfo *ai = res; ai != NULL; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) {
      continue;
    }
    set_nonblock(fd);
    int rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (rc == 0) {
      pending = 0;
      break;
    }
    if (errno == EINPROGRESS) {
      pending = 1;
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    sn_future_fail(fut, make_error("connect failed"));
    return fut;
  }
  if (!pending) {
    SnTcpConn *conn = (SnTcpConn *)sn_alloc((int64_t)sizeof(SnTcpConn));
    conn->fd = fd;
    sn_gc_set_type(conn, SN_TYPEID_TCP_CONN);
    sn_future_complete(fut, box_i64(handle_to_i64(conn)));
    return fut;
  }
  SnConnectReq *req = (SnConnectReq *)sn_alloc((int64_t)sizeof(SnConnectReq));
  req->fd = fd;
  req->future = fut;
  sn_reactor_add_fd(fd, SN_REACTOR_WRITE, connect_cb, req);
  return fut;
}

void *sn_tcp_read(int64_t conn_handle, int32_t max_bytes) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnTcpConn *conn = (SnTcpConn *)i64_to_handle(conn_handle);
  if (conn == NULL || conn->fd < 0) {
    sn_future_fail(fut, make_error("invalid connection"));
    return fut;
  }
  /* Bound allocation so a peer cannot force unbounded buffers per read. */
  if (max_bytes <= 0) {
    max_bytes = 65536;
  }
  if (max_bytes > 1048576) {
    max_bytes = 1048576;
  }
  SnReadReq *req = (SnReadReq *)sn_alloc((int64_t)sizeof(SnReadReq));
  req->conn = conn;
  req->future = fut;
  req->max_bytes = max_bytes;
  sn_reactor_add_fd(conn->fd, SN_REACTOR_READ, read_cb, req);
  return fut;
}

void *sn_tcp_write(int64_t conn_handle, int64_t bytes_handle) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnTcpConn *conn = (SnTcpConn *)i64_to_handle(conn_handle);
  if (conn == NULL || conn->fd < 0) {
    sn_future_fail(fut, make_error("invalid connection"));
    return fut;
  }
  SnBytes *bytes = (SnBytes *)sn_bytes_to_ptr(bytes_handle);
  SnWriteReq *req = (SnWriteReq *)sn_alloc((int64_t)sizeof(SnWriteReq));
  req->conn = conn;
  req->future = fut;
  req->bytes = bytes;
  req->sent = 0;

  size_t len = bytes != NULL ? (size_t)bytes->length : 0;
  const uint8_t *data = bytes != NULL ? bytes->data : NULL;
  while (req->sent < len) {
    ssize_t n = write(conn->fd, data + req->sent, len - req->sent);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        sn_reactor_add_fd(conn->fd, SN_REACTOR_WRITE, write_cb, req);
        return fut;
      }
      sn_future_fail(fut, make_error("write failed"));
      return fut;
    }
    req->sent += (size_t)n;
  }
  sn_future_complete_void(fut);
  return fut;
}

void *sn_tcp_flush(int64_t conn_handle) {
  (void)conn_handle;
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  sn_future_complete_void(fut);
  return fut;
}

void sn_tcp_close(void *conn_or_listener) {
  if (conn_or_listener == NULL) {
    return;
  }
  int fd = *(int *)conn_or_listener;
  if (fd >= 0) {
    sn_reactor_del_fd(fd);
    close(fd);
    *(int *)conn_or_listener = -1;
  }
}

int64_t sn_tcp_handle_to_i64(void *handle) {
  return handle_to_i64(handle);
}

void *sn_tcp_i64_to_handle(int64_t handle) {
  return i64_to_handle(handle);
}

void sn_tcp_close_i64(int64_t handle) {
  sn_tcp_close(i64_to_handle(handle));
}
