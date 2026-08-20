#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import readline from 'node:readline';

const EXPECTED = {
  questions: '0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7',
  trajectories: '363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6',
  small: '9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593',
};

function parseArgs(argv) {
  const args = {
    dataRoot: undefined,
    outputRoot: undefined,
    domain: 'enterprise',
    count: 10,
    exclude: new Set(),
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--data-root') args.dataRoot = resolve(value ?? '');
    else if (flag === '--output-root') args.outputRoot = resolve(value ?? '');
    else if (flag === '--domain') args.domain = value;
    else if (flag === '--count') args.count = Number(value);
    else if (flag === '--exclude') args.exclude.add(value);
    else throw new Error(`unknown option: ${flag}`);
    index++;
  }
  if (!args.dataRoot || !args.outputRoot) {
    throw new Error('--data-root and --output-root are required');
  }
  if (!['web', 'enterprise'].includes(args.domain)) {
    throw new Error('--domain must be web or enterprise');
  }
  if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 451) {
    throw new Error('--count must be an integer from 1 to 451');
  }
  return args;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function stableQuestionKey(id) {
  return createHash('sha256').update(id).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const questionsPath = resolve(args.dataRoot, 'questions.jsonl');
  const trajectoriesPath = resolve(args.dataRoot, 'trajectories.jsonl');
  const nestedHaystackPath = resolve(args.dataRoot, 'haystacks/lme_v2_small.json');
  const flatHaystackPath = resolve(args.dataRoot, 'lme_v2_small.json');
  const haystackPath = await readFile(nestedHaystackPath).then(
    () => nestedHaystackPath,
    async () => readFile(flatHaystackPath).then(() => flatHaystackPath)
  );
  const hashes = {
    questions: await sha256(questionsPath),
    trajectories: await sha256(trajectoriesPath),
    small: await sha256(haystackPath),
  };
  for (const [name, expected] of Object.entries(EXPECTED)) {
    if (hashes[name] !== expected) {
      throw new Error(`${name} SHA-256 ${hashes[name]} does not match ${expected}`);
    }
  }
  const questions = (await readFile(questionsPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const selected = questions
    .filter((question) =>
      question.domain === args.domain &&
      question.image === null &&
      !String(question.eval_function).startsWith('llm_') &&
      !args.exclude.has(question.id)
    )
    .sort((left, right) =>
      stableQuestionKey(left.id).localeCompare(stableQuestionKey(right.id))
    )
    .slice(0, args.count)
    .map((question) => {
      const result = { ...question };
      delete result.image;
      return result;
    });
  if (selected.length !== args.count) throw new Error('not enough matching questions');
  const fullHaystack = JSON.parse(await readFile(haystackPath, 'utf8'));
  const selectedHaystack = Object.fromEntries(
    selected.map((question) => [question.id, fullHaystack[question.id]])
  );
  const trajectoryIds = new Set(Object.values(selectedHaystack).flat());
  await mkdir(args.outputRoot, { recursive: true, mode: 0o700 });
  const outputTrajectories = resolve(args.outputRoot, 'trajectories-small.jsonl');
  const output = createWriteStream(outputTrajectories, { encoding: 'utf8', mode: 0o600 });
  let found = 0;
  const input = readline.createInterface({
    input: createReadStream(trajectoriesPath),
    crlfDelay: Infinity,
  });
  for await (const line of input) {
    if (!line) continue;
    const trajectory = JSON.parse(line);
    if (!trajectoryIds.has(trajectory.id)) continue;
    output.write(`${line}\n`);
    found++;
  }
  await new Promise((resolvePromise, reject) => {
    output.on('error', reject);
    output.end(resolvePromise);
  });
  if (found !== trajectoryIds.size) {
    throw new Error(`found ${found} of ${trajectoryIds.size} selected trajectories`);
  }
  await Promise.all([
    writeFile(
      resolve(args.outputRoot, 'questions.json'),
      `${JSON.stringify(selected, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    ),
    writeFile(
      resolve(args.outputRoot, 'haystack.json'),
      `${JSON.stringify(selectedHaystack, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    ),
    writeFile(
      resolve(args.outputRoot, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 'remembero.longmemeval-v2-subset.v1',
        hashes,
        domain: args.domain,
        questionIds: selected.map(({ id }) => id),
        trajectoryCount: found,
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    ),
  ]);
  console.log(JSON.stringify({
    outputRoot: args.outputRoot,
    questions: selected.length,
    trajectories: found,
    hashes,
  }, null, 2));
}

await main();
