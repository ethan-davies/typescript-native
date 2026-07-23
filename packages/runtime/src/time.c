#include <time.h>

#include "sn/runtime.h"

int64_t sn_time_now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) {
    return 0;
  }
  return (int64_t)ts.tv_sec * 1000 + (int64_t)ts.tv_nsec / 1000000;
}

void sn_time_sleep_ms(int64_t ms) {
  if (ms <= 0) {
    return;
  }
  struct timespec ts;
  ts.tv_sec = (time_t)(ms / 1000);
  ts.tv_nsec = (long)((ms % 1000) * 1000000);
  nanosleep(&ts, NULL);
}
