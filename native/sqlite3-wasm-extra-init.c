#define SQLITE_CORE 1
#include "sqlite3.h"

/*
 * Browser WebAssembly has no compatible dlopen(), so the canonical SQLite Wasm
 * build compiles this extension into the same module. rembero.c includes the
 * recursive evaluator and exposes the standard three-argument extension entry
 * point used by sqlite3_auto_extension().
 */
#include "rembero.c"

int sqlite3_wasm_extra_init(const char *unused) {
  (void)unused;
  return sqlite3_auto_extension((void (*)(void))sqlite3_rembero_init);
}
