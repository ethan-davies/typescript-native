CC ?= clang
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2 -Iinclude
AR ?= ar

SRC_DIR := src
DIST_DIR := dist
OBJ_DIR := $(DIST_DIR)/obj
TEST_DIR := tests

SOURCES := $(wildcard $(SRC_DIR)/*.c)
OBJECTS := $(patsubst $(SRC_DIR)/%.c,$(OBJ_DIR)/%.o,$(SOURCES))
LIBRARY := $(DIST_DIR)/libtsn_runtime.a
SMOKE_BIN := $(DIST_DIR)/runtime_smoke

.PHONY: all clean test

all: $(LIBRARY)

$(OBJ_DIR):
	mkdir -p $(OBJ_DIR)

$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c | $(OBJ_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	$(AR) rcs $@ $(OBJECTS)

$(SMOKE_BIN): $(TEST_DIR)/runtime_smoke.c $(LIBRARY)
	$(CC) $(CFLAGS) $< $(LIBRARY) -o $@

test: $(SMOKE_BIN)
	./$(SMOKE_BIN)

clean:
	rm -rf $(DIST_DIR)
