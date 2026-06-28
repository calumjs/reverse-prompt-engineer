---
name: reverse-prompt-engineer
description: >
  Reverse-engineer the prompt that most likely produced a given piece of text. Fans out many
  subagents that each guess a candidate prompt, runs each guess one-shot in a clean room (the
  executor never sees the target), scores the output against the target, then steers the best
  candidates over several rounds until the reproduction matches as closely as possible.
  Trigger when the user says "reverse engineer this prompt", "what prompt produced this",
  "guess the prompt", "reverse prompt engineer", or invokes /reverse-prompt-engineer.
  Accepts: the target text (required), and optional tuning — fanout, rounds, keep, threshold.
---

# Reverse Prompt Engineer

Given a piece of **target text**, recover a prompt that — when handed to a fresh model with no
other context — reproduces text as close to the target as possible. This is an evolutionary
search driven by a multi-agent workflow:

1. **Seed** — N guesser agents each propose a candidate prompt, each through a *different lens*
   (a simple question, a system+user pair, a constrained task, a creative brief, a transformation,
   a template, a minimal prompt, a richly-specified prompt) so the starting pool is diverse.
2. **Execute** — each candidate is run **one-shot in a clean room**: an executor agent sees *only*
   the candidate prompt, never the target, and produces what that prompt would naturally yield.
   This separation is the whole point — it keeps the reproduction honest instead of leaking the answer.
3. **Score** — a judge compares each produced output against the target (content, structure, tone,
   length, details), returns a 0–100 similarity, and gives concrete steering advice.
4. **Steer** — the top candidates are rewritten using the judge's advice and re-evaluated. Survivors
   are always carried forward so a strong prompt is never lost to a worse rewrite. Loop until the best
   similarity clears the threshold, the rounds run out, or the token budget runs low.

The orchestration lives in **`workflow.js`** next to this file. You run it via the **Workflow** tool —
invoking it from this skill is the explicit opt-in the tool requires.

## How to run it

1. **Get the target text.** It's whatever the user wants reverse-engineered — usually pasted in their
   message. If they didn't include any text, ask for it before doing anything else. Don't guess.

2. **Read any tuning options** the user mentioned and fold them into the args object (all optional):
   - `fanout` — conventional seed guessers (default `10`)
   - `wild` — unconventional "wildcard" seed guessers that try weird angles (personas, odd formats,
     continuations, constraint-stacking) to induce different response types (default `6`)
   - `explore` — fresh wildcard explorers injected each steer round to add novelty / break plateaus (default `3`)
   - `rounds` — max steering rounds (default `3`)
   - `keep` — survivors carried into each steer round (default `4`)
   - `threshold` — similarity (0–100) at which to stop early (default `90`)
   - `patience` — stop after this many steer rounds with no improvement (plateau stop; default `2`, `0` disables)
   - `lengthFree` / `lengthScale` — length-penalty knobs (defaults `30` / `80`; see Scoring below)

3. **Invoke the Workflow tool** with the bundled script and the target as `args`. Use `scriptPath` so
   you don't have to re-send the script. The script (`workflow.js`) sits **next to this SKILL.md**, in this
   skill's own directory. This skill ships inside a plugin, so build the path from the skill's base
   directory — the absolute path printed as "Base directory for this skill" when the skill loads:

   ```
   Workflow({
     scriptPath: "<skill base directory>/workflow.js",
     args: { text: "<the full target text>", fanout: 10, rounds: 3, threshold: 90 }
   })
   ```

   `${CLAUDE_PLUGIN_ROOT}/skills/reverse-prompt-engineer/workflow.js` resolves to the same file if the
   environment variable is available. Always pass an **absolute** path — do not assume the old project-relative
   `.claude/skills/...` location, which no longer exists now that this is a plugin.

   If the user gave no tuning, you may pass the raw string as `args` (e.g. `args: "<the target text>"`) —
   the script accepts either form. Preserve the target's exact formatting, whitespace, and line breaks.

4. **Present the result** the workflow returns. Lead with the recovered prompt, then show how close it
   got and let the user judge. A good shape:

   - **Recovered prompt** — `bestPrompt`, in a fenced block so it's copy-pasteable.
   - **Match: `similarity`/100** — and one line on `whatMatched` / `whatDiffered`.
   - **Reproduced output** — ALWAYS quote `reproducedOutput` back **in full**, verbatim, in its own fenced
     block. This is the actual text the clean-room model produced from the recovered prompt, and it is the
     single most useful thing for the user to eyeball against their original. Never paraphrase, truncate, or
     merely describe it — show the whole thing, even when the match is poor (a bad reproduction is exactly
     what the user needs to see). Only omit it if `reproducedOutput` is null.
   - Optionally, the `runnersUp` prompts if they're meaningfully different and useful.
   - Note the `steeringRounds`, `candidatesEvaluated`, and `stoppedReason` (`threshold-reached` /
     `plateaued` / `rounds-exhausted` / `stopped-early`) so the effort and why-it-stopped are transparent.
     If it `plateaued`, say so — more rounds won't help; suggest changing a penalty knob instead.

5. **Offer next steps** when the match is imperfect: re-run with a higher `fanout`/`rounds`, a higher
   `threshold`, or a refined target. If the user liked a runner-up better, offer to steer from that one.

## Scoring: raw similarity minus two penalties

The headline `similarity` is **not** the raw judge score. The goal is to recover the *short, generating
instruction a person would actually type* — not a long prompt that smuggles the answer in by quoting the
target. So the ranked score is the judge's raw match multiplied by two code-computed penalties:

`similarity = rawSimilarity × (1 − leakage) × lengthFactor`

- `rawSimilarity` (0–100) — the judge's content/structure/tone match of the clean-room output vs the target.
- `verbatimLeakagePct` — deterministic: the % of the target's words covered by runs of **5+ consecutive
  words** that also appear verbatim in the candidate prompt. `(1 − leakage)` guts prompts that quote the answer.
- `promptWords` + length penalty — people type short prompts, so length is penalized. The first
  `lengthFree` words (default 30) are free; beyond that the score decays — a prompt `lengthScale` words
  (default 80) over the free budget keeps half its score, twice that a third, and so on. Tune via the
  `lengthFree` / `lengthScale` args.

Both penalties are wired through the whole loop: guessers are told to stay terse and never copy 5+-word runs,
the judge is forbidden from ever advising "use this exact line," and the steerer is fed the current leakage
**and word count** and told to cut both. When you present results, **report the breakdown** — e.g.
"similarity 41/100 (raw 77, 0% leakage, 250 words)" — so the user sees whether the score was lost to quoting,
to length, or is a genuine residual (style/specifics a short prompt legitimately can't recover).

## Notes

- The executor never sees the target, by design — the reproduction is honest, not a copy.
- Similarity is a judge's estimate plus a code penalty, not a guarantee — describe it as "approximate match."
- This burns tokens (many subagents over several rounds). For a quick, cheap pass, suggest `fanout: 4, rounds: 1`.
