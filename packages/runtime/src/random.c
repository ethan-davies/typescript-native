#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#include "tsn/runtime.h"

static int tsn_random_seeded = 0;

static void tsn_random_ensure_seeded(void) {
  if (tsn_random_seeded) {
    return;
  }
  /* Mix time with ASLR entropy so consecutive processes differ. */
  unsigned seed = (unsigned)time(NULL) ^ (unsigned)(uintptr_t)&tsn_random_seeded;
  srand(seed == 0 ? 1u : seed);
  tsn_random_seeded = 1;
}

void tsn_random_seed(int64_t seed) {
  srand((unsigned)(seed == 0 ? 1 : seed));
  tsn_random_seeded = 1;
}

/* Uniform in [0, 1). */
double tsn_random(void) {
  tsn_random_ensure_seeded();
  return (double)rand() / ((double)RAND_MAX + 1.0);
}

/* Inclusive [min, max]. Empty/inverted ranges return min. */
int32_t tsn_random_int(int32_t min, int32_t max) {
  tsn_random_ensure_seeded();
  if (max < min) {
    int32_t tmp = min;
    min = max;
    max = tmp;
  }
  int64_t span = (int64_t)max - (int64_t)min + 1;
  if (span <= 0) {
    return min;
  }
  int32_t value = min + (int32_t)((int64_t)(tsn_random() * (double)span));
  if (value > max) {
    value = max;
  }
  return value;
}

/* Half-open [min, max). If max <= min, returns min. */
double tsn_random_float(double min, double max) {
  tsn_random_ensure_seeded();
  if (max <= min) {
    return min;
  }
  return min + tsn_random() * (max - min);
}
