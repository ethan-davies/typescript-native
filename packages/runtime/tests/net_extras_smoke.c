#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "sn/runtime.h"

static int64_t unbox_i64(void *v) {
  int64_t *b = (int64_t *)v;
  return b != NULL ? *b : 0;
}

int main(void) {
  sn_async_init();

  /* Bytes */
  {
    int64_t h = sn_bytes_from_cstr("hello");
    assert(h != 0);
    assert(sn_bytes_len(h) == 5);
    assert(sn_bytes_get(h, 0) == (int32_t)'h');
    int64_t sliced = sn_bytes_slice(h, 1, 4);
    char *utf = sn_bytes_to_utf8(sliced);
    assert(utf != NULL && strcmp(utf, "ell") == 0);
  }

  /* DNS */
  {
    void *fut = sn_dns_resolve("localhost");
    sn_future_await_run(fut);
    assert(sn_future_state(fut) == SN_FUTURE_COMPLETED);
    void *arr = sn_future_value(fut);
    assert(arr != NULL);
    assert(((SnArray *)arr)->length > 0);
  }

  /* UDP loopback */
  {
    void *bind_fut = sn_udp_bind("127.0.0.1", 19091);
    sn_future_await_run(bind_fut);
    assert(sn_future_state(bind_fut) == SN_FUTURE_COMPLETED);
    int64_t sock = unbox_i64(sn_future_value(bind_fut));

    void *recv_fut = sn_udp_receive(sock, 64);
    int64_t payload = sn_bytes_from_cstr("udp-ok");
    void *send_fut = sn_udp_send(sock, payload, "127.0.0.1", 19091);
    sn_future_await_run(send_fut);
    assert(sn_future_state(send_fut) == SN_FUTURE_COMPLETED);
    sn_future_await_run(recv_fut);
    assert(sn_future_state(recv_fut) == SN_FUTURE_COMPLETED);
    int64_t packet = unbox_i64(sn_future_value(recv_fut));
    int64_t data = sn_udp_packet_bytes(packet);
    char *msg = sn_bytes_to_utf8(data);
    assert(msg != NULL && strcmp(msg, "udp-ok") == 0);
    sn_udp_close_i64(sock);
  }

  sn_async_shutdown();
  printf("net_extras_smoke: ok\n");
  return 0;
}
