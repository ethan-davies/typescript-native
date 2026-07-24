#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include "async_internal.h"
#include "winsock.h"

#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <process.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

#define SN_TLS_INSECURE_SKIP_VERIFY 1

typedef struct SnTcpConn {
  intptr_t fd;
} SnTcpConn;

typedef struct SnTlsConn {
  SSL *ssl;
  SSL_CTX *ctx;
  intptr_t fd;
  int owns_fd;
} SnTlsConn;

typedef struct SnTlsReadReq {
  SnTlsConn *conn;
  SnFuture *future;
  int32_t max_bytes;
} SnTlsReadReq;

typedef struct SnTlsWriteReq {
  SnTlsConn *conn;
  SnFuture *future;
  SnBytes *bytes;
  size_t sent;
} SnTlsWriteReq;

typedef struct SnTlsHsJob {
  SnTlsConn *conn;
  SnFuture *future;
  int is_accept;
  struct SnTlsHsJob *next;
} SnTlsHsJob;

typedef struct SnTlsHsResult {
  SnTlsConn *conn;
  SnFuture *future;
  int failed;
  struct SnTlsHsResult *next;
} SnTlsHsResult;

static int openssl_ready = 0;
static int tls_sync_ready = 0;
static CRITICAL_SECTION tls_hs_result_mu;
static SnTlsHsResult *tls_hs_results = NULL;

static void ensure_tls_sync(void) {
  if (tls_sync_ready) {
    return;
  }
  InitializeCriticalSection(&tls_hs_result_mu);
  tls_sync_ready = 1;
}

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

static void *make_error(const char *msg) {
  void *err = sn_alloc(16 + (int64_t)sizeof(void *));
  memset(err, 0, 16 + sizeof(void *));
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE;
  ((SnObjectHeader *)err)->vtable = NULL;
  char *m = sn_str_concat(msg, "");
  *((char **)((char *)err + 16)) = m;
  return err;
}

static int set_blocking(intptr_t fd, int blocking) {
  u_long mode = blocking ? 0 : 1;
  return ioctlsocket((SOCKET)fd, FIONBIO, &mode);
}

static int would_block(void) {
  int err = WSAGetLastError();
  return err == WSAEWOULDBLOCK || err == WSAEINPROGRESS;
}

static void ensure_openssl(void) {
  if (openssl_ready) {
    return;
  }
  sn_winsock_ensure();
  ensure_tls_sync();
  SSL_library_init();
  SSL_load_error_strings();
  OpenSSL_add_all_algorithms();
  openssl_ready = 1;
}

static SSL_CTX *make_client_ctx(int32_t flags, const char *ca_file) {
  ensure_openssl();
  SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
  if (ctx == NULL) {
    return NULL;
  }
  SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
  if ((flags & SN_TLS_INSECURE_SKIP_VERIFY) == 0) {
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    if (ca_file != NULL && ca_file[0] != '\0') {
      if (SSL_CTX_load_verify_locations(ctx, ca_file, NULL) != 1) {
        SSL_CTX_free(ctx);
        return NULL;
      }
    } else {
      SSL_CTX_set_default_verify_paths(ctx);
    }
  } else {
    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
  }
  return ctx;
}

static SSL_CTX *make_server_ctx(const char *cert_pem, const char *key_pem) {
  ensure_openssl();
  SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
  if (ctx == NULL) {
    return NULL;
  }
  SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
  BIO *cert_bio = BIO_new_mem_buf(cert_pem != NULL ? cert_pem : "", -1);
  BIO *key_bio = BIO_new_mem_buf(key_pem != NULL ? key_pem : "", -1);
  X509 *cert = PEM_read_bio_X509(cert_bio, NULL, NULL, NULL);
  EVP_PKEY *key = PEM_read_bio_PrivateKey(key_bio, NULL, NULL, NULL);
  BIO_free(cert_bio);
  BIO_free(key_bio);
  if (cert == NULL || key == NULL) {
    if (cert != NULL) {
      X509_free(cert);
    }
    if (key != NULL) {
      EVP_PKEY_free(key);
    }
    SSL_CTX_free(ctx);
    return NULL;
  }
  if (SSL_CTX_use_certificate(ctx, cert) != 1 || SSL_CTX_use_PrivateKey(ctx, key) != 1) {
    X509_free(cert);
    EVP_PKEY_free(key);
    SSL_CTX_free(ctx);
    return NULL;
  }
  X509_free(cert);
  EVP_PKEY_free(key);
  return ctx;
}

static void arm_tls_fd(SnTlsConn *conn, int events, SnReactorIoCb cb, void *userdata) {
  sn_reactor_del_fd(conn->fd);
  sn_reactor_add_fd(conn->fd, events, cb, userdata);
}

static void read_cb(void *userdata, int events);
static void write_cb(void *userdata, int events);

static void drain_hs_results(void) {
  ensure_tls_sync();
  for (;;) {
    EnterCriticalSection(&tls_hs_result_mu);
    SnTlsHsResult *r = tls_hs_results;
    if (r != NULL) {
      tls_hs_results = r->next;
    }
    LeaveCriticalSection(&tls_hs_result_mu);
    if (r == NULL) {
      break;
    }
    if (r->future != NULL && r->future->state == SN_FUTURE_PENDING) {
      if (r->failed || r->conn == NULL) {
        sn_future_fail(r->future, make_error("tls handshake failed"));
      } else {
        set_blocking(r->conn->fd, 0);
        sn_future_complete(r->future, box_i64(handle_to_i64(r->conn)));
      }
    }
    free(r);
  }
}

void sn_tls_poll_results(void) {
  drain_hs_results();
}

static unsigned __stdcall tls_hs_one_shot(void *arg) {
  SnTlsHsJob *job = (SnTlsHsJob *)arg;
  set_blocking(job->conn->fd, 1);
  int rc = job->is_accept ? SSL_accept(job->conn->ssl) : SSL_connect(job->conn->ssl);
  SnTlsHsResult *r = (SnTlsHsResult *)malloc(sizeof(SnTlsHsResult));
  if (r == NULL) {
    abort();
  }
  r->conn = job->conn;
  r->future = job->future;
  r->failed = rc != 1;
  r->next = NULL;
  if (rc != 1) {
    set_blocking(job->conn->fd, 0);
  }
  EnterCriticalSection(&tls_hs_result_mu);
  r->next = tls_hs_results;
  tls_hs_results = r;
  LeaveCriticalSection(&tls_hs_result_mu);
  free(job);
  sn_reactor_wake();
  return 0;
}

static void enqueue_handshake(SnTlsConn *conn, SnFuture *fut, int is_accept) {
  ensure_tls_sync();
  SnTlsHsJob *job = (SnTlsHsJob *)malloc(sizeof(SnTlsHsJob));
  if (job == NULL) {
    abort();
  }
  job->conn = conn;
  job->future = fut;
  job->is_accept = is_accept;
  job->next = NULL;
  uintptr_t th = _beginthreadex(NULL, 0, tls_hs_one_shot, job, 0, NULL);
  if (th == 0) {
    abort();
  }
  CloseHandle((HANDLE)th);
}

static void read_cb(void *userdata, int events) {
  (void)events;
  SnTlsReadReq *req = (SnTlsReadReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  int32_t maxb = req->max_bytes > 0 ? req->max_bytes : 4096;
  uint8_t *buf = (uint8_t *)malloc((size_t)maxb);
  if (buf == NULL) {
    abort();
  }
  int n = SSL_read(req->conn->ssl, buf, maxb);
  if (n > 0) {
    sn_reactor_del_fd(req->conn->fd);
    int64_t handle = sn_bytes_copy_from(buf, n);
    free(buf);
    sn_future_complete(req->future, box_i64(handle));
    return;
  }
  free(buf);
  int err = SSL_get_error(req->conn->ssl, n);
  if (err == SSL_ERROR_WANT_READ) {
    arm_tls_fd(req->conn, SN_REACTOR_READ, read_cb, req);
    return;
  }
  if (err == SSL_ERROR_WANT_WRITE) {
    arm_tls_fd(req->conn, SN_REACTOR_WRITE, read_cb, req);
    return;
  }
  if (err == SSL_ERROR_ZERO_RETURN || n == 0) {
    sn_reactor_del_fd(req->conn->fd);
    sn_future_complete(req->future, box_i64(sn_bytes_from_ptr(sn_bytes_new(0))));
    return;
  }
  sn_reactor_del_fd(req->conn->fd);
  sn_future_fail(req->future, make_error("tls read failed"));
}

static void write_cb(void *userdata, int events) {
  (void)events;
  SnTlsWriteReq *req = (SnTlsWriteReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  size_t len = req->bytes != NULL ? (size_t)req->bytes->length : 0;
  const uint8_t *data = req->bytes != NULL ? req->bytes->data : NULL;
  while (req->sent < len) {
    int n = SSL_write(req->conn->ssl, data + req->sent, (int)(len - req->sent));
    if (n > 0) {
      req->sent += (size_t)n;
      continue;
    }
    int err = SSL_get_error(req->conn->ssl, n);
    if (err == SSL_ERROR_WANT_WRITE) {
      arm_tls_fd(req->conn, SN_REACTOR_WRITE, write_cb, req);
      return;
    }
    if (err == SSL_ERROR_WANT_READ) {
      arm_tls_fd(req->conn, SN_REACTOR_READ, write_cb, req);
      return;
    }
    sn_reactor_del_fd(req->conn->fd);
    sn_future_fail(req->future, make_error("tls write failed"));
    return;
  }
  sn_reactor_del_fd(req->conn->fd);
  sn_future_complete_void(req->future);
}

extern void *sn_tcp_connect(const char *host, int32_t port);

static intptr_t tcp_fd_from_handle(int64_t tcp_handle) {
  SnTcpConn *conn = (SnTcpConn *)i64_to_handle(tcp_handle);
  if (conn == NULL) {
    return -1;
  }
  return conn->fd;
}

typedef struct SnTlsConnectState {
  SnFuture *result;
  SnFuture *tcp_fut;
  char *host;
  int32_t flags;
  char *ca_file;
} SnTlsConnectState;

static void tls_after_tcp(SnFuture *tcp_fut);

static void tcp_settle(SnFuture *self) {
  tls_after_tcp(self);
}

static void tls_after_tcp(SnFuture *tcp_fut) {
  SnTlsConnectState *st = (SnTlsConnectState *)tcp_fut->compose_data;
  if (st == NULL || st->result == NULL || st->result->state != SN_FUTURE_PENDING) {
    return;
  }
  if (tcp_fut->state == SN_FUTURE_FAILED) {
    sn_future_fail(st->result, tcp_fut->error != NULL ? tcp_fut->error : make_error("tcp connect failed"));
    return;
  }
  if (tcp_fut->state != SN_FUTURE_COMPLETED) {
    return;
  }
  int64_t *box = (int64_t *)tcp_fut->value;
  int64_t tcp_handle = box != NULL ? *box : 0;
  intptr_t fd = tcp_fd_from_handle(tcp_handle);
  if (fd < 0) {
    sn_future_fail(st->result, make_error("invalid tcp connection"));
    return;
  }
  SSL_CTX *ctx = make_client_ctx(st->flags, st->ca_file);
  if (ctx == NULL) {
    sn_future_fail(st->result, make_error("tls context failed"));
    return;
  }
  SSL *ssl = SSL_new(ctx);
  SSL_set_fd(ssl, (int)fd);
  SSL_set_tlsext_host_name(ssl, st->host);
  if ((st->flags & SN_TLS_INSECURE_SKIP_VERIFY) == 0) {
    SSL_set1_host(ssl, st->host);
  }
  SnTlsConn *conn = (SnTlsConn *)sn_alloc((int64_t)sizeof(SnTlsConn));
  conn->ssl = ssl;
  conn->ctx = ctx;
  conn->fd = fd;
  conn->owns_fd = 1;
  sn_gc_set_type(conn, SN_TYPEID_TLS_CONN);
  SnTcpConn *tcp = (SnTcpConn *)i64_to_handle(tcp_handle);
  if (tcp != NULL) {
    tcp->fd = -1;
  }
  enqueue_handshake(conn, st->result, 0);
}

void *sn_tls_connect(const char *host, int32_t port, int32_t flags, const char *ca_file) {
  sn_winsock_ensure();
  sn_async_ensure_init();
  SnFuture *result = (SnFuture *)sn_future_new();
  SnFuture *tcp = (SnFuture *)sn_tcp_connect(host, port);
  SnTlsConnectState *st = (SnTlsConnectState *)sn_alloc((int64_t)sizeof(SnTlsConnectState));
  st->result = result;
  st->tcp_fut = tcp;
  st->host = sn_str_concat(host != NULL ? host : "", "");
  st->flags = flags;
  st->ca_file = sn_str_concat(ca_file != NULL ? ca_file : "", "");
  tcp->compose_data = st;
  tcp->on_settle = tcp_settle;
  if (tcp->state != SN_FUTURE_PENDING) {
    tls_after_tcp(tcp);
  }
  return result;
}

void *sn_tls_accept(int64_t tcp_handle, int32_t flags, const char *cert_pem, const char *key_pem) {
  (void)flags;
  sn_winsock_ensure();
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  intptr_t fd = tcp_fd_from_handle(tcp_handle);
  if (fd < 0) {
    sn_future_fail(fut, make_error("invalid tcp connection"));
    return fut;
  }
  SSL_CTX *ctx = make_server_ctx(cert_pem, key_pem);
  if (ctx == NULL) {
    sn_future_fail(fut, make_error("tls server context failed"));
    return fut;
  }
  SSL *ssl = SSL_new(ctx);
  SSL_set_fd(ssl, (int)fd);
  SnTlsConn *conn = (SnTlsConn *)sn_alloc((int64_t)sizeof(SnTlsConn));
  conn->ssl = ssl;
  conn->ctx = ctx;
  conn->fd = fd;
  conn->owns_fd = 1;
  sn_gc_set_type(conn, SN_TYPEID_TLS_CONN);
  SnTcpConn *tcp = (SnTcpConn *)i64_to_handle(tcp_handle);
  if (tcp != NULL) {
    tcp->fd = -1;
  }
  enqueue_handshake(conn, fut, 1);
  return fut;
}

typedef struct SnTcpListener {
  intptr_t fd;
} SnTcpListener;

typedef struct SnTlsListenAcceptReq {
  SnTcpListener *listener;
  SnFuture *future;
  char *cert_pem;
  char *key_pem;
} SnTlsListenAcceptReq;

static void tls_listen_accept_cb(void *userdata, int events) {
  SnTlsListenAcceptReq *req = (SnTlsListenAcceptReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  if (!(events & (SN_REACTOR_READ | SN_REACTOR_ERROR))) {
    return;
  }
  SOCKET cfd = accept((SOCKET)req->listener->fd, NULL, NULL);
  if (cfd == INVALID_SOCKET) {
    if (would_block()) {
      return;
    }
    sn_reactor_del_fd(req->listener->fd);
    sn_future_fail(req->future, make_error("accept failed"));
    return;
  }
  sn_reactor_del_fd(req->listener->fd);
  SSL_CTX *ctx = make_server_ctx(req->cert_pem, req->key_pem);
  if (ctx == NULL) {
    closesocket(cfd);
    sn_future_fail(req->future, make_error("tls server context failed"));
    return;
  }
  SSL *ssl = SSL_new(ctx);
  SSL_set_fd(ssl, (int)cfd);
  SnTlsConn *conn = (SnTlsConn *)sn_alloc((int64_t)sizeof(SnTlsConn));
  conn->ssl = ssl;
  conn->ctx = ctx;
  conn->fd = (intptr_t)cfd;
  conn->owns_fd = 1;
  sn_gc_set_type(conn, SN_TYPEID_TLS_CONN);
  enqueue_handshake(conn, req->future, 1);
}

void *sn_tls_accept_listener(int64_t listener_handle, const char *cert_pem, const char *key_pem) {
  sn_winsock_ensure();
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnTcpListener *listener = (SnTcpListener *)i64_to_handle(listener_handle);
  if (listener == NULL || listener->fd < 0) {
    sn_future_fail(fut, make_error("invalid listener"));
    return fut;
  }
  SOCKET cfd = accept((SOCKET)listener->fd, NULL, NULL);
  if (cfd != INVALID_SOCKET) {
    SSL_CTX *ctx = make_server_ctx(cert_pem, key_pem);
    if (ctx == NULL) {
      closesocket(cfd);
      sn_future_fail(fut, make_error("tls server context failed"));
      return fut;
    }
    SSL *ssl = SSL_new(ctx);
    SSL_set_fd(ssl, (int)cfd);
    SnTlsConn *conn = (SnTlsConn *)sn_alloc((int64_t)sizeof(SnTlsConn));
    conn->ssl = ssl;
    conn->ctx = ctx;
    conn->fd = (intptr_t)cfd;
    conn->owns_fd = 1;
    sn_gc_set_type(conn, SN_TYPEID_TLS_CONN);
    enqueue_handshake(conn, fut, 1);
    return fut;
  }
  if (!would_block()) {
    sn_future_fail(fut, make_error("accept failed"));
    return fut;
  }
  SnTlsListenAcceptReq *req = (SnTlsListenAcceptReq *)sn_alloc((int64_t)sizeof(SnTlsListenAcceptReq));
  req->listener = listener;
  req->future = fut;
  req->cert_pem = sn_str_concat(cert_pem != NULL ? cert_pem : "", "");
  req->key_pem = sn_str_concat(key_pem != NULL ? key_pem : "", "");
  sn_reactor_add_fd(listener->fd, SN_REACTOR_READ, tls_listen_accept_cb, req);
  return fut;
}

void *sn_tls_read(int64_t tls_handle, int32_t max_bytes) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnTlsConn *conn = (SnTlsConn *)i64_to_handle(tls_handle);
  if (conn == NULL || conn->ssl == NULL) {
    sn_future_fail(fut, make_error("invalid tls connection"));
    return fut;
  }
  SnTlsReadReq *req = (SnTlsReadReq *)sn_alloc((int64_t)sizeof(SnTlsReadReq));
  req->conn = conn;
  req->future = fut;
  req->max_bytes = max_bytes;
  arm_tls_fd(conn, SN_REACTOR_READ, read_cb, req);
  read_cb(req, SN_REACTOR_READ);
  return fut;
}

void *sn_tls_write(int64_t tls_handle, int64_t bytes_handle) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnTlsConn *conn = (SnTlsConn *)i64_to_handle(tls_handle);
  if (conn == NULL || conn->ssl == NULL) {
    sn_future_fail(fut, make_error("invalid tls connection"));
    return fut;
  }
  SnTlsWriteReq *req = (SnTlsWriteReq *)sn_alloc((int64_t)sizeof(SnTlsWriteReq));
  req->conn = conn;
  req->future = fut;
  req->bytes = (SnBytes *)sn_bytes_to_ptr(bytes_handle);
  req->sent = 0;
  write_cb(req, SN_REACTOR_WRITE);
  return fut;
}

void sn_tls_close_i64(int64_t handle) {
  SnTlsConn *conn = (SnTlsConn *)i64_to_handle(handle);
  if (conn == NULL) {
    return;
  }
  if (conn->ssl != NULL) {
    SSL_shutdown(conn->ssl);
    SSL_free(conn->ssl);
    conn->ssl = NULL;
  }
  if (conn->ctx != NULL) {
    SSL_CTX_free(conn->ctx);
    conn->ctx = NULL;
  }
  if (conn->owns_fd && conn->fd >= 0) {
    sn_reactor_del_fd(conn->fd);
    closesocket((SOCKET)conn->fd);
    conn->fd = -1;
  }
}
