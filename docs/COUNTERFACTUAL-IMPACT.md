# Deterministic counterfactual impact

Rembero 0.23 can answer a bounded factual question before a proposed correction becomes
authority. The operation is a read-only sandbox over the same rules, constraints,
identity projection, trust view, proof engine, and explanation graph used by ordinary
queries.

## Use

```bash
rembero what-if 'colleague(mira, Who)' \
  --without 'works_at(rahul, _)' \
  --assume 'works_at(rahul, acme).'

rembero what-if 'status(mira, State)' \
  --assume 'status(mira, paused).' \
  --proof-limit 2 --max-violations 100
```

`--assume` and `--without` are repeatable. Retractions are evaluated first, then
assumptions are appended in request order. This makes an explicit correction—remove the
old fact, add the proposed fact—one deterministic preview.

The library exposes `simulateKnowledge(store, query, options)`. MCP exposes `what_if`.
All surfaces return the same shape:

- `application`: exact assumed, duplicate, retracted, and unmatched inputs;
- `baseline` and `candidate`: complete bounded rows, rules, proofs, sources, and graph;
- `resultDelta`: added and removed bindings, evidence changes for retained bindings, and
  an unchanged count; and
- `integrityDelta`: complete bounded baseline/candidate checks with proof/graph evidence,
  plus introduced and resolved violation identities.

## Authority and provenance

The store captures clauses and durable sources under the normal mutation lock before
evaluation, so every supported writer is excluded while the baseline snapshot is formed.
Evaluation happens on immutable in-memory arrays after that point. No `.dl` file, journal,
checkpoint, persistent cache, or source record is written by the simulation. As with
opening a store, pre-existing interrupted mutations are recovered before the snapshot.

Assumed facts receive deterministic in-memory sources marked `hypothetical: true`.
Their fixed sentinel timestamp has no valid-time or recorded-time meaning. Existing
durable witnesses stay attached, including source alternatives when the requested proof
limit asks for them. A preview is evidence for a decision; it is not authorization to
commit and does not reserve the snapshot against a later writer.

## Namespace semantics

`namespace` is the one namespace hypothetically changed. `namespaces` is the complete
view used by rules and constraints and must include the target. Removing a target fact
does not make it false when another selected namespace still supplies the same canonical
fact. Assuming that fact in the target can therefore change provenance without changing
the result binding; `evidenceChanged` reports that distinction.

## Safety boundaries

- Assumptions are limited to 64 ordinary ground facts. Rules, constraints, variables,
  tentative declarations, and identity metadata are rejected.
- Retractions are limited to 64 single positive fact patterns and cannot target reserved
  trust or identity metadata. Rules and constraints cannot be removed by this surface.
- Inputs retain the 64 KiB ingress bound; results retain the 16 MiB output bound.
- Normal evaluator, proof, graph, aggregate, integrity, namespace, and termination limits
  apply independently to both baseline and candidate. Either side failing a bound aborts
  the whole preview rather than returning a partial delta.
