#include "sn/runtime.h"

char *sn_os_platform(void) {
#if defined(_WIN32)
  return sn_str_concat("windows", "");
#elif defined(__APPLE__)
  return sn_str_concat("macos", "");
#elif defined(__linux__)
  return sn_str_concat("linux", "");
#else
  return sn_str_concat("unknown", "");
#endif
}

char *sn_os_architecture(void) {
#if defined(__aarch64__) || defined(_M_ARM64)
  return sn_str_concat("arm64", "");
#elif defined(__x86_64__) || defined(_M_X64) || defined(__amd64__)
  return sn_str_concat("x64", "");
#else
  return sn_str_concat("unknown", "");
#endif
}
