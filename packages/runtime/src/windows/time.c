#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "sn/runtime.h"

int64_t sn_time_now_ms(void) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER uli;
  uli.LowPart = ft.dwLowDateTime;
  uli.HighPart = ft.dwHighDateTime;
  /* FILETIME is 100-ns intervals since 1601-01-01. */
  return (int64_t)(uli.QuadPart / 10000ULL) - 11644473600000LL;
}

void sn_time_sleep_ms(int64_t ms) {
  if (ms <= 0) {
    return;
  }
  if (ms > 0xFFFFFFFFll) {
    ms = 0xFFFFFFFFll;
  }
  Sleep((DWORD)ms);
}
