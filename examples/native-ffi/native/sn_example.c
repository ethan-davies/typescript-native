#include "include/sn_example.h"

int32_t sn_example_add(int32_t a, int32_t b) {
  return a + b;
}

int32_t sn_example_point_sum(const SnExamplePoint *p) {
  if (!p) return 0;
  return p->x + p->y;
}

void sn_example_call(void (*cb)(int32_t), int32_t value) {
  if (cb) cb(value);
}
