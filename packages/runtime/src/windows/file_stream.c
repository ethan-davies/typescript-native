#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include "async_internal.h"

#include <stdlib.h>
#include <string.h>

#include "sn/runtime.h"

#define SN_FILE_WORKERS 2
#define SN_FILE_MAX_READ 1048576

typedef struct SnFile {
  intptr_t fd; /* HANDLE */
  int closed;
} SnFile;

typedef enum {
  FILE_OP_OPEN = 1,
  FILE_OP_READ = 2,
  FILE_OP_WRITE = 3,
  FILE_OP_CLOSE = 4,
  FILE_OP_SIZE = 5
} FileOpKind;

typedef struct FileJob {
  FileOpKind kind;
  SnFuture *future;
  char *path;
  char *mode;
  SnFile *file;
  int64_t bytes_handle;
  int32_t max_bytes;
  struct FileJob *next;
} FileJob;

typedef struct FileResult {
  SnFuture *future;
  int failed;
  char *error_msg;
  int64_t value_i64;
  int is_void;
  int is_open_fd;
  int is_read;
  intptr_t open_fd;
  uint8_t *read_buf;
  int64_t read_len;
  struct FileResult *next;
} FileResult;

static CRITICAL_SECTION file_mu;
static CONDITION_VARIABLE file_cv;
static FileJob *file_queue = NULL;
static int file_workers_started = 0;
static int file_sync_ready = 0;

static CRITICAL_SECTION file_result_mu;
static FileResult *file_results = NULL;

static void ensure_file_sync(void) {
  if (file_sync_ready) {
    return;
  }
  InitializeCriticalSection(&file_mu);
  InitializeConditionVariable(&file_cv);
  InitializeCriticalSection(&file_result_mu);
  file_sync_ready = 1;
}

static char *sn_strdup(const char *s) {
  size_t n = strlen(s) + 1;
  char *p = (char *)malloc(n);
  if (p == NULL) {
    abort();
  }
  memcpy(p, s, n);
  return p;
}

static void *make_error(const char *msg) {
  void *err = sn_alloc(16 + (int64_t)sizeof(void *));
  memset(err, 0, 16 + sizeof(void *));
  ((SnObjectHeader *)err)->type_id = SN_TYPEID_CLASS_BASE;
  ((SnObjectHeader *)err)->vtable = NULL;
  char *m = sn_str_concat(msg, "");
  *((char **)((char *)err + 16)) = m;
  return err;
}

static void *box_i64(int64_t v) {
  int64_t *box = (int64_t *)sn_alloc((int64_t)sizeof(int64_t));
  *box = v;
  return box;
}

static int64_t handle_to_i64(void *p) {
  return (int64_t)(uintptr_t)p;
}

static void *i64_to_handle(int64_t h) {
  return (void *)(uintptr_t)h;
}

static int open_access_for_mode(const char *mode, DWORD *access, DWORD *creation, DWORD *share) {
  if (mode == NULL) {
    return -1;
  }
  *share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  if (strcmp(mode, "r") == 0) {
    *access = GENERIC_READ;
    *creation = OPEN_EXISTING;
    return 0;
  }
  if (strcmp(mode, "w") == 0) {
    *access = GENERIC_WRITE;
    *creation = CREATE_ALWAYS;
    return 0;
  }
  if (strcmp(mode, "a") == 0) {
    *access = GENERIC_WRITE;
    *creation = OPEN_ALWAYS;
    return 0;
  }
  if (strcmp(mode, "r+") == 0) {
    *access = GENERIC_READ | GENERIC_WRITE;
    *creation = OPEN_EXISTING;
    return 0;
  }
  return -1;
}

static void enqueue_result(FileResult *r) {
  EnterCriticalSection(&file_result_mu);
  r->next = file_results;
  file_results = r;
  LeaveCriticalSection(&file_result_mu);
  sn_reactor_wake();
}

static FileResult *new_result(SnFuture *fut) {
  FileResult *r = (FileResult *)malloc(sizeof(FileResult));
  if (r == NULL) {
    abort();
  }
  r->future = fut;
  r->failed = 0;
  r->error_msg = NULL;
  r->value_i64 = 0;
  r->is_void = 0;
  r->is_open_fd = 0;
  r->is_read = 0;
  r->open_fd = -1;
  r->read_buf = NULL;
  r->read_len = 0;
  r->next = NULL;
  return r;
}

static void fail_result(SnFuture *fut, const char *msg) {
  FileResult *r = new_result(fut);
  r->failed = 1;
  r->error_msg = sn_strdup(msg);
  enqueue_result(r);
}

static void run_job(FileJob *job) {
  if (job->kind == FILE_OP_OPEN) {
    DWORD access = 0;
    DWORD creation = 0;
    DWORD share = 0;
    if (open_access_for_mode(job->mode, &access, &creation, &share) != 0 || job->path == NULL) {
      fail_result(job->future, "invalid file mode");
      return;
    }
    HANDLE h = CreateFileA(job->path, access, share, NULL, creation, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
      DWORD err = GetLastError();
      if (err == ERROR_ACCESS_DENIED) {
        fail_result(job->future, "permission failure");
      } else if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) {
        fail_result(job->future, "file read failure");
      } else {
        fail_result(job->future, "file open failure");
      }
      return;
    }
    if (job->mode != NULL && strcmp(job->mode, "a") == 0) {
      SetFilePointer(h, 0, NULL, FILE_END);
    }
    FileResult *r = new_result(job->future);
    r->is_open_fd = 1;
    r->open_fd = (intptr_t)h;
    enqueue_result(r);
    return;
  }

  if (job->kind == FILE_OP_READ) {
    SnFile *file = job->file;
    if (file == NULL || file->closed || file->fd < 0) {
      fail_result(job->future, "stream closed");
      return;
    }
    int32_t maxb = job->max_bytes;
    if (maxb <= 0) {
      maxb = 65536;
    }
    if (maxb > SN_FILE_MAX_READ) {
      maxb = SN_FILE_MAX_READ;
    }
    uint8_t *buf = (uint8_t *)malloc((size_t)maxb);
    if (buf == NULL) {
      abort();
    }
    DWORD n = 0;
    if (!ReadFile((HANDLE)file->fd, buf, (DWORD)maxb, &n, NULL)) {
      free(buf);
      fail_result(job->future, "file read failure");
      return;
    }
    FileResult *r = new_result(job->future);
    r->is_read = 1;
    r->read_buf = buf;
    r->read_len = (int64_t)n;
    enqueue_result(r);
    return;
  }

  if (job->kind == FILE_OP_WRITE) {
    SnFile *file = job->file;
    if (file == NULL || file->closed || file->fd < 0) {
      fail_result(job->future, "stream closed");
      return;
    }
    SnBytes *bytes = (SnBytes *)sn_bytes_to_ptr(job->bytes_handle);
    size_t len = bytes != NULL ? (size_t)bytes->length : 0;
    const uint8_t *data = bytes != NULL ? bytes->data : NULL;
    size_t sent = 0;
    while (sent < len) {
      DWORD n = 0;
      DWORD chunk = (DWORD)(len - sent > 0x7fffffff ? 0x7fffffff : len - sent);
      if (!WriteFile((HANDLE)file->fd, data + sent, chunk, &n, NULL)) {
        fail_result(job->future, "file write failure");
        return;
      }
      sent += (size_t)n;
    }
    FileResult *r = new_result(job->future);
    r->is_void = 1;
    enqueue_result(r);
    return;
  }

  if (job->kind == FILE_OP_CLOSE) {
    SnFile *file = job->file;
    if (file != NULL && !file->closed && file->fd >= 0) {
      CloseHandle((HANDLE)file->fd);
      file->fd = -1;
      file->closed = 1;
    }
    FileResult *r = new_result(job->future);
    r->is_void = 1;
    enqueue_result(r);
    return;
  }

  if (job->kind == FILE_OP_SIZE) {
    SnFile *file = job->file;
    if (file == NULL || file->closed || file->fd < 0) {
      fail_result(job->future, "stream closed");
      return;
    }
    LARGE_INTEGER size;
    if (!GetFileSizeEx((HANDLE)file->fd, &size)) {
      fail_result(job->future, "file read failure");
      return;
    }
    FileResult *r = new_result(job->future);
    r->value_i64 = (int64_t)size.QuadPart;
    enqueue_result(r);
    return;
  }

  fail_result(job->future, "unknown file operation");
}

static DWORD WINAPI file_worker_main(void *arg) {
  (void)arg;
  for (;;) {
    EnterCriticalSection(&file_mu);
    while (file_queue == NULL) {
      SleepConditionVariableCS(&file_cv, &file_mu, INFINITE);
    }
    FileJob *job = file_queue;
    file_queue = job->next;
    LeaveCriticalSection(&file_mu);
    run_job(job);
    free(job->path);
    free(job->mode);
    free(job);
  }
  return 0;
}

static void ensure_file_workers(void) {
  ensure_file_sync();
  if (file_workers_started) {
    return;
  }
  EnterCriticalSection(&file_mu);
  if (!file_workers_started) {
    for (int i = 0; i < SN_FILE_WORKERS; i += 1) {
      HANDLE th = CreateThread(NULL, 0, file_worker_main, NULL, 0, NULL);
      if (th == NULL) {
        abort();
      }
      CloseHandle(th);
    }
    file_workers_started = 1;
  }
  LeaveCriticalSection(&file_mu);
}

static void enqueue_job(FileJob *job) {
  ensure_file_workers();
  EnterCriticalSection(&file_mu);
  job->next = file_queue;
  file_queue = job;
  WakeConditionVariable(&file_cv);
  LeaveCriticalSection(&file_mu);
}

static FileJob *new_job(FileOpKind kind, SnFuture *fut) {
  FileJob *job = (FileJob *)malloc(sizeof(FileJob));
  if (job == NULL) {
    abort();
  }
  job->kind = kind;
  job->future = fut;
  job->path = NULL;
  job->mode = NULL;
  job->file = NULL;
  job->bytes_handle = 0;
  job->max_bytes = 0;
  job->next = NULL;
  return job;
}

void sn_file_poll_results(void) {
  if (!file_sync_ready) {
    return;
  }
  for (;;) {
    EnterCriticalSection(&file_result_mu);
    FileResult *r = file_results;
    if (r != NULL) {
      file_results = r->next;
    }
    LeaveCriticalSection(&file_result_mu);
    if (r == NULL) {
      break;
    }
    if (r->future != NULL && r->future->state == SN_FUTURE_PENDING) {
      if (r->failed) {
        sn_future_fail(r->future, make_error(r->error_msg != NULL ? r->error_msg : "file failure"));
      } else if (r->is_void) {
        sn_future_complete_void(r->future);
      } else if (r->is_open_fd) {
        SnFile *file = (SnFile *)sn_alloc((int64_t)sizeof(SnFile));
        file->fd = r->open_fd;
        file->closed = 0;
        sn_gc_set_type(file, SN_TYPEID_FILE);
        sn_future_complete(r->future, box_i64(handle_to_i64(file)));
      } else if (r->is_read) {
        int64_t handle = sn_bytes_copy_from(r->read_buf, r->read_len);
        sn_future_complete(r->future, box_i64(handle));
      } else {
        sn_future_complete(r->future, box_i64(r->value_i64));
      }
    } else if (r->is_open_fd && r->open_fd >= 0) {
      CloseHandle((HANDLE)r->open_fd);
    }
    free(r->error_msg);
    free(r->read_buf);
    free(r);
  }
}

void *sn_file_open(const char *path, const char *mode) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  if (path == NULL || path[0] == '\0') {
    sn_future_fail(fut, make_error("invalid path"));
    return fut;
  }
  FileJob *job = new_job(FILE_OP_OPEN, fut);
  job->path = sn_strdup(path);
  job->mode = sn_strdup(mode != NULL ? mode : "r");
  enqueue_job(job);
  return fut;
}

void *sn_file_read(int64_t handle, int32_t max_bytes) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnFile *file = (SnFile *)i64_to_handle(handle);
  if (file == NULL) {
    sn_future_fail(fut, make_error("invalid file"));
    return fut;
  }
  FileJob *job = new_job(FILE_OP_READ, fut);
  job->file = file;
  job->max_bytes = max_bytes;
  enqueue_job(job);
  return fut;
}

void *sn_file_write(int64_t handle, int64_t bytes_handle) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnFile *file = (SnFile *)i64_to_handle(handle);
  if (file == NULL) {
    sn_future_fail(fut, make_error("invalid file"));
    return fut;
  }
  FileJob *job = new_job(FILE_OP_WRITE, fut);
  job->file = file;
  job->bytes_handle = bytes_handle;
  enqueue_job(job);
  return fut;
}

void *sn_file_close(int64_t handle) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnFile *file = (SnFile *)i64_to_handle(handle);
  FileJob *job = new_job(FILE_OP_CLOSE, fut);
  job->file = file;
  enqueue_job(job);
  return fut;
}

void *sn_file_size(int64_t handle) {
  sn_async_ensure_init();
  SnFuture *fut = (SnFuture *)sn_future_new();
  SnFile *file = (SnFile *)i64_to_handle(handle);
  if (file == NULL) {
    sn_future_fail(fut, make_error("invalid file"));
    return fut;
  }
  FileJob *job = new_job(FILE_OP_SIZE, fut);
  job->file = file;
  enqueue_job(job);
  return fut;
}
