#pragma once
#include <stdint.h>

typedef struct {
  int32_t x;
  int32_t y;
} SnExamplePoint;

int32_t sn_example_add(int32_t a, int32_t b);
int32_t sn_example_point_sum(const SnExamplePoint *p);
void sn_example_call(void (*cb)(int32_t), int32_t value);
