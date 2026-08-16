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
  type DerivationProof,
  type ExplainedBindings,
  type EvaluateOptions,
  type MaterializedFactWithProof,
  EngineLimitError,
  evaluate,
  evaluateWithProof,
  literalMatches,
  materializeWithProof,
} from './evaluate.js';
export { ParseError } from './lexer.js';
export { parseProgram, parseQuery } from './parser.js';
