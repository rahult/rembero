#ifndef REMBERO_SQLITE_EXTENSION_H
#define REMBERO_SQLITE_EXTENSION_H

#include <sqlite3ext.h>

/*
 * Apple's SDK sqlite3ext.h defines SQLITE_OMIT_LOAD_EXTENSION itself, which
 * suppresses the normal extension API indirection macros even when compiling
 * a library for a different SQLite host (for example Node's embedded SQLite).
 * Restore only the API surface used by this extension. On standard SQLite
 * development headers these definitions already exist and this block is inert.
 */
#ifdef SQLITE_OMIT_LOAD_EXTENSION
#undef SQLITE_OMIT_LOAD_EXTENSION
#undef SQLITE_EXTENSION_INIT1
#undef SQLITE_EXTENSION_INIT2

#define sqlite3_column_blob sqlite3_api->column_blob
#define sqlite3_column_bytes sqlite3_api->column_bytes
#define sqlite3_column_count sqlite3_api->column_count
#define sqlite3_column_double sqlite3_api->column_double
#define sqlite3_column_int64 sqlite3_api->column_int64
#define sqlite3_column_name sqlite3_api->column_name
#define sqlite3_column_text sqlite3_api->column_text
#define sqlite3_column_type sqlite3_api->column_type
#define sqlite3_context_db_handle sqlite3_api->context_db_handle
#define sqlite3_create_function_v2 sqlite3_api->create_function_v2
#define sqlite3_errmsg sqlite3_api->errmsg
#define sqlite3_finalize sqlite3_api->finalize
#define sqlite3_free sqlite3_api->free
#define sqlite3_malloc64 sqlite3_api->malloc64
#define sqlite3_mprintf sqlite3_api->mprintf
#define sqlite3_prepare_v2 sqlite3_api->prepare_v2
#define sqlite3_result_error sqlite3_api->result_error
#define sqlite3_result_error_nomem sqlite3_api->result_error_nomem
#define sqlite3_result_text sqlite3_api->result_text
#define sqlite3_snprintf sqlite3_api->xsnprintf
#define sqlite3_step sqlite3_api->step
#define sqlite3_stmt_readonly sqlite3_api->stmt_readonly
#define sqlite3_str_appendall sqlite3_api->str_appendall
#define sqlite3_str_appendchar sqlite3_api->str_appendchar
#define sqlite3_str_appendf sqlite3_api->str_appendf
#define sqlite3_str_finish sqlite3_api->str_finish
#define sqlite3_str_length sqlite3_api->str_length
#define sqlite3_str_new sqlite3_api->str_new
#define sqlite3_value_bytes sqlite3_api->value_bytes
#define sqlite3_value_text sqlite3_api->value_text
#define sqlite3_value_type sqlite3_api->value_type

#define SQLITE_EXTENSION_INIT1 const sqlite3_api_routines *sqlite3_api = 0;
#define SQLITE_EXTENSION_INIT2(value) sqlite3_api = value;
#endif

#endif
