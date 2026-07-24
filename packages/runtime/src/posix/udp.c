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
#include <arpa/inet.h>

#include "sn/runtime.h"

typedef struct SnUdpSocket {
  int fd;
} SnUdpSocket;

typedef struct SnUdpPacket {
  int64_t bytes_handle;
  char *host;
  int32_t port;
} SnUdpPacket;

typedef struct SnUdpRecvReq {
  SnUdpSocket *sock;
  SnFuture *future;
  int32_t max_bytes;
} SnUdpRecvReq;

typedef struct SnUdpSendReq {
  SnUdpSocket *sock;
  SnFuture *future;
  SnBytes *bytes;
  struct sockaddr_storage addr;
  socklen_t addrlen;
  size_t sent;
} SnUdpSendReq;

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
  void *err = sn_alloc(16 + (int64_t)sizeof(void *));
  memset(err, 0, 16 + sizeof(void *));
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE;
  ((SnObjectHeader *)err)->vtable = NULL;
  char *m = sn_str_concat(msg, "");
  *((char **)((char *)err + 16)) = m;
  return err;
}

static int64_t make_packet(int64_t bytes_handle, const char *host, int32_t port) {
  SnUdpPacket *p = (SnUdpPacket *)sn_alloc((int64_t)sizeof(SnUdpPacket));
  p->bytes_handle = bytes_handle;
  p->host = sn_str_concat(host != NULL ? host : "", "");
  p->port = port;
  sn_gc_set_type(p, SN_TYPEID_UDP_PACKET);
  return handle_to_i64(p);
}

int64_t sn_udp_packet_bytes(int64_t packet_handle) {
  SnUdpPacket *p = (SnUdpPacket *)i64_to_handle(packet_handle);
  return p != NULL ? p->bytes_handle : 0;
}

char *sn_udp_packet_host(int64_t packet_handle) {
  SnUdpPacket *p = (SnUdpPacket *)i64_to_handle(packet_handle);
  return p != NULL && p->host != NULL ? p->host : sn_str_concat("", "");
}

int32_t sn_udp_packet_port(int64_t packet_handle) {
  SnUdpPacket *p = (SnUdpPacket *)i64_to_handle(packet_handle);
  return p != NULL ? p->port : 0;
}

static void recv_cb(void *userdata, int events) {
  SnUdpRecvReq *req = (SnUdpRecvReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  if (!(events & (SN_REACTOR_READ | SN_REACTOR_ERROR))) {
    return;
  }
  int32_t maxb = req->max_bytes > 0 ? req->max_bytes : 65535;
  uint8_t *buf = (uint8_t *)malloc((size_t)maxb);
  if (buf == NULL) {
    abort();
  }
  struct sockaddr_storage peer;
  socklen_t peerlen = sizeof(peer);
  ssize_t n = recvfrom(req->sock->fd, buf, (size_t)maxb, 0, (struct sockaddr *)&peer, &peerlen);
  sn_reactor_del_fd(req->sock->fd);
  if (n < 0) {
    free(buf);
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      sn_reactor_add_fd(req->sock->fd, SN_REACTOR_READ, recv_cb, req);
      return;
    }
    sn_future_fail(req->future, make_error("udp receive failed"));
    return;
  }
  char host[INET6_ADDRSTRLEN];
  int32_t port = 0;
  host[0] = '\0';
  if (peer.ss_family == AF_INET) {
    struct sockaddr_in *in = (struct sockaddr_in *)&peer;
    inet_ntop(AF_INET, &in->sin_addr, host, sizeof(host));
    port = (int32_t)ntohs(in->sin_port);
  } else if (peer.ss_family == AF_INET6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)&peer;
    inet_ntop(AF_INET6, &in6->sin6_addr, host, sizeof(host));
    port = (int32_t)ntohs(in6->sin6_port);
  }
  int64_t bytes = sn_bytes_copy_from(buf, n);
  free(buf);
  sn_future_complete(req->future, box_i64(make_packet(bytes, host, port)));
}

static void send_cb(void *userdata, int events) {
  SnUdpSendReq *req = (SnUdpSendReq *)userdata;
  if (req == NULL || req->future == NULL || req->future->state != SN_FUTURE_PENDING) {
    return;
  }
  if (!(events & (SN_REACTOR_WRITE | SN_REACTOR_ERROR))) {
    return;
  }
  size_t len = req->bytes != NULL ? (size_t)req->bytes->length : 0;
  const uint8_t *data = req->bytes != NULL ? req->bytes->data : NULL;
  ssize_t n = sendto(req->sock->fd, data, len, 0, (struct sockaddr *)&req->addr, req->addrlen);
  sn_reactor_del_fd(req->sock->fd);
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      sn_reactor_add_fd(req->sock->fd, SN_REACTOR_WRITE, send_cb, req);
      return;
    }
    sn_future_fail(req->future, make_error("udp send failed"));
    return;
  }
  sn_future_complete_void(req->future);
}

void *sn_udp_bind(const char *host, int32_t port) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  char portbuf[16];
  snprintf(portbuf, sizeof(portbuf), "%d", (int)port);

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
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
    if (bind(fd, ai->ai_addr, ai->ai_addrlen) == 0) {
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    sn_future_fail(fut, make_error("udp bind failed"));
    return fut;
  }
  set_nonblock(fd);
  SnUdpSocket *sock = (SnUdpSocket *)sn_alloc((int64_t)sizeof(SnUdpSocket));
  sock->fd = fd;
  sn_gc_set_type(sock, SN_TYPEID_UDP_SOCK);
  sn_future_complete(fut, box_i64(handle_to_i64(sock)));
  return fut;
}

void *sn_udp_send(int64_t socket_handle, int64_t bytes_handle, const char *host, int32_t port) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnUdpSocket *sock = (SnUdpSocket *)i64_to_handle(socket_handle);
  if (sock == NULL || sock->fd < 0) {
    sn_future_fail(fut, make_error("invalid udp socket"));
    return fut;
  }
  char portbuf[16];
  snprintf(portbuf, sizeof(portbuf), "%d", (int)port);
  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo *res = NULL;
  if (getaddrinfo(host, portbuf, &hints, &res) != 0 || res == NULL) {
    sn_future_fail(fut, make_error("udp send resolve failed"));
    return fut;
  }

  SnBytes *bytes = (SnBytes *)sn_bytes_to_ptr(bytes_handle);
  size_t len = bytes != NULL ? (size_t)bytes->length : 0;
  const uint8_t *data = bytes != NULL ? bytes->data : NULL;
  ssize_t n = sendto(sock->fd, data, len, 0, res->ai_addr, res->ai_addrlen);
  if (n >= 0) {
    freeaddrinfo(res);
    sn_future_complete_void(fut);
    return fut;
  }
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    freeaddrinfo(res);
    sn_future_fail(fut, make_error("udp send failed"));
    return fut;
  }
  SnUdpSendReq *req = (SnUdpSendReq *)sn_alloc((int64_t)sizeof(SnUdpSendReq));
  req->sock = sock;
  req->future = fut;
  req->bytes = bytes;
  memset(&req->addr, 0, sizeof(req->addr));
  memcpy(&req->addr, res->ai_addr, res->ai_addrlen);
  req->addrlen = res->ai_addrlen;
  req->sent = 0;
  freeaddrinfo(res);
  sn_reactor_add_fd(sock->fd, SN_REACTOR_WRITE, send_cb, req);
  return fut;
}

void *sn_udp_receive(int64_t socket_handle, int32_t max_bytes) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnUdpSocket *sock = (SnUdpSocket *)i64_to_handle(socket_handle);
  if (sock == NULL || sock->fd < 0) {
    sn_future_fail(fut, make_error("invalid udp socket"));
    return fut;
  }
  SnUdpRecvReq *req = (SnUdpRecvReq *)sn_alloc((int64_t)sizeof(SnUdpRecvReq));
  req->sock = sock;
  req->future = fut;
  req->max_bytes = max_bytes;
  /* Try once immediately so a packet already queued completes without epoll.
   * On EAGAIN, recv_cb re-arms the fd itself. */
  recv_cb(req, SN_REACTOR_READ);
  return fut;
}

void sn_udp_close_i64(int64_t handle) {
  SnUdpSocket *sock = (SnUdpSocket *)i64_to_handle(handle);
  if (sock == NULL || sock->fd < 0) {
    return;
  }
  sn_reactor_del_fd(sock->fd);
  close(sock->fd);
  sock->fd = -1;
}
