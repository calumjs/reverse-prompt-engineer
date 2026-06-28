# Reverse Prompt Engineer (Claude Code plugin)

Given a piece of **target text**, recover a prompt that — handed to a fresh model with no other
context — reproduces text as close to the target as possible. It's an evolutionary search run as a
multi-agent **Workflow**:

1. **Seed** — conventional guessers (each through a different lens) *and* unconventional "wildcard"
   guessers (personas, odd formats, continuations, constraint-stacking) propose candidate prompts in parallel.
2. **Execute** — each candidate is run **one-shot in a clean room**: an executor agent sees *only* the
   candidate prompt, never the target, so the reproduction is honest.
3. **Score** — a judge rates the produced output vs the target (0–100), then two code-computed penalties apply:
   - **verbatim-leakage** — quoting 5+ word runs of the target is penalized (no smuggling the answer in)
   - **length** — people type short prompts, so longer prompts are penalized
4. **Steer** — top candidates are rewritten and re-evaluated, with fresh wildcard explorers injected each
   round. Stops on `threshold`, on a **plateau** (no improvement for `patience` rounds), or when `rounds` run out.

## Layout

```
.claude-plugin/
  plugin.json        # plugin manifest
  marketplace.json   # lets this repo be added as a single-plugin marketplace
skills/
  reverse-prompt-engineer/
    SKILL.md         # how the skill drives the Workflow tool
    workflow.js      # the orchestrator (seed -> execute -> score -> steer)
```

## Install

From GitHub:

```
/plugin marketplace add calumjs/reverse-prompt-engineer
/plugin install reverse-prompt-engineer@reverse-prompt-engineer
```

Or from a local clone:

```
/plugin marketplace add /path/to/reverse-prompt-engineer
/plugin install reverse-prompt-engineer@reverse-prompt-engineer
```

Then invoke with `/reverse-prompt-engineer <text>` or just ask to "reverse engineer this prompt".

## Tuning (all optional, passed as args)

| arg | default | meaning |
|---|---|---|
| `fanout` | 10 | conventional seed guessers |
| `wild` | 6 | unconventional wildcard seed guessers |
| `explore` | 3 | fresh wildcard explorers injected each steer round |
| `rounds` | 3 | max steering rounds |
| `keep` | 4 | survivors carried into each steer round |
| `threshold` | 90 | penalized similarity at which to stop early |
| `patience` | 2 | stop after this many rounds with no improvement (`0` disables) |
| `lengthFree` | 30 | prompt words that incur no length penalty |
| `lengthScale` | 80 | words over the free budget that halve the score |

## Scoring

`similarity = rawSimilarity × (1 − leakage) × lengthFactor`

The headline `similarity` is the ranked score; the result also reports `rawSimilarity`,
`verbatimLeakagePct`, `promptWords`, `steeringRounds`, and `stoppedReason`
(`threshold-reached` / `plateaued` / `rounds-exhausted` / `stopped-early`).

> Requires the Workflow (multi-agent orchestration) capability. Each run spawns many subagents over
> several rounds, so it is token-intensive — for a quick pass try `fanout: 4, wild: 2, rounds: 1`.
