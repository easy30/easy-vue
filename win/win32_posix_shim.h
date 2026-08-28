/*  ----------  easy-vue: mingw-w64 POSIX shim (zig 交叉编译用)  ----------
 * zig 0.13 自带的 mingw-w64 缺 struct timespec / nanosleep / clock_gettime
 * （这些属 winpthread，zig 的 CRT 不含）。此头在交叉编译到 -windows-gnu
 * 目标时被强制 -include，自足补齐，不改 scriptc 公共包源码。
 *
 * Windows API 类型/函数一律来自 <windows.h>（WIN32_LEAN_AND_MEAN 减载），
 * 本头只补 POSIX 计时层，避免与 windows.h 重定义冲突。
 */
#ifndef EASYVUE_WIN32_POSIX_SHIM_H
#define EASYVUE_WIN32_POSIX_SHIM_H

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#ifndef _TIMESPEC_DEFINED
#define _TIMESPEC_DEFINED
struct timespec {
  time_t tv_sec;
  long   tv_nsec;
};
#endif

#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 1
#endif
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME  0
#endif

#ifdef __cplusplus
extern "C" {
#endif

static __inline int clock_gettime(int clk_id, struct timespec *ts) {
  if (clk_id == CLOCK_MONOTONIC) {
    ULONGLONG ms = GetTickCount64();
    if (ts) { ts->tv_sec = (time_t)(ms / 1000); ts->tv_nsec = (long)((ms % 1000) * 1000000); }
    return 0;
  }
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULONGLONG t = (((ULONGLONG)ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
  const ULONGLONG EPOCH = 116444736000000000ULL; /* 100ns: 1601->1970 */
  t = (t - EPOCH) / 10; /* us */
  if (ts) { ts->tv_sec = (time_t)(t / 1000000); ts->tv_nsec = (long)((t % 1000000) * 1000); }
  return 0;
}

static __inline int nanosleep(const struct timespec *req, struct timespec *rem) {
  if (!req) return -1;
  ULONGLONG ms = (ULONGLONG)(req->tv_sec) * 1000 + (ULONGLONG)(req->tv_nsec) / 1000000;
  Sleep((DWORD)ms);
  if (rem) { rem->tv_sec = 0; rem->tv_nsec = 0; }
  return 0;
}

#ifdef __cplusplus
}
#endif

#endif /* _WIN32 */
#endif /* EASYVUE_WIN32_POSIX_SHIM_H */
