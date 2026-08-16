export {
  type Clause,
  type CmpOp,
  type Comparison,
  type Goal,
  type Literal,
  type Negation,
  type Term,
  canonicalKey,
  isComparison,
  isNegation,
  predKey,
  serializeClause,
  serializeGoal,
  serializeTerm,
} from './ast.js';
export {
  type AbsenceProof,
  type Bindings,
  type DerivationProof,
  type ExplainedBindings,
  type EvaluateOptions,
  type MaterializedFactWithProof,
  type ProofStep,
  EngineLimitError,
  EngineSafetyError,
  evaluate,
  evaluateWithProof,
  literalMatches,
  materializeWithProof,
} from './evaluate.js';
export { ParseError } from './lexer.js';
export { parseProgram, parseQuery } from './parser.js';
export {
  StratificationError,
  stratifyProgram,
  type StratifiedProgram,
  type StratifiedRule,
} from './stratify.js';
