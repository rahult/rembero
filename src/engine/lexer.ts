export class ParseError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} at line ${line}`);
    this.name = 'ParseError';
  }
}

export type TokenKind =
  | 'atom'
  | 'qatom'
  | 'var'
  | 'wildcard'
  | 'num'
  | '('
  | ')'
  | ','
  | '.'
  | ':-'
  | '?-'
  | 'cmp'
  | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  num?: number;
  line: number;
}

const CMP_OPS = ['<=', '>=', '!=', '=', '<', '>'] as const;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  const push = (kind: TokenKind, text: string, num?: number) =>
    tokens.push({ kind, text, num, line });

  while (i < input.length) {
    const ch = input[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '%') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= input.length) throw new ParseError('unterminated quoted atom', line);
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          if (input[i] === '\n') line++;
          value += input[i];
          i++;
        }
      }
      push('qatom', value);
      continue;
    }
    if (/[a-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      push('atom', input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Z]/.test(ch) || ch === '_') {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      const text = input.slice(i, j);
      push(text === '_' ? 'wildcard' : 'var', text);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = ch === '-' ? i + 1 : i;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      // a decimal point only belongs to the number when a digit follows it
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      const text = input.slice(i, j);
      push('num', text, Number(text));
      i = j;
      continue;
    }
    if (input.startsWith(':-', i)) {
      push(':-', ':-');
      i += 2;
      continue;
    }
    if (input.startsWith('?-', i)) {
      push('?-', '?-');
      i += 2;
      continue;
    }
    const op = CMP_OPS.find((o) => input.startsWith(o, i));
    if (op) {
      push('cmp', op);
      i += op.length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === '.') {
      push(ch, ch);
      i++;
      continue;
    }
    throw new ParseError(`unexpected character '${ch}'`, line);
  }

  push('eof', '<eof>');
  return tokens;
}
