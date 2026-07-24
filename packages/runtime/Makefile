CC ?= clang
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -Iinclude -Isrc/common -D_POSIX_C_SOURCE=200809L
AR ?= ar
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Linux)
  ifeq ($(UNAME_M),x86_64)
    OPENSSL_PLATFORM := linux-x64
  else ifeq ($(UNAME_M),aarch64)
    OPENSSL_PLATFORM := linux-arm64
  else
    OPENSSL_PLATFORM := linux-$(UNAME_M)
  endif
  SRC_PLATFORM := $(wildcard src/linux/*.c)
else ifeq ($(UNAME_S),Darwin)
  ifeq ($(UNAME_M),arm64)
    OPENSSL_PLATFORM := macos-arm64
  else
    OPENSSL_PLATFORM := macos-x64
  endif
  SRC_PLATFORM := $(wildcard src/macos/*.c)
else
  $(error Unsupported Unix host '$(UNAME_S)'; use Makefile.win on Windows)
endif

OPENSSL_ROOT ?= $(abspath deps/openssl/$(OPENSSL_PLATFORM))
OPENSSL_STATIC := $(OPENSSL_ROOT)/lib/libssl.a

ifeq ($(wildcard $(OPENSSL_STATIC)),$(OPENSSL_STATIC))
  CFLAGS += -I$(OPENSSL_ROOT)/include
  OPENSSL_LIBS := $(OPENSSL_ROOT)/lib/libssl.a $(OPENSSL_ROOT)/lib/libcrypto.a
  ifeq ($(UNAME_S),Linux)
    OPENSSL_LIBS += -ldl
  endif
else
  OPENSSL_LIBS := -lssl -lcrypto
endif

SRC_COMMON := $(wildcard src/common/*.c)
SRC_POSIX := $(wildcard src/posix/*.c)

SOURCES := $(SRC_COMMON) $(SRC_POSIX) $(SRC_PLATFORM)
DIST_DIR := dist
OBJ_DIR := $(DIST_DIR)/obj
TEST_DIR := tests

OBJECTS := $(patsubst src/%.c,$(OBJ_DIR)/%.o,$(SOURCES))
LIBRARY := $(DIST_DIR)/libsn_runtime.a
SMOKE_BIN := $(DIST_DIR)/runtime_smoke
ASYNC_SMOKE_BIN := $(DIST_DIR)/async_smoke
TLS_SMOKE_BIN := $(DIST_DIR)/tls_smoke
NET_EXTRAS_SMOKE_BIN := $(DIST_DIR)/net_extras_smoke

.PHONY: all clean test openssl

all: $(LIBRARY)

openssl:
	node scripts/fetch-openssl.js

$(OBJ_DIR)/common $(OBJ_DIR)/posix $(OBJ_DIR)/linux $(OBJ_DIR)/macos:
	mkdir -p $@

$(OBJ_DIR)/%.o: src/%.c | $(OBJ_DIR)/common $(OBJ_DIR)/posix $(OBJ_DIR)/linux $(OBJ_DIR)/macos
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	@mkdir -p $(DIST_DIR)
	$(AR) rcs $@ $(OBJECTS)

$(SMOKE_BIN): $(TEST_DIR)/runtime_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread $(OPENSSL_LIBS) -o $@

$(ASYNC_SMOKE_BIN): $(TEST_DIR)/async_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread $(OPENSSL_LIBS) -o $@

$(TLS_SMOKE_BIN): $(TEST_DIR)/tls_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread $(OPENSSL_LIBS) -o $@

$(NET_EXTRAS_SMOKE_BIN): $(TEST_DIR)/net_extras_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread $(OPENSSL_LIBS) -o $@

test: $(SMOKE_BIN) $(ASYNC_SMOKE_BIN) $(TLS_SMOKE_BIN) $(NET_EXTRAS_SMOKE_BIN)
	./$(SMOKE_BIN)
	./$(ASYNC_SMOKE_BIN)
	./$(TLS_SMOKE_BIN)
	./$(NET_EXTRAS_SMOKE_BIN)

clean:
	rm -rf $(DIST_DIR)
