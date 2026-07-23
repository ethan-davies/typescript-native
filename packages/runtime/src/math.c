#include <math.h>

#include "sn/runtime.h"

double sn_math_abs(double x) { return fabs(x); }
double sn_math_min(double a, double b) { return fmin(a, b); }
double sn_math_max(double a, double b) { return fmax(a, b); }
double sn_math_floor(double x) { return floor(x); }
double sn_math_ceil(double x) { return ceil(x); }
double sn_math_round(double x) { return round(x); }
double sn_math_sqrt(double x) { return sqrt(x); }
double sn_math_pow(double base, double exponent) { return pow(base, exponent); }
double sn_math_sin(double x) { return sin(x); }
double sn_math_cos(double x) { return cos(x); }
double sn_math_tan(double x) { return tan(x); }
double sn_math_log(double x) { return log(x); }
double sn_math_exp(double x) { return exp(x); }

int32_t sn_math_abs_i32(int32_t x) {
  if (x < 0) {
    return -x;
  }
  return x;
}

int64_t sn_math_abs_i64(int64_t x) {
  if (x < 0) {
    return -x;
  }
  return x;
}

int32_t sn_math_min_i32(int32_t a, int32_t b) { return a < b ? a : b; }
int32_t sn_math_max_i32(int32_t a, int32_t b) { return a > b ? a : b; }
int64_t sn_math_min_i64(int64_t a, int64_t b) { return a < b ? a : b; }
int64_t sn_math_max_i64(int64_t a, int64_t b) { return a > b ? a : b; }
