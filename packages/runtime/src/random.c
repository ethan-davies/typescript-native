#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#include "sn/runtime.h"

static int sn_random_seeded = 0;

static void sn_random_ensure_seeded(void) {
  if (sn_random_seeded) {
    return;
  }
  /* Mix time with ASLR entropy so consecutive processes differ. */
  unsigned seed = (unsigned)time(NULL) ^ (unsigned)(uintptr_t)&sn_random_seeded;
  srand(seed == 0 ? 1u : seed);
  sn_random_seeded = 1;
}

void sn_random_seed(int64_t seed) {
  srand((unsigned)(seed == 0 ? 1 : seed));
  sn_random_seeded = 1;
}

/* Uniform in [0, 1). */
double sn_random(void) {
  sn_random_ensure_seeded();
  return (double)rand() / ((double)RAND_MAX + 1.0);
}

/* Inclusive [min, max]. Empty/inverted ranges return min. */
int32_t sn_random_int(int32_t min, int32_t max) {
  sn_random_ensure_seeded();
  if (max < min) {
    int32_t tmp = min;
    min = max;
    max = tmp;
  }
  int64_t span = (int64_t)max - (int64_t)min + 1;
  if (span <= 0) {
    return min;
  }
  int32_t value = min + (int32_t)((int64_t)(sn_random() * (double)span));
  if (value > max) {
    value = max;
  }
  return value;
}

/* Half-open [min, max). If max <= min, returns min. */
double sn_random_float(double min, double max) {
  sn_random_ensure_seeded();
  if (max <= min) {
    return min;
  }
  return min + sn_random() * (max - min);
}
