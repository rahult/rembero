#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "sqlite-extension.h"
SQLITE_EXTENSION_INIT1

#define MAX_TERMS 16
#define MAX_LITERALS 16
#define MAX_COMPARISONS 16
#define MAX_BINDINGS 64
#define MAX_CONDITIONS 288
#define MAX_QUERY_ROWS 10000
#define MAX_RULE_BYTES 65536
#define MAX_RESULT_BYTES (16 * 1024 * 1024)

typedef enum { TERM_VARIABLE, TERM_TEXT, TERM_NUMBER } TermKind;

typedef struct {
  TermKind kind;
  char *text;
} Term;

typedef struct {
  char *predicate;
  Term terms[MAX_TERMS];
  int term_count;
} Literal;

typedef struct {
  Term left;
  Term right;
  char operator_text[3];
} Comparison;

typedef struct {
  Literal head;
  Literal body[MAX_LITERALS];
  int body_count;
  Comparison comparisons[MAX_COMPARISONS];
  int comparison_count;
} Rule;

typedef struct {
  const char *cursor;
  char error[256];
} Parser;

typedef struct {
  char **columns;
  int column_count;
} TableSchema;

typedef struct {
  char *name;
  char *expression;
} Binding;

static void set_error(Parser *parser, const char *message) {
  if (parser->error[0] == '\0') {
    sqlite3_snprintf((int)sizeof(parser->error), parser->error, "%s near '%.32s'", message,
                     parser->cursor);
  }
}

static void skip_space(Parser *parser) {
  while (isspace((unsigned char)*parser->cursor)) parser->cursor++;
}

static int is_name_start(char value) {
  return isalpha((unsigned char)value) || value == '_';
}

static int is_name_char(char value) {
  return isalnum((unsigned char)value) || value == '_';
}

static char *parse_name(Parser *parser) {
  const char *start;
  skip_space(parser);
  if (!is_name_start(*parser->cursor)) {
    set_error(parser, "expected a name");
    return NULL;
  }
  start = parser->cursor++;
  while (is_name_char(*parser->cursor)) parser->cursor++;
  return sqlite3_mprintf("%.*s", (int)(parser->cursor - start), start);
}

static int consume(Parser *parser, const char *token) {
  size_t length = strlen(token);
  skip_space(parser);
  if (strncmp(parser->cursor, token, length) != 0) return 0;
  parser->cursor += length;
  return 1;
}

static char *parse_quoted_text(Parser *parser) {
  sqlite3_str *output;
  char *result;
  skip_space(parser);
  if (*parser->cursor != '\'') return NULL;
  parser->cursor++;
  output = sqlite3_str_new(NULL);
  if (output == NULL) {
    set_error(parser, "out of memory");
    return NULL;
  }
  while (*parser->cursor != '\0') {
    if (*parser->cursor == '\'') {
      if (parser->cursor[1] == '\'') {
        sqlite3_str_appendchar(output, 1, '\'');
        parser->cursor += 2;
        continue;
      }
      parser->cursor++;
      result = sqlite3_str_finish(output);
      if (result == NULL) set_error(parser, "out of memory");
      return result;
    }
    sqlite3_str_appendchar(output, 1, *parser->cursor++);
  }
  sqlite3_str_finish(output);
  set_error(parser, "unterminated quoted string");
  return NULL;
}

static int parse_term(Parser *parser, Term *term) {
  char *end;
  const char *start;
  char *name;
  skip_space(parser);
  memset(term, 0, sizeof(*term));

  if (*parser->cursor == '\'') {
    term->kind = TERM_TEXT;
    term->text = parse_quoted_text(parser);
    return term->text != NULL;
  }

  if (*parser->cursor == '-' || isdigit((unsigned char)*parser->cursor)) {
    double parsed_number;
    start = parser->cursor;
    errno = 0;
    parsed_number = strtod(start, &end);
    if (end == start) {
      set_error(parser, "expected a number");
      return 0;
    }
    if (errno == ERANGE || !isfinite(parsed_number)) {
      set_error(parser, "numeric literal is out of range");
      return 0;
    }
    if (is_name_char(*end)) {
      set_error(parser, "invalid number");
      return 0;
    }
    parser->cursor = end;
    term->kind = TERM_NUMBER;
    term->text = sqlite3_mprintf("%.*s", (int)(end - start), start);
    return term->text != NULL;
  }

  name = parse_name(parser);
  if (name == NULL) return 0;
  term->kind = (isupper((unsigned char)name[0]) || name[0] == '_') ? TERM_VARIABLE : TERM_TEXT;
  term->text = name;
  return 1;
}

static int parse_literal(Parser *parser, Literal *literal) {
  memset(literal, 0, sizeof(*literal));
  literal->predicate = parse_name(parser);
  if (literal->predicate == NULL) return 0;
  if (!islower((unsigned char)literal->predicate[0]) && literal->predicate[0] != '_') {
    set_error(parser, "predicate names must start with a lowercase letter");
    return 0;
  }
  if (!consume(parser, "(")) {
    set_error(parser, "expected '('");
    return 0;
  }
  if (consume(parser, ")")) return 1;
  for (;;) {
    if (literal->term_count >= MAX_TERMS) {
      set_error(parser, "too many literal terms");
      return 0;
    }
    if (!parse_term(parser, &literal->terms[literal->term_count++])) return 0;
    if (consume(parser, ")")) return 1;
    if (!consume(parser, ",")) {
      set_error(parser, "expected ',' or ')'");
      return 0;
    }
  }
}

static int looks_like_literal(Parser *parser) {
  const char *cursor = parser->cursor;
  while (isspace((unsigned char)*cursor)) cursor++;
  if (!islower((unsigned char)*cursor) && *cursor != '_') return 0;
  cursor++;
  while (is_name_char(*cursor)) cursor++;
  while (isspace((unsigned char)*cursor)) cursor++;
  return *cursor == '(';
}

static int parse_operator(Parser *parser, char output[3]) {
  static const char *operators[] = {"!=", "<=", ">=", "=", "<", ">"};
  int index;
  for (index = 0; index < 6; index++) {
    if (consume(parser, operators[index])) {
      sqlite3_snprintf(3, output, "%s", operators[index]);
      return 1;
    }
  }
  set_error(parser, "expected a comparison operator");
  return 0;
}

static int parse_comparison(Parser *parser, Comparison *comparison) {
  memset(comparison, 0, sizeof(*comparison));
  return parse_term(parser, &comparison->left) &&
         parse_operator(parser, comparison->operator_text) &&
         parse_term(parser, &comparison->right);
}

static void free_term(Term *term) {
  sqlite3_free(term->text);
  term->text = NULL;
}

static void free_literal(Literal *literal) {
  int index;
  sqlite3_free(literal->predicate);
  literal->predicate = NULL;
  for (index = 0; index < literal->term_count; index++) free_term(&literal->terms[index]);
}

static void free_rule(Rule *rule) {
  int index;
  free_literal(&rule->head);
  for (index = 0; index < rule->body_count; index++) free_literal(&rule->body[index]);
  for (index = 0; index < rule->comparison_count; index++) {
    free_term(&rule->comparisons[index].left);
    free_term(&rule->comparisons[index].right);
  }
}

static int parse_rule(const char *text, Rule *rule, char **error) {
  Parser parser;
  memset(rule, 0, sizeof(*rule));
  parser.cursor = text;
  parser.error[0] = '\0';

  if (!parse_literal(&parser, &rule->head)) goto failed;
  if (!consume(&parser, ":-")) {
    set_error(&parser, "expected ':-'");
    goto failed;
  }

  for (;;) {
    if (looks_like_literal(&parser)) {
      if (rule->body_count >= MAX_LITERALS) {
        set_error(&parser, "too many body literals");
        goto failed;
      }
      if (!parse_literal(&parser, &rule->body[rule->body_count++])) goto failed;
    } else {
      if (rule->comparison_count >= MAX_COMPARISONS) {
        set_error(&parser, "too many comparisons");
        goto failed;
      }
      if (!parse_comparison(&parser, &rule->comparisons[rule->comparison_count++])) goto failed;
    }

    skip_space(&parser);
    if (*parser.cursor == ',') {
      parser.cursor++;
      continue;
    }
    break;
  }

  if (rule->body_count == 0) {
    set_error(&parser, "a rule needs at least one relational body literal");
    goto failed;
  }
  (void)consume(&parser, ".");
  skip_space(&parser);
  if (*parser.cursor != '\0') {
    set_error(&parser, "unexpected input");
    goto failed;
  }
  return 1;

failed:
  *error = sqlite3_mprintf("%s", parser.error[0] == '\0' ? "invalid Datalog rule" : parser.error);
  free_rule(rule);
  return 0;
}

static void free_schema(TableSchema *schema) {
  int index;
  if (schema->columns != NULL) {
    for (index = 0; index < schema->column_count; index++) sqlite3_free(schema->columns[index]);
  }
  sqlite3_free(schema->columns);
  schema->columns = NULL;
  schema->column_count = 0;
}

static int load_schema(sqlite3 *database, const Literal *literal, TableSchema *schema,
                       char **error) {
  char *sql = sqlite3_mprintf("SELECT * FROM \"%w\" LIMIT 0", literal->predicate);
  sqlite3_stmt *statement = NULL;
  int result;
  int index;
  memset(schema, 0, sizeof(*schema));
  if (sql == NULL) return SQLITE_NOMEM;
  result = sqlite3_prepare_v2(database, sql, -1, &statement, NULL);
  sqlite3_free(sql);
  if (result != SQLITE_OK) {
    *error = sqlite3_mprintf("predicate '%q' is unavailable: %s", literal->predicate,
                             sqlite3_errmsg(database));
    return result;
  }
  schema->column_count = sqlite3_column_count(statement);
  if (schema->column_count != literal->term_count) {
    *error = sqlite3_mprintf("predicate '%q' expects %d columns but the rule supplies %d",
                             literal->predicate, schema->column_count, literal->term_count);
    sqlite3_finalize(statement);
    return SQLITE_ERROR;
  }
  if (schema->column_count > 0) {
    schema->columns = sqlite3_malloc64(sizeof(char *) * (sqlite3_uint64)schema->column_count);
    if (schema->columns == NULL) {
      sqlite3_finalize(statement);
      return SQLITE_NOMEM;
    }
    memset(schema->columns, 0, sizeof(char *) * (size_t)schema->column_count);
  }
  for (index = 0; index < schema->column_count; index++) {
    schema->columns[index] = sqlite3_mprintf("%s", sqlite3_column_name(statement, index));
    if (schema->columns[index] == NULL) {
      sqlite3_finalize(statement);
      free_schema(schema);
      return SQLITE_NOMEM;
    }
  }
  sqlite3_finalize(statement);
  return SQLITE_OK;
}

static int find_binding(Binding *bindings, int binding_count, const char *name) {
  int index;
  for (index = 0; index < binding_count; index++) {
    if (strcmp(bindings[index].name, name) == 0) return index;
  }
  return -1;
}

static char *term_sql(const Term *term) {
  if (term->kind == TERM_TEXT) return sqlite3_mprintf("%Q", term->text);
  if (term->kind == TERM_NUMBER) return sqlite3_mprintf("%s", term->text);
  return NULL;
}

static int add_condition(char **conditions, int *condition_count, char *condition) {
  if (condition == NULL) return SQLITE_NOMEM;
  if (*condition_count >= MAX_CONDITIONS) {
    sqlite3_free(condition);
    return SQLITE_TOOBIG;
  }
  conditions[(*condition_count)++] = condition;
  return SQLITE_OK;
}

static char *resolved_term_sql(const Term *term, Binding *bindings, int binding_count,
                               char **error) {
  int binding_index;
  if (term->kind != TERM_VARIABLE) return term_sql(term);
  if (strcmp(term->text, "_") == 0) {
    *error = sqlite3_mprintf("wildcard '_' cannot be used in a comparison");
    return NULL;
  }
  binding_index = find_binding(bindings, binding_count, term->text);
  if (binding_index < 0) {
    *error = sqlite3_mprintf("variable '%q' is unbound", term->text);
    return NULL;
  }
  return sqlite3_mprintf("%s", bindings[binding_index].expression);
}

static int compile_rule(sqlite3 *database, const Rule *rule, char **compiled_sql,
                        char **error) {
  TableSchema schemas[MAX_LITERALS];
  Binding bindings[MAX_BINDINGS];
  char *conditions[MAX_CONDITIONS];
  int binding_count = 0;
  int condition_count = 0;
  int result = SQLITE_OK;
  int literal_index;
  int term_index;
  int comparison_index;
  sqlite3_str *sql = NULL;

  memset(schemas, 0, sizeof(schemas));
  memset(bindings, 0, sizeof(bindings));
  memset(conditions, 0, sizeof(conditions));

  if (rule->head.term_count == 0) {
    *error = sqlite3_mprintf("rule head must contain at least one named variable");
    return SQLITE_ERROR;
  }

  for (literal_index = 0; literal_index < rule->body_count; literal_index++) {
    const Literal *literal = &rule->body[literal_index];
    if (strcmp(literal->predicate, rule->head.predicate) == 0) {
      *error = sqlite3_mprintf("recursive predicate '%q' is not supported in V0",
                               literal->predicate);
      result = SQLITE_ERROR;
      goto cleanup;
    }
    result = load_schema(database, literal, &schemas[literal_index], error);
    if (result != SQLITE_OK) goto cleanup;

    for (term_index = 0; term_index < literal->term_count; term_index++) {
      const Term *term = &literal->terms[term_index];
      char *expression = sqlite3_mprintf("t%d.\"%w\"", literal_index,
                                         schemas[literal_index].columns[term_index]);
      if (expression == NULL) {
        result = SQLITE_NOMEM;
        goto cleanup;
      }
      if (term->kind == TERM_VARIABLE) {
        int existing;
        if (strcmp(term->text, "_") == 0) {
          sqlite3_free(expression);
          continue;
        }
        existing = find_binding(bindings, binding_count, term->text);
        if (existing >= 0) {
          result = add_condition(conditions, &condition_count,
                                 sqlite3_mprintf("%s = %s", expression,
                                                 bindings[existing].expression));
          sqlite3_free(expression);
          if (result != SQLITE_OK) goto cleanup;
        } else {
          if (binding_count >= MAX_BINDINGS) {
            sqlite3_free(expression);
            result = SQLITE_TOOBIG;
            goto cleanup;
          }
          bindings[binding_count].name = sqlite3_mprintf("%s", term->text);
          bindings[binding_count].expression = expression;
          if (bindings[binding_count].name == NULL) {
            result = SQLITE_NOMEM;
            goto cleanup;
          }
          binding_count++;
        }
      } else {
        char *constant = term_sql(term);
        result = add_condition(conditions, &condition_count,
                               constant == NULL ? NULL
                                                : sqlite3_mprintf("%s = %s", expression, constant));
        sqlite3_free(expression);
        sqlite3_free(constant);
        if (result != SQLITE_OK) goto cleanup;
      }
    }
  }

  for (comparison_index = 0; comparison_index < rule->comparison_count; comparison_index++) {
    const Comparison *comparison = &rule->comparisons[comparison_index];
    char *left = resolved_term_sql(&comparison->left, bindings, binding_count, error);
    char *right;
    if (left == NULL) {
      result = SQLITE_ERROR;
      goto cleanup;
    }
    right = resolved_term_sql(&comparison->right, bindings, binding_count, error);
    if (right == NULL) {
      sqlite3_free(left);
      result = SQLITE_ERROR;
      goto cleanup;
    }
    result = add_condition(conditions, &condition_count,
                           sqlite3_mprintf("%s %s %s", left, comparison->operator_text, right));
    sqlite3_free(left);
    sqlite3_free(right);
    if (result != SQLITE_OK) goto cleanup;
  }

  sql = sqlite3_str_new(database);
  if (sql == NULL) {
    result = SQLITE_NOMEM;
    goto cleanup;
  }
  sqlite3_str_appendall(sql, "SELECT DISTINCT ");
  for (term_index = 0; term_index < rule->head.term_count; term_index++) {
    const Term *term = &rule->head.terms[term_index];
    int binding_index;
    int earlier;
    if (term->kind != TERM_VARIABLE || strcmp(term->text, "_") == 0) {
      *error = sqlite3_mprintf("head terms must be named variables");
      result = SQLITE_ERROR;
      goto cleanup;
    }
    binding_index = find_binding(bindings, binding_count, term->text);
    if (binding_index < 0) {
      *error = sqlite3_mprintf("head variable '%q' is unbound", term->text);
      result = SQLITE_ERROR;
      goto cleanup;
    }
    for (earlier = 0; earlier < term_index; earlier++) {
      if (strcmp(rule->head.terms[earlier].text, term->text) == 0) {
        *error = sqlite3_mprintf("head variable '%q' is repeated", term->text);
        result = SQLITE_ERROR;
        goto cleanup;
      }
    }
    if (term_index > 0) sqlite3_str_appendall(sql, ", ");
    sqlite3_str_appendf(sql, "%s AS \"%w\"", bindings[binding_index].expression, term->text);
  }
  sqlite3_str_appendall(sql, " FROM ");
  for (literal_index = 0; literal_index < rule->body_count; literal_index++) {
    if (literal_index > 0) sqlite3_str_appendall(sql, ", ");
    sqlite3_str_appendf(sql, "\"%w\" AS t%d", rule->body[literal_index].predicate,
                        literal_index);
  }
  if (condition_count > 0) {
    sqlite3_str_appendall(sql, " WHERE ");
    for (term_index = 0; term_index < condition_count; term_index++) {
      if (term_index > 0) sqlite3_str_appendall(sql, " AND ");
      sqlite3_str_appendall(sql, conditions[term_index]);
    }
  }
  *compiled_sql = sqlite3_str_finish(sql);
  sql = NULL;
  if (*compiled_sql == NULL) result = SQLITE_NOMEM;

cleanup:
  if (sql != NULL) sqlite3_str_finish(sql);
  for (literal_index = 0; literal_index < rule->body_count; literal_index++) {
    free_schema(&schemas[literal_index]);
  }
  for (literal_index = 0; literal_index < binding_count; literal_index++) {
    sqlite3_free(bindings[literal_index].name);
    sqlite3_free(bindings[literal_index].expression);
  }
  for (literal_index = 0; literal_index < condition_count; literal_index++) {
    sqlite3_free(conditions[literal_index]);
  }
  if (result == SQLITE_NOMEM && *error == NULL) *error = sqlite3_mprintf("out of memory");
  if (result == SQLITE_TOOBIG && *error == NULL) *error = sqlite3_mprintf("rule is too complex");
  return result;
}

static int parse_and_compile(sqlite3_context *context, sqlite3_value *value, char **sql) {
  Rule rule;
  char *error = NULL;
  const char *text;
  int result;
  if (sqlite3_value_type(value) == SQLITE_NULL) {
    sqlite3_result_error(context, "Datalog rule must not be NULL", -1);
    return SQLITE_ERROR;
  }
  if (sqlite3_value_bytes(value) > MAX_RULE_BYTES) {
    sqlite3_result_error(context, "Datalog rule exceeds 64 KiB", -1);
    return SQLITE_TOOBIG;
  }
  text = (const char *)sqlite3_value_text(value);
  if (text == NULL) {
    sqlite3_result_error_nomem(context);
    return SQLITE_NOMEM;
  }
  if (memchr(text, '\0', (size_t)sqlite3_value_bytes(value)) != NULL) {
    sqlite3_result_error(context, "Datalog rule contains a NUL byte", -1);
    return SQLITE_ERROR;
  }
  if (!parse_rule(text, &rule, &error)) {
    sqlite3_result_error(context, error, -1);
    sqlite3_free(error);
    return SQLITE_ERROR;
  }
  result = compile_rule(sqlite3_context_db_handle(context), &rule, sql, &error);
  free_rule(&rule);
  if (result != SQLITE_OK) {
    sqlite3_result_error(context, error == NULL ? "failed to compile Datalog rule" : error, -1);
    sqlite3_free(error);
  }
  return result;
}

static void datalog_sql_function(sqlite3_context *context, int argument_count,
                                 sqlite3_value **arguments) {
  char *sql = NULL;
  (void)argument_count;
  if (parse_and_compile(context, arguments[0], &sql) != SQLITE_OK) return;
  sqlite3_result_text(context, sql, -1, sqlite3_free);
}

static int json_has_space(sqlite3_str *json, sqlite3_int64 additional_bytes) {
  int current = sqlite3_str_length(json);
  return additional_bytes >= 0 && current <= MAX_RESULT_BYTES &&
         additional_bytes <= (sqlite3_int64)MAX_RESULT_BYTES - current;
}

static int append_json_string(sqlite3_str *json, const unsigned char *text, int length) {
  int index;
  sqlite3_int64 encoded_length = 2;
  for (index = 0; index < length; index++) {
    unsigned char value = text[index];
    if (value == '"' || value == '\\' || value == '\b' || value == '\f' || value == '\n' ||
        value == '\r' || value == '\t') {
      encoded_length += 2;
    } else if (value < 0x20) {
      encoded_length += 6;
    } else {
      encoded_length++;
    }
  }
  if (!json_has_space(json, encoded_length)) return 0;
  sqlite3_str_appendchar(json, 1, '"');
  for (index = 0; index < length; index++) {
    unsigned char value = text[index];
    switch (value) {
      case '"': sqlite3_str_appendall(json, "\\\""); break;
      case '\\': sqlite3_str_appendall(json, "\\\\"); break;
      case '\b': sqlite3_str_appendall(json, "\\b"); break;
      case '\f': sqlite3_str_appendall(json, "\\f"); break;
      case '\n': sqlite3_str_appendall(json, "\\n"); break;
      case '\r': sqlite3_str_appendall(json, "\\r"); break;
      case '\t': sqlite3_str_appendall(json, "\\t"); break;
      default:
        if (value < 0x20) {
          sqlite3_str_appendf(json, "\\u%04x", value);
        } else {
          sqlite3_str_appendchar(json, 1, (char)value);
        }
    }
  }
  sqlite3_str_appendchar(json, 1, '"');
  return 1;
}

static int append_json_value(sqlite3_str *json, sqlite3_stmt *statement, int column) {
  int type = sqlite3_column_type(statement, column);
  if (type == SQLITE_NULL) {
    if (!json_has_space(json, 4)) return 0;
    sqlite3_str_appendall(json, "null");
  } else if (type == SQLITE_INTEGER) {
    if (!json_has_space(json, 32)) return 0;
    sqlite3_str_appendf(json, "%lld", sqlite3_column_int64(statement, column));
  } else if (type == SQLITE_FLOAT) {
    if (!json_has_space(json, 32)) return 0;
    sqlite3_str_appendf(json, "%!.17g", sqlite3_column_double(statement, column));
  } else if (type == SQLITE_BLOB) {
    const unsigned char *blob = sqlite3_column_blob(statement, column);
    int bytes = sqlite3_column_bytes(statement, column);
    int index;
    if (!json_has_space(json, (sqlite3_int64)bytes * 2 + 2)) return 0;
    sqlite3_str_appendchar(json, 1, '"');
    for (index = 0; index < bytes; index++) sqlite3_str_appendf(json, "%02x", blob[index]);
    sqlite3_str_appendchar(json, 1, '"');
  } else {
    return append_json_string(json, sqlite3_column_text(statement, column),
                              sqlite3_column_bytes(statement, column));
  }
  return 1;
}

#include "recursive.c"

static void datalog_query_function(sqlite3_context *context, int argument_count,
                                   sqlite3_value **arguments) {
  sqlite3 *database = sqlite3_context_db_handle(context);
  sqlite3_stmt *statement = NULL;
  sqlite3_str *json = NULL;
  char *sql = NULL;
  char *result_text;
  int result;
  int rows = 0;
  int column_count;
  int column;
  (void)argument_count;

  if (recursive_input_requires_fixpoint(arguments[0])) {
    recursive_result_function(context, arguments[0], 0);
    return;
  }

  if (parse_and_compile(context, arguments[0], &sql) != SQLITE_OK) return;
  result = sqlite3_prepare_v2(database, sql, -1, &statement, NULL);
  sqlite3_free(sql);
  if (result != SQLITE_OK) {
    sqlite3_result_error(context, sqlite3_errmsg(database), -1);
    return;
  }
  if (!sqlite3_stmt_readonly(statement)) {
    sqlite3_finalize(statement);
    sqlite3_result_error(context, "compiled Datalog must be read-only", -1);
    return;
  }

  column_count = sqlite3_column_count(statement);
  json = sqlite3_str_new(database);
  if (json == NULL) {
    sqlite3_finalize(statement);
    sqlite3_result_error_nomem(context);
    return;
  }
  sqlite3_str_appendchar(json, 1, '[');
  while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
    if (rows >= MAX_QUERY_ROWS) {
      sqlite3_finalize(statement);
      sqlite3_str_finish(json);
      sqlite3_result_error(context, "Datalog query exceeded 10000 rows", -1);
      return;
    }
    if (!json_has_space(json, rows > 0 ? 2 : 1)) {
      result = SQLITE_TOOBIG;
      break;
    }
    if (rows++ > 0) sqlite3_str_appendchar(json, 1, ',');
    sqlite3_str_appendchar(json, 1, '{');
    for (column = 0; column < column_count; column++) {
      const char *name = sqlite3_column_name(statement, column);
      if (column > 0) {
        if (!json_has_space(json, 1)) {
          result = SQLITE_TOOBIG;
          break;
        }
        sqlite3_str_appendchar(json, 1, ',');
      }
      if (!append_json_string(json, (const unsigned char *)name, (int)strlen(name)) ||
          !json_has_space(json, 1)) {
        result = SQLITE_TOOBIG;
        break;
      }
      sqlite3_str_appendchar(json, 1, ':');
      if (!append_json_value(json, statement, column)) {
        result = SQLITE_TOOBIG;
        break;
      }
    }
    if (result == SQLITE_TOOBIG) break;
    if (!json_has_space(json, 1)) {
      result = SQLITE_TOOBIG;
      break;
    }
    sqlite3_str_appendchar(json, 1, '}');
  }
  if (result == SQLITE_TOOBIG) {
    sqlite3_finalize(statement);
    sqlite3_str_finish(json);
    sqlite3_result_error(context, "Datalog result exceeded 16 MiB", -1);
    return;
  }
  if (result != SQLITE_DONE) {
    char *message = sqlite3_mprintf("%s", sqlite3_errmsg(database));
    sqlite3_finalize(statement);
    sqlite3_str_finish(json);
    if (message == NULL) {
      sqlite3_result_error_nomem(context);
    } else {
      sqlite3_result_error(context, message, -1);
      sqlite3_free(message);
    }
    return;
  }
  sqlite3_finalize(statement);
  if (!json_has_space(json, 1)) {
    sqlite3_str_finish(json);
    sqlite3_result_error(context, "Datalog result exceeded 16 MiB", -1);
    return;
  }
  sqlite3_str_appendchar(json, 1, ']');
  result_text = sqlite3_str_finish(json);
  if (result_text == NULL) {
    sqlite3_result_error_nomem(context);
    return;
  }
  sqlite3_result_text(context, result_text, -1, sqlite3_free);
}

static void datalog_explain_function(sqlite3_context *context, int argument_count,
                                     sqlite3_value **arguments) {
  (void)argument_count;
  recursive_result_function(context, arguments[0], 1);
}

#if defined(_WIN32)
__declspec(dllexport)
#endif
int sqlite3_rembero_init(sqlite3 *database, char **error,
                         const sqlite3_api_routines *api) {
  int result;
  SQLITE_EXTENSION_INIT2(api);
  result = sqlite3_create_function_v2(database, "datalog_sql", 1,
                                      SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL,
                                      datalog_sql_function, NULL, NULL, NULL);
  if (result == SQLITE_OK) {
    result = sqlite3_create_function_v2(database, "datalog_query", 1,
                                        SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL,
                                        datalog_query_function, NULL, NULL, NULL);
  }
  if (result == SQLITE_OK) {
    result = sqlite3_create_function_v2(database, "datalog_explain", 1,
                                        SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL,
                                        datalog_explain_function, NULL, NULL, NULL);
  }
  if (result != SQLITE_OK && error != NULL) {
    *error = sqlite3_mprintf("failed to register rembero SQLite functions: %s",
                             sqlite3_errmsg(database));
  }
  return result;
}

#if defined(_WIN32)
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *database, char **error,
                           const sqlite3_api_routines *api) {
  return sqlite3_rembero_init(database, error, api);
}
