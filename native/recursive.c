/* Included by rembero.c after the parser and JSON helpers. */

#define MAX_PROGRAM_RULES 16
#define MAX_BASE_RELATIONS 32
#define MAX_BASE_ROWS 100000
#define MAX_FIXPOINT_ITERATIONS 1000
#define MAX_PROOF_DEPTH 128
#define MAX_EVALUATION_STEPS 10000000

#define RECURSIVE_AFFINITY_NONE 0
#define RECURSIVE_AFFINITY_TEXT 1
#define RECURSIVE_AFFINITY_NUMERIC 2

typedef struct {
  Rule rules[MAX_PROGRAM_RULES];
  int count;
} RecursiveProgram;

typedef struct {
  int type;
  sqlite3_int64 integer;
  double real;
  unsigned char *bytes;
  int length;
  int affinity;
} RecursiveValue;

typedef struct {
  RecursiveValue values[MAX_TERMS];
  int count;
} RecursiveTuple;

typedef struct {
  int recursive;
  int relation_index;
  int tuple_index;
} RecursiveInput;

typedef struct {
  RecursiveTuple tuple;
  int rule_index;
  RecursiveInput inputs[MAX_LITERALS];
  int input_count;
} RecursiveFact;

typedef struct {
  char *predicate;
  int arity;
  RecursiveTuple *tuples;
  int count;
  int capacity;
} RecursiveBaseRelation;

typedef struct {
  const char *name;
  const RecursiveValue *value;
} RecursiveBinding;

typedef struct {
  sqlite3 *database;
  RecursiveProgram *program;
  RecursiveBaseRelation bases[MAX_BASE_RELATIONS];
  int base_count;
  int total_base_rows;
  RecursiveFact *facts;
  int fact_count;
  int visible_fact_count;
  int *delta;
  int delta_count;
  RecursiveBinding bindings[MAX_BINDINGS];
  int binding_count;
  RecursiveInput inputs[MAX_LITERALS];
  int selected_delta_literal;
  int active_rule_index;
  sqlite3_int64 steps;
  sqlite3_stmt *comparators[6][3][3];
  char *error;
} RecursiveEvaluation;

static void recursive_set_error(RecursiveEvaluation *evaluation, const char *format,
                                const char *detail) {
  if (evaluation->error == NULL) {
    evaluation->error = sqlite3_mprintf(format, detail);
  }
}

static void recursive_value_clear(RecursiveValue *value) {
  sqlite3_free(value->bytes);
  memset(value, 0, sizeof(*value));
}

static int recursive_value_clone(RecursiveValue *target, const RecursiveValue *source) {
  memset(target, 0, sizeof(*target));
  target->type = source->type;
  target->integer = source->integer;
  target->real = source->real;
  target->length = source->length;
  target->affinity = source->affinity;
  if ((source->type == SQLITE_TEXT || source->type == SQLITE_BLOB) && source->length > 0) {
    target->bytes = sqlite3_malloc64((sqlite3_uint64)source->length);
    if (target->bytes == NULL) return 0;
    memcpy(target->bytes, source->bytes, (size_t)source->length);
  }
  return 1;
}

static int recursive_value_from_column(RecursiveValue *value, sqlite3_stmt *statement,
                                       int column, int affinity) {
  int type = sqlite3_column_type(statement, column);
  memset(value, 0, sizeof(*value));
  value->type = type;
  value->affinity = affinity;
  if (type == SQLITE_INTEGER) {
    value->integer = sqlite3_column_int64(statement, column);
  } else if (type == SQLITE_FLOAT) {
    value->real = sqlite3_column_double(statement, column);
  } else if (type == SQLITE_TEXT || type == SQLITE_BLOB) {
    const void *source = type == SQLITE_TEXT ? (const void *)sqlite3_column_text(statement, column)
                                             : sqlite3_column_blob(statement, column);
    value->length = sqlite3_column_bytes(statement, column);
    if (value->length > 0) {
      if (source == NULL) return 0;
      value->bytes = sqlite3_malloc64((sqlite3_uint64)value->length);
      if (value->bytes == NULL) return 0;
      memcpy(value->bytes, source, (size_t)value->length);
    }
  }
  return 1;
}

static void recursive_tuple_clear(RecursiveTuple *tuple) {
  int index;
  for (index = 0; index < tuple->count; index++) recursive_value_clear(&tuple->values[index]);
  memset(tuple, 0, sizeof(*tuple));
}

static int recursive_numeric(const RecursiveValue *value) {
  return value->type == SQLITE_INTEGER || value->type == SQLITE_FLOAT;
}

static double recursive_number(const RecursiveValue *value) {
  return value->type == SQLITE_INTEGER ? (double)value->integer : value->real;
}

static int recursive_value_equal(const RecursiveValue *left, const RecursiveValue *right) {
  if (left->type == SQLITE_NULL || right->type == SQLITE_NULL) return 0;
  if (recursive_numeric(left) && recursive_numeric(right)) {
    if (left->type == SQLITE_INTEGER && right->type == SQLITE_INTEGER) {
      return left->integer == right->integer;
    }
    return recursive_number(left) == recursive_number(right);
  }
  if (left->type != right->type || left->length != right->length) return 0;
  if (left->type == SQLITE_TEXT || left->type == SQLITE_BLOB) {
    if (left->length == 0) return 1;
    return left->bytes != NULL && right->bytes != NULL &&
           memcmp(left->bytes, right->bytes, (size_t)left->length) == 0;
  }
  return 0;
}

static int recursive_value_same(const RecursiveValue *left, const RecursiveValue *right) {
  if (left->type == SQLITE_NULL || right->type == SQLITE_NULL) {
    return left->type == SQLITE_NULL && right->type == SQLITE_NULL;
  }
  return recursive_value_equal(left, right);
}

static int recursive_tuple_equal(const RecursiveTuple *left, const RecursiveTuple *right) {
  int index;
  if (left->count != right->count) return 0;
  for (index = 0; index < left->count; index++) {
    if (!recursive_value_same(&left->values[index], &right->values[index])) return 0;
  }
  return 1;
}

static int recursive_term_value(const Term *term, RecursiveValue *value) {
  char *end = NULL;
  memset(value, 0, sizeof(*value));
  if (term->kind == TERM_TEXT) {
    value->type = SQLITE_TEXT;
    value->bytes = (unsigned char *)term->text;
    value->length = (int)strlen(term->text);
    return 1;
  }
  if (term->kind != TERM_NUMBER) return 0;
  if (strchr(term->text, '.') != NULL || strchr(term->text, 'e') != NULL ||
      strchr(term->text, 'E') != NULL) {
    errno = 0;
    value->type = SQLITE_FLOAT;
    value->real = strtod(term->text, &end);
    if (errno == ERANGE || !isfinite(value->real)) return 0;
  } else {
    long long integer;
    errno = 0;
    integer = strtoll(term->text, &end, 10);
    if (errno == ERANGE) {
      errno = 0;
      value->type = SQLITE_FLOAT;
      value->real = strtod(term->text, &end);
      if (errno == ERANGE || !isfinite(value->real)) return 0;
    } else {
      value->type = SQLITE_INTEGER;
      value->integer = (sqlite3_int64)integer;
    }
  }
  return end != term->text && *end == '\0';
}

static void recursive_program_clear(RecursiveProgram *program) {
  int index;
  for (index = 0; index < program->count; index++) free_rule(&program->rules[index]);
  memset(program, 0, sizeof(*program));
}

static int recursive_nonspace(const char *start, const char *end) {
  while (start < end) {
    if (!isspace((unsigned char)*start)) return 1;
    start++;
  }
  return 0;
}

static int recursive_parse_program(const char *text, RecursiveProgram *program, char **error) {
  const char *clause_start = text;
  const char *cursor = text;
  int quoted = 0;
  memset(program, 0, sizeof(*program));

  for (;;) {
    char value = *cursor;
    if (value == '\'' && quoted && cursor[1] == '\'') {
      cursor += 2;
      continue;
    }
    if (value == '\'') quoted = !quoted;
    if (value == '\0' || (value == '.' && !quoted &&
                           !(cursor > clause_start && isdigit((unsigned char)cursor[-1]) &&
                             isdigit((unsigned char)cursor[1])))) {
      const char *clause_end = value == '.' ? cursor + 1 : cursor;
      if (recursive_nonspace(clause_start, clause_end)) {
        char *clause;
        if (program->count >= MAX_PROGRAM_RULES) {
          *error = sqlite3_mprintf("Datalog program exceeds %d rules", MAX_PROGRAM_RULES);
          recursive_program_clear(program);
          return 0;
        }
        clause = sqlite3_mprintf("%.*s", (int)(clause_end - clause_start), clause_start);
        if (clause == NULL) {
          *error = sqlite3_mprintf("out of memory");
          recursive_program_clear(program);
          return 0;
        }
        if (!parse_rule(clause, &program->rules[program->count], error)) {
          sqlite3_free(clause);
          recursive_program_clear(program);
          return 0;
        }
        sqlite3_free(clause);
        program->count++;
      }
      if (value == '\0') break;
      clause_start = cursor + 1;
    }
    cursor++;
  }

  if (quoted) {
    *error = sqlite3_mprintf("unterminated quoted string in Datalog program");
    recursive_program_clear(program);
    return 0;
  }
  if (program->count == 0) {
    *error = sqlite3_mprintf("expected a Datalog rule");
    return 0;
  }
  return 1;
}

static int recursive_rule_occurrences(const Rule *rule, const char *predicate) {
  int index;
  int count = 0;
  for (index = 0; index < rule->body_count; index++) {
    if (strcmp(rule->body[index].predicate, predicate) == 0) count++;
  }
  return count;
}

static int recursive_input_requires_fixpoint(sqlite3_value *value) {
  const char *text;
  RecursiveProgram program;
  char *error = NULL;
  int result = 0;
  if (sqlite3_value_type(value) == SQLITE_NULL || sqlite3_value_bytes(value) > MAX_RULE_BYTES) {
    return 0;
  }
  text = (const char *)sqlite3_value_text(value);
  if (text == NULL || !recursive_parse_program(text, &program, &error)) {
    sqlite3_free(error);
    return 0;
  }
  result = program.count > 1 ||
           recursive_rule_occurrences(&program.rules[0], program.rules[0].head.predicate) > 0;
  recursive_program_clear(&program);
  return result;
}

static int recursive_find_binding(RecursiveEvaluation *evaluation, const char *name) {
  int index;
  for (index = 0; index < evaluation->binding_count; index++) {
    if (strcmp(evaluation->bindings[index].name, name) == 0) return index;
  }
  return -1;
}

static int recursive_base_append(RecursiveEvaluation *evaluation,
                                 RecursiveBaseRelation *relation,
                                 RecursiveTuple *tuple) {
  RecursiveTuple *grown;
  int capacity;
  if (evaluation->total_base_rows >= MAX_BASE_ROWS) {
    recursive_set_error(evaluation, "base relations exceed %s rows", "100000");
    return 0;
  }
  if (relation->count == relation->capacity) {
    capacity = relation->capacity == 0 ? 16 : relation->capacity * 2;
    grown = sqlite3_realloc64(relation->tuples,
                              sizeof(RecursiveTuple) * (sqlite3_uint64)capacity);
    if (grown == NULL) {
      recursive_set_error(evaluation, "%s", "out of memory");
      return 0;
    }
    relation->tuples = grown;
    relation->capacity = capacity;
  }
  relation->tuples[relation->count] = *tuple;
  memset(tuple, 0, sizeof(*tuple));
  relation->count++;
  evaluation->total_base_rows++;
  return 1;
}

static int recursive_contains_type_word(const char *declared_type, const char *word) {
  size_t word_length = strlen(word);
  const char *cursor;
  if (declared_type == NULL) return 0;
  for (cursor = declared_type; *cursor != '\0'; cursor++) {
    size_t index;
    for (index = 0; index < word_length; index++) {
      if (cursor[index] == '\0' ||
          toupper((unsigned char)cursor[index]) != (unsigned char)word[index]) {
        break;
      }
    }
    if (index == word_length) return 1;
  }
  return 0;
}

static int recursive_column_affinity(const char *declared_type) {
  if (declared_type == NULL || *declared_type == '\0' ||
      recursive_contains_type_word(declared_type, "BLOB")) {
    return RECURSIVE_AFFINITY_NONE;
  }
  if (recursive_contains_type_word(declared_type, "CHAR") ||
      recursive_contains_type_word(declared_type, "CLOB") ||
      recursive_contains_type_word(declared_type, "TEXT")) {
    return RECURSIVE_AFFINITY_TEXT;
  }
  return RECURSIVE_AFFINITY_NUMERIC;
}

static int recursive_load_base(RecursiveEvaluation *evaluation, const Literal *literal) {
  RecursiveBaseRelation *relation;
  sqlite3_stmt *statement = NULL;
  char *sql;
  int result;
  int relation_index;
  int column;
  int affinities[MAX_TERMS] = {0};

  for (relation_index = 0; relation_index < evaluation->base_count; relation_index++) {
    relation = &evaluation->bases[relation_index];
    if (strcmp(relation->predicate, literal->predicate) == 0) {
      if (relation->arity != literal->term_count) {
        evaluation->error = sqlite3_mprintf("predicate '%q' has inconsistent arity",
                                             literal->predicate);
        return -1;
      }
      return relation_index;
    }
  }
  if (evaluation->base_count >= MAX_BASE_RELATIONS) {
    evaluation->error = sqlite3_mprintf("Datalog program references too many base predicates");
    return -1;
  }
  relation_index = evaluation->base_count++;
  relation = &evaluation->bases[relation_index];
  memset(relation, 0, sizeof(*relation));
  relation->predicate = sqlite3_mprintf("%s", literal->predicate);
  relation->arity = literal->term_count;
  if (relation->predicate == NULL) {
    recursive_set_error(evaluation, "%s", "out of memory");
    return -1;
  }

  sql = sqlite3_mprintf("SELECT * FROM \"%w\"", literal->predicate);
  if (sql == NULL) {
    recursive_set_error(evaluation, "%s", "out of memory");
    return -1;
  }
  result = sqlite3_prepare_v2(evaluation->database, sql, -1, &statement, NULL);
  sqlite3_free(sql);
  if (result != SQLITE_OK) {
    evaluation->error = sqlite3_mprintf("predicate '%q' is unavailable: %s",
                                         literal->predicate,
                                         sqlite3_errmsg(evaluation->database));
    return -1;
  }
  if (sqlite3_column_count(statement) != literal->term_count) {
    evaluation->error = sqlite3_mprintf("predicate '%q' expects %d columns but the rule supplies %d",
                                         literal->predicate, sqlite3_column_count(statement),
                                         literal->term_count);
    sqlite3_finalize(statement);
    return -1;
  }
  for (column = 0; column < literal->term_count; column++) {
    affinities[column] = recursive_column_affinity(sqlite3_column_decltype(statement, column));
  }
  while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
    RecursiveTuple tuple;
    memset(&tuple, 0, sizeof(tuple));
    tuple.count = literal->term_count;
    for (column = 0; column < tuple.count; column++) {
      if (!recursive_value_from_column(&tuple.values[column], statement, column,
                                       affinities[column])) {
        recursive_tuple_clear(&tuple);
        recursive_set_error(evaluation, "%s", "out of memory");
        sqlite3_finalize(statement);
        return -1;
      }
    }
    if (!recursive_base_append(evaluation, relation, &tuple)) {
      recursive_tuple_clear(&tuple);
      sqlite3_finalize(statement);
      return -1;
    }
  }
  if (result != SQLITE_DONE) {
    evaluation->error = sqlite3_mprintf("failed to read predicate '%q': %s",
                                         literal->predicate,
                                         sqlite3_errmsg(evaluation->database));
    sqlite3_finalize(statement);
    return -1;
  }
  sqlite3_finalize(statement);
  return relation_index;
}

static int recursive_operator_index(const char *operator_text) {
  static const char *operators[] = {"=", "!=", "<", ">", "<=", ">="};
  int index;
  for (index = 0; index < 6; index++) {
    if (strcmp(operator_text, operators[index]) == 0) return index;
  }
  return -1;
}

static int recursive_bind_value(sqlite3_stmt *statement, int parameter,
                                const RecursiveValue *value) {
  if (value->type == SQLITE_NULL) return sqlite3_bind_null(statement, parameter);
  if (value->type == SQLITE_INTEGER) {
    return sqlite3_bind_int64(statement, parameter, value->integer);
  }
  if (value->type == SQLITE_FLOAT) {
    return sqlite3_bind_double(statement, parameter, value->real);
  }
  if (value->type == SQLITE_BLOB) {
    return sqlite3_bind_blob(statement, parameter, value->bytes, value->length, SQLITE_STATIC);
  }
  return sqlite3_bind_text(statement, parameter, (const char *)value->bytes,
                           value->length, SQLITE_STATIC);
}

static int recursive_sqlite_compare(RecursiveEvaluation *evaluation,
                                    const RecursiveValue *left,
                                    const RecursiveValue *right,
                                    const char *operator_text) {
  static const char *operators[] = {"=", "!=", "<", ">", "<=", ">="};
  const char *left_expression = "?1";
  const char *right_expression = "?2";
  int operator_index = recursive_operator_index(operator_text);
  int left_affinity = left->affinity;
  int right_affinity = right->affinity;
  sqlite3_stmt *statement;
  int result;
  int answer;
  char *sql;

  if (operator_index < 0) {
    evaluation->error = sqlite3_mprintf("unsupported comparison operator '%q'", operator_text);
    return -1;
  }
  statement = evaluation->comparators[operator_index][left_affinity][right_affinity];
  if (statement == NULL) {
    if (left_affinity == RECURSIVE_AFFINITY_NUMERIC &&
        right_affinity != RECURSIVE_AFFINITY_NUMERIC) {
      right_expression = "CAST(?2 AS NUMERIC)";
    } else if (right_affinity == RECURSIVE_AFFINITY_NUMERIC &&
               left_affinity != RECURSIVE_AFFINITY_NUMERIC) {
      left_expression = "CAST(?1 AS NUMERIC)";
    } else if (left_affinity == RECURSIVE_AFFINITY_TEXT &&
               right_affinity == RECURSIVE_AFFINITY_NONE) {
      right_expression = "CAST(?2 AS TEXT)";
    } else if (right_affinity == RECURSIVE_AFFINITY_TEXT &&
               left_affinity == RECURSIVE_AFFINITY_NONE) {
      left_expression = "CAST(?1 AS TEXT)";
    }
    sql = sqlite3_mprintf("SELECT %s %s %s", left_expression,
                          operators[operator_index], right_expression);
    if (sql == NULL) {
      recursive_set_error(evaluation, "%s", "out of memory");
      return -1;
    }
    result = sqlite3_prepare_v2(evaluation->database, sql, -1, &statement, NULL);
    sqlite3_free(sql);
    if (result != SQLITE_OK) {
      evaluation->error = sqlite3_mprintf("failed to prepare comparison: %s",
                                           sqlite3_errmsg(evaluation->database));
      return -1;
    }
    evaluation->comparators[operator_index][left_affinity][right_affinity] = statement;
  }

  sqlite3_reset(statement);
  sqlite3_clear_bindings(statement);
  result = recursive_bind_value(statement, 1, left);
  if (result == SQLITE_OK) result = recursive_bind_value(statement, 2, right);
  if (result != SQLITE_OK) {
    evaluation->error = sqlite3_mprintf("failed to bind comparison: %s",
                                         sqlite3_errmsg(evaluation->database));
    return -1;
  }
  result = sqlite3_step(statement);
  if (result != SQLITE_ROW) {
    evaluation->error = sqlite3_mprintf("failed to evaluate comparison: %s",
                                         sqlite3_errmsg(evaluation->database));
    return -1;
  }
  answer = sqlite3_column_type(statement, 0) != SQLITE_NULL &&
           sqlite3_column_int(statement, 0) != 0;
  sqlite3_reset(statement);
  return answer;
}

static const RecursiveValue *recursive_resolve_term(RecursiveEvaluation *evaluation,
                                                    const Term *term,
                                                    RecursiveValue *constant) {
  int binding_index;
  if (term->kind != TERM_VARIABLE) {
    return recursive_term_value(term, constant) ? constant : NULL;
  }
  if (strcmp(term->text, "_") == 0) return NULL;
  binding_index = recursive_find_binding(evaluation, term->text);
  return binding_index < 0 ? NULL : evaluation->bindings[binding_index].value;
}

static int recursive_comparisons_hold(RecursiveEvaluation *evaluation, const Rule *rule) {
  int index;
  for (index = 0; index < rule->comparison_count; index++) {
    RecursiveValue left_constant;
    RecursiveValue right_constant;
    const RecursiveValue *left = recursive_resolve_term(
        evaluation, &rule->comparisons[index].left, &left_constant);
    const RecursiveValue *right = recursive_resolve_term(
        evaluation, &rule->comparisons[index].right, &right_constant);
    if (left == NULL || right == NULL) {
      evaluation->error = sqlite3_mprintf("comparison contains an unbound variable");
      return 0;
    }
    {
      int comparison = recursive_sqlite_compare(
          evaluation, left, right, rule->comparisons[index].operator_text);
      if (comparison < 0) return 0;
      if (comparison == 0) return 0;
    }
  }
  return 1;
}

static int recursive_find_fact(RecursiveEvaluation *evaluation, const RecursiveTuple *tuple) {
  int index;
  for (index = 0; index < evaluation->fact_count; index++) {
    if (++evaluation->steps > MAX_EVALUATION_STEPS) {
      evaluation->error = sqlite3_mprintf("Datalog evaluation exceeded 10000000 tuple checks");
      return -2;
    }
    if (recursive_tuple_equal(&evaluation->facts[index].tuple, tuple)) return index;
  }
  return -1;
}

static int recursive_emit(RecursiveEvaluation *evaluation, const Rule *rule) {
  RecursiveTuple tuple;
  RecursiveFact *fact;
  int existing;
  int index;
  memset(&tuple, 0, sizeof(tuple));
  tuple.count = rule->head.term_count;
  for (index = 0; index < rule->head.term_count; index++) {
    int binding_index;
    const Term *term = &rule->head.terms[index];
    if (term->kind != TERM_VARIABLE || strcmp(term->text, "_") == 0) {
      evaluation->error = sqlite3_mprintf("head terms must be named variables");
      return 0;
    }
    binding_index = recursive_find_binding(evaluation, term->text);
    if (binding_index < 0) {
      evaluation->error = sqlite3_mprintf("head variable '%q' is unbound", term->text);
      return 0;
    }
    if (!recursive_value_clone(&tuple.values[index], evaluation->bindings[binding_index].value)) {
      recursive_tuple_clear(&tuple);
      recursive_set_error(evaluation, "%s", "out of memory");
      return 0;
    }
  }
  existing = recursive_find_fact(evaluation, &tuple);
  if (existing == -2) {
    recursive_tuple_clear(&tuple);
    return 0;
  }
  if (existing >= 0) {
    recursive_tuple_clear(&tuple);
    return 1;
  }
  if (evaluation->fact_count >= MAX_QUERY_ROWS) {
    recursive_tuple_clear(&tuple);
    evaluation->error = sqlite3_mprintf("Datalog query exceeded 10000 derived rows");
    return 0;
  }
  fact = &evaluation->facts[evaluation->fact_count++];
  memset(fact, 0, sizeof(*fact));
  fact->tuple = tuple;
  fact->rule_index = evaluation->active_rule_index;
  fact->input_count = rule->body_count;
  memcpy(fact->inputs, evaluation->inputs,
         sizeof(RecursiveInput) * (size_t)rule->body_count);
  return 1;
}

static int recursive_unify_tuple(RecursiveEvaluation *evaluation, const Literal *literal,
                                 const RecursiveTuple *tuple) {
  int term_index;
  for (term_index = 0; term_index < literal->term_count; term_index++) {
    const Term *term = &literal->terms[term_index];
    const RecursiveValue *value = &tuple->values[term_index];
    if (term->kind == TERM_VARIABLE) {
      int binding_index;
      if (strcmp(term->text, "_") == 0) continue;
      binding_index = recursive_find_binding(evaluation, term->text);
      if (binding_index >= 0) {
        int comparison = recursive_sqlite_compare(
            evaluation, evaluation->bindings[binding_index].value, value, "=");
        if (comparison <= 0) return 0;
      } else {
        if (evaluation->binding_count >= MAX_BINDINGS) {
          evaluation->error = sqlite3_mprintf("rule contains too many variables");
          return 0;
        }
        evaluation->bindings[evaluation->binding_count].name = term->text;
        evaluation->bindings[evaluation->binding_count].value = value;
        evaluation->binding_count++;
      }
    } else {
      RecursiveValue constant;
      int comparison;
      if (!recursive_term_value(term, &constant)) return 0;
      comparison = recursive_sqlite_compare(evaluation, value, &constant, "=");
      if (comparison <= 0) {
        return 0;
      }
    }
  }
  return 1;
}

static int recursive_backtrack(RecursiveEvaluation *evaluation, const Rule *rule,
                               int literal_index) {
  const char *target = evaluation->program->rules[0].head.predicate;
  const Literal *literal;
  int saved_bindings;
  int row;
  if (literal_index == rule->body_count) {
    if (!recursive_comparisons_hold(evaluation, rule)) return evaluation->error == NULL;
    return recursive_emit(evaluation, rule);
  }
  literal = &rule->body[literal_index];
  if (strcmp(literal->predicate, target) == 0) {
    int row_count = literal_index == evaluation->selected_delta_literal
                        ? evaluation->delta_count
                        : evaluation->visible_fact_count;
    for (row = 0; row < row_count; row++) {
      int fact_index = literal_index == evaluation->selected_delta_literal
                           ? evaluation->delta[row]
                           : row;
      if (++evaluation->steps > MAX_EVALUATION_STEPS) {
        evaluation->error = sqlite3_mprintf("Datalog evaluation exceeded 10000000 tuple checks");
        return 0;
      }
      saved_bindings = evaluation->binding_count;
      if (recursive_unify_tuple(evaluation, literal,
                                &evaluation->facts[fact_index].tuple)) {
        evaluation->inputs[literal_index].recursive = 1;
        evaluation->inputs[literal_index].relation_index = -1;
        evaluation->inputs[literal_index].tuple_index = fact_index;
        if (!recursive_backtrack(evaluation, rule, literal_index + 1)) return 0;
      }
      evaluation->binding_count = saved_bindings;
      if (evaluation->error != NULL) return 0;
    }
  } else {
    int relation_index = recursive_load_base(evaluation, literal);
    RecursiveBaseRelation *relation;
    if (relation_index < 0) return 0;
    relation = &evaluation->bases[relation_index];
    for (row = 0; row < relation->count; row++) {
      if (++evaluation->steps > MAX_EVALUATION_STEPS) {
        evaluation->error = sqlite3_mprintf("Datalog evaluation exceeded 10000000 tuple checks");
        return 0;
      }
      saved_bindings = evaluation->binding_count;
      if (recursive_unify_tuple(evaluation, literal, &relation->tuples[row])) {
        evaluation->inputs[literal_index].recursive = 0;
        evaluation->inputs[literal_index].relation_index = relation_index;
        evaluation->inputs[literal_index].tuple_index = row;
        if (!recursive_backtrack(evaluation, rule, literal_index + 1)) return 0;
      }
      evaluation->binding_count = saved_bindings;
      if (evaluation->error != NULL) return 0;
    }
  }
  return 1;
}

static int recursive_evaluate_rule(RecursiveEvaluation *evaluation, int rule_index,
                                   int selected_delta_literal) {
  evaluation->binding_count = 0;
  evaluation->selected_delta_literal = selected_delta_literal;
  evaluation->active_rule_index = rule_index;
  memset(evaluation->inputs, 0, sizeof(evaluation->inputs));
  return recursive_backtrack(evaluation, &evaluation->program->rules[rule_index], 0);
}

static int recursive_validate_program(RecursiveProgram *program, char **error) {
  int rule_index;
  const Literal *head = &program->rules[0].head;
  if (head->term_count == 0) {
    *error = sqlite3_mprintf("rule head must contain at least one named variable");
    return 0;
  }
  for (rule_index = 0; rule_index < program->count; rule_index++) {
    Rule *rule = &program->rules[rule_index];
    int head_term;
    if (strcmp(rule->head.predicate, head->predicate) != 0) {
      *error = sqlite3_mprintf("all program rules must derive the same predicate");
      return 0;
    }
    if (rule->head.term_count != head->term_count) {
      *error = sqlite3_mprintf("all program rules must use the same head arity");
      return 0;
    }
    for (head_term = 0; head_term < rule->body_count; head_term++) {
      if (strcmp(rule->body[head_term].predicate, head->predicate) == 0 &&
          rule->body[head_term].term_count != head->term_count) {
        *error = sqlite3_mprintf("recursive predicate '%q' has inconsistent arity",
                                 head->predicate);
        return 0;
      }
    }
    for (head_term = 0; head_term < rule->head.term_count; head_term++) {
      const Term *term = &rule->head.terms[head_term];
      int body_index;
      int bound = 0;
      if (term->kind != TERM_VARIABLE || strcmp(term->text, "_") == 0) {
        *error = sqlite3_mprintf("head terms must be named variables");
        return 0;
      }
      for (body_index = 0; body_index < head_term; body_index++) {
        if (strcmp(rule->head.terms[body_index].text, term->text) == 0) {
          *error = sqlite3_mprintf("head variable '%q' is repeated", term->text);
          return 0;
        }
      }
      for (body_index = 0; body_index < rule->body_count && !bound; body_index++) {
        int term_index;
        for (term_index = 0; term_index < rule->body[body_index].term_count; term_index++) {
          Term *body_term = &rule->body[body_index].terms[term_index];
          if (body_term->kind == TERM_VARIABLE && strcmp(body_term->text, term->text) == 0) {
            bound = 1;
            break;
          }
        }
      }
      if (!bound) {
        *error = sqlite3_mprintf("head variable '%q' is unbound", term->text);
        return 0;
      }
    }
    for (head_term = 0; head_term < rule->comparison_count; head_term++) {
      const Comparison *comparison = &rule->comparisons[head_term];
      const Term *terms[2] = {&comparison->left, &comparison->right};
      int side;
      for (side = 0; side < 2; side++) {
        const Term *term = terms[side];
        int body_index;
        int bound = term->kind != TERM_VARIABLE;
        if (term->kind == TERM_VARIABLE && strcmp(term->text, "_") == 0) {
          *error = sqlite3_mprintf("wildcard '_' cannot be used in a comparison");
          return 0;
        }
        for (body_index = 0; body_index < rule->body_count && !bound; body_index++) {
          int term_index;
          for (term_index = 0; term_index < rule->body[body_index].term_count; term_index++) {
            const Term *body_term = &rule->body[body_index].terms[term_index];
            if (body_term->kind == TERM_VARIABLE &&
                strcmp(body_term->text, term->text) == 0) {
              bound = 1;
              break;
            }
          }
        }
        if (!bound) {
          *error = sqlite3_mprintf("comparison variable '%q' is unbound", term->text);
          return 0;
        }
      }
    }
  }
  return 1;
}

static void recursive_evaluation_clear(RecursiveEvaluation *evaluation) {
  int relation_index;
  int tuple_index;
  int operator_index;
  int left_affinity;
  int right_affinity;
  for (tuple_index = 0; tuple_index < evaluation->fact_count; tuple_index++) {
    recursive_tuple_clear(&evaluation->facts[tuple_index].tuple);
  }
  sqlite3_free(evaluation->facts);
  sqlite3_free(evaluation->delta);
  for (relation_index = 0; relation_index < evaluation->base_count; relation_index++) {
    RecursiveBaseRelation *relation = &evaluation->bases[relation_index];
    for (tuple_index = 0; tuple_index < relation->count; tuple_index++) {
      recursive_tuple_clear(&relation->tuples[tuple_index]);
    }
    sqlite3_free(relation->tuples);
    sqlite3_free(relation->predicate);
  }
  for (operator_index = 0; operator_index < 6; operator_index++) {
    for (left_affinity = 0; left_affinity < 3; left_affinity++) {
      for (right_affinity = 0; right_affinity < 3; right_affinity++) {
        sqlite3_finalize(
            evaluation->comparators[operator_index][left_affinity][right_affinity]);
      }
    }
  }
  sqlite3_free(evaluation->error);
  memset(evaluation, 0, sizeof(*evaluation));
}

static int recursive_run(RecursiveEvaluation *evaluation) {
  const char *target = evaluation->program->rules[0].head.predicate;
  int rule_index;
  int seed_end;
  int iteration = 0;

  evaluation->visible_fact_count = 0;
  for (rule_index = 0; rule_index < evaluation->program->count; rule_index++) {
    if (recursive_rule_occurrences(&evaluation->program->rules[rule_index], target) == 0 &&
        !recursive_evaluate_rule(evaluation, rule_index, -1)) {
      return 0;
    }
  }
  seed_end = evaluation->fact_count;
  evaluation->delta_count = seed_end;
  for (rule_index = 0; rule_index < seed_end; rule_index++) evaluation->delta[rule_index] = rule_index;

  while (evaluation->delta_count > 0) {
    int round_start = evaluation->fact_count;
    if (iteration++ >= MAX_FIXPOINT_ITERATIONS) {
      evaluation->error = sqlite3_mprintf("Datalog recursion exceeded 1000 iterations");
      return 0;
    }
    evaluation->visible_fact_count = round_start;
    for (rule_index = 0; rule_index < evaluation->program->count; rule_index++) {
      Rule *rule = &evaluation->program->rules[rule_index];
      int literal_index;
      if (recursive_rule_occurrences(rule, target) == 0) continue;
      for (literal_index = 0; literal_index < rule->body_count; literal_index++) {
        if (strcmp(rule->body[literal_index].predicate, target) == 0 &&
            !recursive_evaluate_rule(evaluation, rule_index, literal_index)) {
          return 0;
        }
      }
    }
    evaluation->delta_count = evaluation->fact_count - round_start;
    for (rule_index = 0; rule_index < evaluation->delta_count; rule_index++) {
      evaluation->delta[rule_index] = round_start + rule_index;
    }
  }
  return 1;
}

static int recursive_append_value_json(sqlite3_str *json, const RecursiveValue *value) {
  if (value->type == SQLITE_NULL) {
    if (!json_has_space(json, 4)) return 0;
    sqlite3_str_appendall(json, "null");
  } else if (value->type == SQLITE_INTEGER) {
    if (!json_has_space(json, 32)) return 0;
    sqlite3_str_appendf(json, "%lld", value->integer);
  } else if (value->type == SQLITE_FLOAT) {
    if (!json_has_space(json, 32)) return 0;
    sqlite3_str_appendf(json, "%!.17g", value->real);
  } else if (value->type == SQLITE_BLOB) {
    int index;
    if (!json_has_space(json, (sqlite3_int64)value->length * 2 + 2)) return 0;
    sqlite3_str_appendchar(json, 1, '"');
    for (index = 0; index < value->length; index++) {
      sqlite3_str_appendf(json, "%02x", value->bytes[index]);
    }
    sqlite3_str_appendchar(json, 1, '"');
  } else {
    return append_json_string(json, value->bytes, value->length);
  }
  return 1;
}

static int recursive_append_tuple_values(sqlite3_str *json, const RecursiveTuple *tuple) {
  int index;
  if (!json_has_space(json, 1)) return 0;
  sqlite3_str_appendchar(json, 1, '[');
  for (index = 0; index < tuple->count; index++) {
    if (index > 0) {
      if (!json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, ',');
    }
    if (!recursive_append_value_json(json, &tuple->values[index])) return 0;
  }
  if (!json_has_space(json, 1)) return 0;
  sqlite3_str_appendchar(json, 1, ']');
  return 1;
}

static int recursive_append_proof(RecursiveEvaluation *evaluation, sqlite3_str *json,
                                  int fact_index, int depth) {
  RecursiveFact *fact;
  const char *predicate = evaluation->program->rules[0].head.predicate;
  int input_index;
  if (depth > MAX_PROOF_DEPTH) {
    evaluation->error = sqlite3_mprintf("Datalog provenance exceeded depth 128");
    return 0;
  }
  fact = &evaluation->facts[fact_index];
  if (!json_has_space(json, 1)) return 0;
  sqlite3_str_appendchar(json, 1, '{');
  if (!append_json_string(json, (const unsigned char *)"predicate", 9) ||
      !json_has_space(json, 1)) return 0;
  sqlite3_str_appendchar(json, 1, ':');
  if (!append_json_string(json, (const unsigned char *)predicate, (int)strlen(predicate)) ||
      !json_has_space(json, 1)) return 0;
  sqlite3_str_appendchar(json, 1, ',');
  if (!append_json_string(json, (const unsigned char *)"values", 6) ||
      !json_has_space(json, 1)) return 0;
  sqlite3_str_appendchar(json, 1, ':');
  if (!recursive_append_tuple_values(json, &fact->tuple) || !json_has_space(json, 64)) return 0;
  sqlite3_str_appendf(json, ",\"rule\":%d,\"because\":[", fact->rule_index + 1);
  for (input_index = 0; input_index < fact->input_count; input_index++) {
    RecursiveInput *input = &fact->inputs[input_index];
    if (input_index > 0) {
      if (!json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, ',');
    }
    if (input->recursive) {
      if (!recursive_append_proof(evaluation, json, input->tuple_index, depth + 1)) return 0;
    } else {
      RecursiveBaseRelation *relation = &evaluation->bases[input->relation_index];
      RecursiveTuple *tuple = &relation->tuples[input->tuple_index];
      if (!json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, '{');
      if (!append_json_string(json, (const unsigned char *)"predicate", 9) ||
          !json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, ':');
      if (!append_json_string(json, (const unsigned char *)relation->predicate,
                              (int)strlen(relation->predicate)) ||
          !json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, ',');
      if (!append_json_string(json, (const unsigned char *)"values", 6) ||
          !json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, ':');
      if (!recursive_append_tuple_values(json, tuple) || !json_has_space(json, 1)) return 0;
      sqlite3_str_appendchar(json, 1, '}');
    }
  }
  if (!json_has_space(json, 2)) return 0;
  sqlite3_str_appendall(json, "]}");
  return 1;
}

static char *recursive_serialize(RecursiveEvaluation *evaluation, int explain) {
  sqlite3_str *json = sqlite3_str_new(evaluation->database);
  const Literal *head = &evaluation->program->rules[0].head;
  int fact_index;
  if (json == NULL) {
    evaluation->error = sqlite3_mprintf("out of memory");
    return NULL;
  }
  sqlite3_str_appendchar(json, 1, '[');
  for (fact_index = 0; fact_index < evaluation->fact_count; fact_index++) {
    int term_index;
    RecursiveFact *fact = &evaluation->facts[fact_index];
    if (!json_has_space(json, fact_index > 0 ? 2 : 1)) goto too_big;
    if (fact_index > 0) sqlite3_str_appendchar(json, 1, ',');
    sqlite3_str_appendchar(json, 1, '{');
    if (explain) {
      if (!append_json_string(json, (const unsigned char *)"row", 3) ||
          !json_has_space(json, 2)) goto too_big;
      sqlite3_str_appendall(json, ":{");
    }
    for (term_index = 0; term_index < head->term_count; term_index++) {
      const char *name = head->terms[term_index].text;
      if (term_index > 0) {
        if (!json_has_space(json, 1)) goto too_big;
        sqlite3_str_appendchar(json, 1, ',');
      }
      if (!append_json_string(json, (const unsigned char *)name, (int)strlen(name)) ||
          !json_has_space(json, 1)) goto too_big;
      sqlite3_str_appendchar(json, 1, ':');
      if (!recursive_append_value_json(json, &fact->tuple.values[term_index])) goto too_big;
    }
    if (explain) {
      if (!json_has_space(json, 11)) goto too_big;
      sqlite3_str_appendall(json, "},\"proof\":");
      if (!recursive_append_proof(evaluation, json, fact_index, 0)) goto too_big;
    }
    if (!json_has_space(json, 1)) goto too_big;
    sqlite3_str_appendchar(json, 1, '}');
  }
  if (!json_has_space(json, 1)) goto too_big;
  sqlite3_str_appendchar(json, 1, ']');
  return sqlite3_str_finish(json);

too_big:
  sqlite3_str_finish(json);
  if (evaluation->error == NULL) {
    evaluation->error = sqlite3_mprintf("Datalog result exceeded 16 MiB");
  }
  return NULL;
}

static void recursive_result_function(sqlite3_context *context, sqlite3_value *value,
                                      int explain) {
  RecursiveProgram program;
  RecursiveEvaluation evaluation;
  const char *text;
  char *error = NULL;
  char *json;
  int bytes;
  memset(&evaluation, 0, sizeof(evaluation));

  if (sqlite3_value_type(value) == SQLITE_NULL) {
    sqlite3_result_error(context, "Datalog program must not be NULL", -1);
    return;
  }
  bytes = sqlite3_value_bytes(value);
  if (bytes > MAX_RULE_BYTES) {
    sqlite3_result_error(context, "Datalog program exceeds 64 KiB", -1);
    return;
  }
  text = (const char *)sqlite3_value_text(value);
  if (text == NULL) {
    sqlite3_result_error_nomem(context);
    return;
  }
  if (memchr(text, '\0', (size_t)bytes) != NULL) {
    sqlite3_result_error(context, "Datalog program contains a NUL byte", -1);
    return;
  }
  if (!recursive_parse_program(text, &program, &error) ||
      !recursive_validate_program(&program, &error)) {
    sqlite3_result_error(context, error == NULL ? "invalid Datalog program" : error, -1);
    sqlite3_free(error);
    recursive_program_clear(&program);
    return;
  }

  evaluation.database = sqlite3_context_db_handle(context);
  evaluation.program = &program;
  evaluation.facts = sqlite3_malloc64(sizeof(RecursiveFact) * (sqlite3_uint64)MAX_QUERY_ROWS);
  evaluation.delta = sqlite3_malloc64(sizeof(int) * (sqlite3_uint64)MAX_QUERY_ROWS);
  if (evaluation.facts == NULL || evaluation.delta == NULL) {
    recursive_evaluation_clear(&evaluation);
    recursive_program_clear(&program);
    sqlite3_result_error_nomem(context);
    return;
  }
  memset(evaluation.facts, 0, sizeof(RecursiveFact) * (size_t)MAX_QUERY_ROWS);

  if (!recursive_run(&evaluation)) {
    sqlite3_result_error(context,
                         evaluation.error == NULL ? "recursive Datalog evaluation failed"
                                                  : evaluation.error,
                         -1);
    recursive_evaluation_clear(&evaluation);
    recursive_program_clear(&program);
    return;
  }
  json = recursive_serialize(&evaluation, explain);
  if (json == NULL) {
    sqlite3_result_error(context,
                         evaluation.error == NULL ? "failed to serialize Datalog result"
                                                  : evaluation.error,
                         -1);
  } else {
    sqlite3_result_text(context, json, -1, sqlite3_free);
  }
  recursive_evaluation_clear(&evaluation);
  recursive_program_clear(&program);
}
