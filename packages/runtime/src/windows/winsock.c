#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <windows.h>

#include <stdlib.h>

#include "winsock.h"

static INIT_ONCE winsock_once = INIT_ONCE_STATIC_INIT;
static int winsock_ready = 0;

static BOOL CALLBACK winsock_init_once(PINIT_ONCE once, PVOID param, PVOID *ctx) {
  (void)once;
  (void)param;
  (void)ctx;
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    return FALSE;
  }
  winsock_ready = 1;
  return TRUE;
}

void sn_winsock_ensure(void) {
  if (!InitOnceExecuteOnce(&winsock_once, winsock_init_once, NULL, NULL)) {
    abort();
  }
}

void sn_winsock_shutdown(void) {
  if (winsock_ready) {
    WSACleanup();
    winsock_ready = 0;
  }
}
