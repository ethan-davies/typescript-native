#include <math.h>

#include "tsn/runtime.h"

double tsn_math_abs(double x) { return fabs(x); }
double tsn_math_min(double a, double b) { return fmin(a, b); }
double tsn_math_max(double a, double b) { return fmax(a, b); }
double tsn_math_floor(double x) { return floor(x); }
double tsn_math_ceil(double x) { return ceil(x); }
double tsn_math_round(double x) { return round(x); }
double tsn_math_sqrt(double x) { return sqrt(x); }
double tsn_math_pow(double base, double exponent) { return pow(base, exponent); }
double tsn_math_sin(double x) { return sin(x); }
double tsn_math_cos(double x) { return cos(x); }
double tsn_math_tan(double x) { return tan(x); }
double tsn_math_log(double x) { return log(x); }
double tsn_math_exp(double x) { return exp(x); }

int32_t tsn_math_abs_i32(int32_t x) {
  if (x < 0) {
    return -x;
  }
  return x;
}

int64_t tsn_math_abs_i64(int64_t x) {
  if (x < 0) {
    return -x;
  }
  return x;
}

int32_t tsn_math_min_i32(int32_t a, int32_t b) { return a < b ? a : b; }
int32_t tsn_math_max_i32(int32_t a, int32_t b) { return a > b ? a : b; }
int64_t tsn_math_min_i64(int64_t a, int64_t b) { return a < b ? a : b; }
int64_t tsn_math_max_i64(int64_t a, int64_t b) { return a > b ? a : b; }
