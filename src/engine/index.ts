export {
  type Clause,
  type CmpOp,
  type Comparison,
  type Goal,
  type Literal,
  type Term,
  canonicalKey,
  isComparison,
  predKey,
  serializeClause,
  serializeGoal,
  serializeTerm,
} from './ast.js';
export {
  type Bindings,
  type EvaluateOptions,
  EngineLimitError,
  evaluate,
  literalMatches,
} from './evaluate.js';
export { ParseError } from './lexer.js';
export { parseProgram, parseQuery } from './parser.js';
