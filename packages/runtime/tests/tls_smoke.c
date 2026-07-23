#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

static char *read_file(const char *path) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    perror(path);
    return NULL;
  }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = (char *)malloc((size_t)n + 1);
  if (buf == NULL) {
    fclose(f);
    return NULL;
  }
  size_t got = fread(buf, 1, (size_t)n, f);
  fclose(f);
  buf[got] = '\0';
  return buf;
}

typedef struct Frame {
  int32_t state;
  void *fut;
  int64_t handle;
  char *cert;
  char *key;
  int64_t listener;
} Frame;

static void *g_done = NULL;
static int g_ok = 0;

static int64_t unbox_i64(void *v) {
  int64_t *b = (int64_t *)v;
  return b != NULL ? *b : 0;
}

static void client_resume(void *frame_ptr) {
  Frame *f = (Frame *)frame_ptr;
  void *task = sn_task_current();
  if (f->state == 0) {
    fprintf(stderr, "client: connect\n");
    f->fut = sn_tls_connect("127.0.0.1", 19071, 1, "");
    f->state = 1;
    sn_task_await(task, f->fut);
    return;
  }
  if (f->state == 1) {
    fprintf(stderr, "client: connected state=%d\n", sn_future_state(f->fut));
    assert(sn_future_state(f->fut) == SN_FUTURE_COMPLETED);
    int64_t tls = unbox_i64(sn_future_value(f->fut));
    f->handle = tls;
    f->fut = sn_tls_write(tls, sn_bytes_from_cstr("ping"));
    f->state = 2;
    sn_task_await(task, f->fut);
    return;
  }
  if (f->state == 2) {
    fprintf(stderr, "client: wrote\n");
    sn_tls_close_i64(f->handle);
    f->state = 3;
  }
}

static void server_resume(void *frame_ptr) {
  Frame *f = (Frame *)frame_ptr;
  void *task = sn_task_current();
  if (f->state == 0) {
    fprintf(stderr, "server: accept\n");
    f->fut = sn_tcp_accept(f->listener);
    f->state = 1;
    sn_task_await(task, f->fut);
    return;
  }
  if (f->state == 1) {
    fprintf(stderr, "server: tcp accepted\n");
    int64_t tcp = unbox_i64(sn_future_value(f->fut));
    f->fut = sn_tls_accept(tcp, 0, f->cert, f->key);
    f->state = 2;
    sn_task_await(task, f->fut);
    return;
  }
  if (f->state == 2) {
    fprintf(stderr, "server: tls accepted state=%d\n", sn_future_state(f->fut));
    assert(sn_future_state(f->fut) == SN_FUTURE_COMPLETED);
    int64_t tls = unbox_i64(sn_future_value(f->fut));
    f->handle = tls;
    f->fut = sn_tls_read(tls, 64);
    f->state = 3;
    sn_task_await(task, f->fut);
    return;
  }
  if (f->state == 3) {
    fprintf(stderr, "server: read\n");
    int64_t bytes = unbox_i64(sn_future_value(f->fut));
    char *s = sn_bytes_to_utf8(bytes);
    assert(s != NULL && strcmp(s, "ping") == 0);
    sn_tls_close_i64(f->handle);
    g_ok = 1;
    sn_future_complete_void(g_done);
    f->state = 4;
  }
}

int main(void) {
  sn_async_init();
  char *cert = read_file("tests/certs/cert.pem");
  char *key = read_file("tests/certs/key.pem");
  assert(cert != NULL && key != NULL);

  void *listen_fut = sn_tcp_listen("127.0.0.1", 19071);
  sn_future_await_run(listen_fut);
  assert(sn_future_state(listen_fut) == SN_FUTURE_COMPLETED);
  int64_t listener = unbox_i64(sn_future_value(listen_fut));
  fprintf(stderr, "listening\n");

  g_done = sn_future_new();

  Frame *sf = (Frame *)sn_alloc((int64_t)sizeof(Frame));
  memset(sf, 0, sizeof(Frame));
  sf->cert = cert;
  sf->key = key;
  sf->listener = listener;
  Frame *cf = (Frame *)sn_alloc((int64_t)sizeof(Frame));
  memset(cf, 0, sizeof(Frame));
  sn_task_spawn(server_resume, sf, sn_future_new());
  sn_task_spawn(client_resume, cf, sn_future_new());

  sn_future_await_run(g_done);
  assert(g_ok == 1);
  free(cert);
  free(key);
  sn_async_shutdown();
  printf("tls_smoke: ok\n");
  return 0;
}
