CC ?= clang
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -Iinclude -D_POSIX_C_SOURCE=200809L
AR ?= ar

SRC_DIR := src
DIST_DIR := dist
OBJ_DIR := $(DIST_DIR)/obj
TEST_DIR := tests

SOURCES := $(wildcard $(SRC_DIR)/*.c)
OBJECTS := $(patsubst $(SRC_DIR)/%.c,$(OBJ_DIR)/%.o,$(SOURCES))
LIBRARY := $(DIST_DIR)/libsn_runtime.a
SMOKE_BIN := $(DIST_DIR)/runtime_smoke
ASYNC_SMOKE_BIN := $(DIST_DIR)/async_smoke
TLS_SMOKE_BIN := $(DIST_DIR)/tls_smoke
NET_EXTRAS_SMOKE_BIN := $(DIST_DIR)/net_extras_smoke

.PHONY: all clean test

all: $(LIBRARY)

$(OBJ_DIR):
	mkdir -p $(OBJ_DIR)

$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c | $(OBJ_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	$(AR) rcs $@ $(OBJECTS)

$(SMOKE_BIN): $(TEST_DIR)/runtime_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread -lssl -lcrypto -o $@

$(ASYNC_SMOKE_BIN): $(TEST_DIR)/async_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread -lssl -lcrypto -o $@

$(TLS_SMOKE_BIN): $(TEST_DIR)/tls_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread -lssl -lcrypto -o $@

$(NET_EXTRAS_SMOKE_BIN): $(TEST_DIR)/net_extras_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -lm -lpthread -lssl -lcrypto -o $@

test: $(SMOKE_BIN) $(ASYNC_SMOKE_BIN) $(TLS_SMOKE_BIN) $(NET_EXTRAS_SMOKE_BIN)
	./$(SMOKE_BIN)
	./$(ASYNC_SMOKE_BIN)
	./$(TLS_SMOKE_BIN)
	./$(NET_EXTRAS_SMOKE_BIN)

clean:
	rm -rf $(DIST_DIR)
