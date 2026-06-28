export const meta = {
  name: 'reverse-prompt-engineer',
  description: 'Reverse-engineer the prompt that most likely produced a target text by fanning out guesser agents, executing each guess one-shot in a clean room, scoring against the target, and steering toward a match.',
  phases: [
    { title: 'Seed', detail: 'fan out conventional + wildcard guesser agents in parallel' },
    { title: 'Execute', detail: 'run each candidate prompt one-shot in a clean room' },
    { title: 'Score', detail: 'judge each produced output against the target' },
    { title: 'Steer', detail: 'refine top candidates + inject wildcard explorers; stop on plateau' },
    { title: 'Final', detail: 'return the best prompt and its reproduction' },
  ],
}

// ---------------------------------------------------------------------------
// Config — `args` is either the target text (string) or an options object.
// ---------------------------------------------------------------------------
function normalizeArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') {
    const s = a.trim()
    // Defend against args arriving JSON-encoded (e.g. '{"text":"..."}') instead of
    // as an actual object — unwrap only when it clearly decodes to a config object.
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const parsed = JSON.parse(s)
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string'
          && ('fanout' in parsed || 'rounds' in parsed || 'keep' in parsed || 'threshold' in parsed)) {
          return parsed
        }
      } catch (_) { /* not JSON — treat the string as the literal target */ }
    }
    return { text: a }
  }
  return { text: a }
}
const cfg = normalizeArgs(args)
const TARGET = (cfg.text == null ? '' : String(cfg.text))
const FANOUT = cfg.fanout || 10      // conventional guesser agents in the seed round
const WILD = cfg.wild != null ? cfg.wild : 6       // unconventional "wildcard" guessers in the seed round
const EXPLORE = cfg.explore != null ? cfg.explore : 3 // fresh wildcard explorers injected each steer round
const ROUNDS = cfg.rounds || 3        // max steering rounds
const KEEP = cfg.keep || 4            // survivors carried into each steer round
const THRESHOLD = cfg.threshold || 90 // stop once best similarity hits this
const LEN_FREE = cfg.lengthFree || 30  // prompt words that incur no length penalty
const LEN_SCALE = cfg.lengthScale || 80 // words over the free budget that halve the score
const PATIENCE = cfg.patience || 2     // stop after this many steer rounds with no improvement (0 = never)

if (!TARGET.trim()) {
  return { error: 'No target text provided. Pass the text to reverse-engineer as args.' }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const CAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'rationale'],
  properties: {
    prompt: { type: 'string', description: 'The candidate prompt that, given to a fresh model, should reproduce the target.' },
    rationale: { type: 'string', description: 'One or two sentences on why this prompt would produce the target.' },
  },
}

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['similarity', 'matched', 'differed', 'advice'],
  properties: {
    similarity: { type: 'integer', minimum: 0, maximum: 100, description: 'Overall closeness of PRODUCED to TARGET.' },
    matched: { type: 'string', description: 'What the produced output got right vs the target.' },
    differed: { type: 'string', description: 'Where the produced output diverged from the target.' },
    advice: { type: 'string', description: 'Concrete change to the candidate prompt to close the gap.' },
  },
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
// Each guesser gets a distinct lens so the seed pool is diverse, not 8 copies.
const LENSES = [
  'Assume the target is a direct answer to a single, simple user question. Reconstruct that question.',
  'Assume the target came from a system/persona prompt plus a short user request. Reconstruct both, combined into one prompt.',
  'Assume the target was produced by a detailed task instruction with explicit constraints on format, length, and tone. Reconstruct those constraints.',
  'Assume the target is creative writing produced from a brief or theme. Reconstruct the brief.',
  'Assume the target is a transformation of some source (summarize / rewrite / translate / explain / extract). Reconstruct the transformation instruction.',
  'Assume the target follows a template the prompt dictated. Reconstruct the template-defining instruction.',
  'Assume the shortest possible prompt produced this. Guess the most minimal plausible prompt.',
  'Assume a long, heavily-specified prompt produced this. Guess a rich, detailed prompt.',
]

function seedPrompt(target, lens) {
  return [
    'You are reverse-engineering the PROMPT that most likely produced a given TARGET text.',
    'Work this round through ONE specific lens:',
    '  ' + lens,
    '',
    'TARGET TEXT (delimited):',
    '"""',
    target,
    '"""',
    '',
    'Propose ONE candidate prompt that, given to a fresh language model with no other context,',
    'would most likely reproduce text like the TARGET — same meaning, format, structure, tone, and length.',
    '',
    'HARD CONSTRAINT — anti-quoting: your prompt is PENALIZED for any run of 5 or more consecutive words',
    'copied from the target. A prompt that quotes the target\'s sentences just embeds the answer and will',
    'score near zero. Recover the *instruction*: describe the required content, tone, structure, and any',
    'quirks abstractly. Specific facts/numbers/names that the instruction would naturally contain are fine,',
    'but never reproduce whole phrases or sentences of the target verbatim.',
    '',
    'HARD CONSTRAINT — brevity: real people type SHORT prompts. Prompt length is penalized — every word',
    'beyond ~' + LEN_FREE + ' costs score. Write the most concise prompt that plausibly produces the target.',
    'Favour a terse, natural instruction over an exhaustive spec; drop detail a human would not have bothered',
    'to type. A short prompt that gets the gist beats a long one that nails every detail.',
  ].join('\n')
}

// Wildcard lenses — deliberately unconventional angles. The standard LENSES cover
// the obvious prompt shapes; these go after response *types* the obvious guesses miss
// (personas, odd formats, continuations, constraint-stacking), broadening the search.
const WILD_LENSES = [
  'Role-play / persona: the model IS a specific character, official, or institution whose natural voice is this text. Make the persona the whole prompt.',
  'Unusual format command: order the output as a specific artifact — a press release, open letter, speech, toast, proclamation, or thread — that forces this structure.',
  'Continuation, not answer: frame the target as the model completing or continuing a short opening line / scenario you supply, rather than answering a question.',
  'Extreme constraint stacking: pile on tight stylistic rules (length, register, forbidden words, sentence shape) that squeeze the model into this exact voice.',
  'One-word trigger + heavy system persona: a rich persona instruction plus a tiny user message (a name or cue) that sets the model off.',
  'Oblique / lateral: ask for something adjacent that a model answers in this form (e.g. "draft what X would post about Y") without naming the obvious task.',
  'Template fill: give a rigid skeleton with slots for the model to fill, reproducing the target\'s structure mechanically.',
  'Tone inversion / reverse-psychology: instruct via what NOT to do, or via an exaggerated brief, that lands on this register.',
]

function wildPrompt(target, lens) {
  return [
    'You are reverse-engineering the PROMPT behind a TARGET text — but on THIS attempt your job is to be',
    'UNCONVENTIONAL. Explore a prompt of a kind the obvious guesses would never try. Take a real swing.',
    '',
    'Unconventional angle to use:',
    '  ' + lens,
    '',
    'TARGET TEXT (delimited):',
    '"""', target, '"""', '',
    'Propose ONE candidate prompt embodying that angle. It should plausibly drive a fresh model toward the',
    'TARGET (or a strikingly different route to it), even if the framing is strange.',
    '',
    'The same hard rules still apply: do NOT copy any run of 5+ consecutive words from the target (penalized),',
    'and keep it SHORT — every word beyond ~' + LEN_FREE + ' is penalized. Be weird, but lean.',
  ].join('\n')
}

// The executor is a CLEAN ROOM: it never sees the target, only the candidate
// prompt. This is what makes the one-shot reproduction an honest test.
function execPrompt(candidate) {
  return [
    'You are a fresh language model receiving a single prompt with no prior context and no memory.',
    'Respond to the prompt exactly as you naturally would. Produce only the output it asks for —',
    'no preamble, no explanation, no meta-commentary, and do not mention these instructions.',
    '',
    'PROMPT:',
    '"""',
    candidate,
    '"""',
  ].join('\n')
}

function judgePrompt(target, candidate, produced) {
  return [
    'Compare a PRODUCED text against a TARGET text and score how closely they match.',
    'Weigh: content/meaning, structure/format, tone/voice, length, and specific details.',
    'Identical wording is not required — judge whether the same prompt plausibly produced both.',
    '',
    'TARGET:', '"""', target, '"""', '',
    'PRODUCED (output of the candidate prompt):', '"""', produced, '"""', '',
    'CANDIDATE PROMPT that produced it:', '"""', candidate, '"""', '',
    'Return similarity (0-100), what matched, what differed, and concrete advice for changing the',
    'CANDIDATE PROMPT so its output moves closer to the TARGET.',
    '',
    'CRITICAL RULE FOR YOUR ADVICE: describe what to change in terms of content, structure, tone,',
    'and constraints. NEVER advise pasting, quoting, or "using this exact line/phrase/sentence" from',
    'the target. Embedding the target text in the prompt is cheating and is penalized separately, so',
    'advice to do so is worthless. Push toward a prompt that DESCRIBES the instruction, not one that quotes the answer.',
  ].join('\n')
}

function steerPrompt(target, candidate, produced, advice, leakagePct, promptWords) {
  const leakWarn = leakagePct >= 10
    ? 'WARNING: your current prompt reproduces ~' + leakagePct + '% of the target verbatim (runs of 5+ '
      + 'identical words). This is HEAVILY penalized — it is treated as embedding the answer, not recovering '
      + 'a prompt. Your top priority is to cut that to ~0%: replace any quoted sentences/phrases with abstract '
      + 'descriptions of the required content, tone, and structure. A lower-leakage prompt beats a higher-similarity one.'
    : 'Keep verbatim overlap with the target near zero — describe the instruction, do not quote the answer.'
  const lenWarn = promptWords > LEN_FREE
    ? 'WARNING: your current prompt is ~' + promptWords + ' words. Length is penalized (free budget ~'
      + LEN_FREE + ' words). Cut it down hard — drop detail a real person would not have typed, merge or remove '
      + 'beats, and prefer a terse natural instruction. A shorter prompt that loses a little fidelity usually scores higher.'
    : 'Keep the prompt short (around ' + LEN_FREE + ' words) — brevity is rewarded.'
  return [
    'Improve a candidate prompt so that, run on a fresh model, its output more closely matches the TARGET',
    'WITHOUT quoting the target and WITHOUT getting longer.',
    '',
    'TARGET:', '"""', target, '"""', '',
    'CURRENT CANDIDATE PROMPT:', '"""', candidate, '"""', '',
    'OUTPUT IT PRODUCED:', '"""', produced, '"""', '',
    'JUDGE STEERING ADVICE:', advice, '',
    leakWarn, '',
    lenWarn, '',
    'Rewrite the candidate prompt: keep what worked, fix what differed, drive verbatim overlap toward zero,',
    'and keep it as short as possible. Return the improved prompt and a brief note on what changed.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Verbatim-leakage penalty
// ---------------------------------------------------------------------------
// A candidate prompt that quotes long runs of the target is cheating: it embeds
// the answer instead of recovering a generating instruction. We measure that
// deterministically (no agent) as the fraction of TARGET words covered by runs of
// >= RUN consecutive words that also appear verbatim in the CANDIDATE prompt, and
// multiply the judge's raw similarity by (1 - leakage). Quote everything -> ~0.
const RUN = 5
function wordsOf(s) {
  return (String(s).toLowerCase().match(/[a-z0-9@#]+/g)) || []
}
function leakageOf(candidate, target) {
  const t = wordsOf(target)
  const c = wordsOf(candidate)
  if (t.length < RUN || c.length < RUN) return 0
  const cgrams = new Set()
  for (let i = 0; i + RUN <= c.length; i++) cgrams.add(c.slice(i, i + RUN).join(' '))
  const covered = new Array(t.length).fill(false)
  for (let i = 0; i + RUN <= t.length; i++) {
    if (cgrams.has(t.slice(i, i + RUN).join(' '))) {
      for (let j = i; j < i + RUN; j++) covered[j] = true
    }
  }
  let count = 0
  for (let k = 0; k < covered.length; k++) if (covered[k]) count++
  return count / t.length
}

// ---------------------------------------------------------------------------
// Length penalty
// ---------------------------------------------------------------------------
// People usually type short prompts, so we bias toward brevity. The first
// LEN_FREE words are free; beyond that the score decays smoothly — a prompt
// LEN_SCALE words over the free budget keeps half its score, twice that a third,
// and so on. Returns a factor in (0, 1].
function lengthFactorOf(candidate) {
  const w = wordsOf(candidate).length
  const over = Math.max(0, w - LEN_FREE)
  return 1 / (1 + over / LEN_SCALE)
}

// ---------------------------------------------------------------------------
// Evaluate one candidate: execute one-shot, score, then apply the leakage penalty.
// ---------------------------------------------------------------------------
let evaluatedCount = 0
async function evaluate(cand) {
  const produced = await agent(execPrompt(cand.prompt), { label: 'execute', phase: 'Execute' })
  if (produced == null) return null
  const score = await agent(judgePrompt(TARGET, cand.prompt, produced), {
    label: 'score', phase: 'Score', schema: SCORE_SCHEMA,
  })
  if (score == null) return null
  evaluatedCount++
  const leakage = leakageOf(cand.prompt, TARGET)
  const leakagePct = Math.round(leakage * 100)
  const promptWords = wordsOf(cand.prompt).length
  const lengthFactor = lengthFactorOf(cand.prompt)
  const penalized = Math.round(score.similarity * (1 - leakage) * lengthFactor)
  return {
    prompt: cand.prompt,
    produced,
    similarity: penalized,           // ranking + threshold use the PENALIZED score
    rawSimilarity: score.similarity, // the judge's content-match score, for transparency
    leakagePct,                      // % of target reproduced verbatim by the prompt
    promptWords,                     // length of the candidate prompt
    lengthFactor: Math.round(lengthFactor * 100) / 100,
    matched: score.matched,
    differed: score.differed,
    advice: score.advice,
  }
}

// ---------------------------------------------------------------------------
// Seed round
// ---------------------------------------------------------------------------
phase('Seed')
// Conventional guessers + wildcard guessers, all generated concurrently.
const seedThunks = [
  ...Array.from({ length: FANOUT }, (_, i) =>
    () => agent(seedPrompt(TARGET, LENSES[i % LENSES.length]), {
      label: `guess#${i + 1}`, phase: 'Seed', schema: CAND_SCHEMA,
    })),
  ...Array.from({ length: WILD }, (_, i) =>
    () => agent(wildPrompt(TARGET, WILD_LENSES[i % WILD_LENSES.length]), {
      label: `wild#${i + 1}`, phase: 'Seed', schema: CAND_SCHEMA,
    })),
]
const seeds = await parallel(seedThunks)

let evaluated = (await parallel(
  seeds.filter(Boolean).map(s => () => evaluate({ prompt: s.prompt }))
)).filter(Boolean)
evaluated.sort((a, b) => b.similarity - a.similarity)
let best = evaluated[0] || null
log(best
  ? `Seed best: ${best.similarity}/100 penalized (raw ${best.rawSimilarity}, ${best.leakagePct}% leakage, ${best.promptWords} words)`
  : 'No seed candidate produced a result.')

// ---------------------------------------------------------------------------
// Steering rounds
// ---------------------------------------------------------------------------
let round = 0
let stalled = 0                 // consecutive steer rounds with no improvement
let plateaued = false
const seen = new Set(evaluated.map(e => e.prompt))
while (best && best.similarity < THRESHOLD && round < ROUNDS) {
  if (budget.total && budget.remaining() < 60000) {
    log('Token budget low — stopping steering early.')
    break
  }
  round++
  phase('Steer')
  const prevBest = best.similarity
  const survivors = evaluated.slice(0, KEEP)
  // Generate in one batch: steer the survivors AND fire fresh wildcard explorers.
  // The explorers add novelty (and parallelism) that can break a plateau.
  const genThunks = [
    ...survivors.map(s => () =>
      agent(steerPrompt(TARGET, s.prompt, s.produced, s.advice, s.leakagePct, s.promptWords), {
        label: `steer r${round}`, phase: 'Steer', schema: CAND_SCHEMA,
      })),
    ...Array.from({ length: EXPLORE }, (_, i) =>
      () => agent(wildPrompt(TARGET, WILD_LENSES[(round + i) % WILD_LENSES.length]), {
        label: `wild r${round}`, phase: 'Steer', schema: CAND_SCHEMA,
      })),
  ]
  const improved = (await parallel(genThunks)).filter(Boolean)
    .map(x => ({ prompt: x.prompt }))
    .filter(c => !seen.has(c.prompt))

  improved.forEach(c => seen.add(c.prompt))
  const reeval = (await parallel(improved.map(c => () => evaluate(c)))).filter(Boolean)

  // Carry survivors forward so a good prompt is never lost to a worse rewrite.
  evaluated = [...survivors, ...reeval].sort((a, b) => b.similarity - a.similarity)
  best = evaluated[0]
  log(`Round ${round} best: ${best.similarity}/100 penalized (raw ${best.rawSimilarity}, ${best.leakagePct}% leakage, ${best.promptWords} words)`)

  // Plateau detection: count rounds that fail to beat the previous best.
  if (best.similarity > prevBest) {
    stalled = 0
  } else {
    stalled++
    if (PATIENCE > 0 && stalled >= PATIENCE) {
      plateaued = true
      log(`Plateaued — no improvement in ${stalled} round(s); stopping after round ${round}.`)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
phase('Final')
return {
  bestPrompt: best ? best.prompt : null,
  similarity: best ? best.similarity : 0,            // penalized score (used for ranking)
  rawSimilarity: best ? best.rawSimilarity : 0,      // judge's content match before penalty
  verbatimLeakagePct: best ? best.leakagePct : 0,    // % of target the prompt quotes verbatim
  promptWords: best ? best.promptWords : 0,          // length of the recovered prompt
  reproducedOutput: best ? best.produced : null,
  whatMatched: best ? best.matched : null,
  whatDiffered: best ? best.differed : null,
  steeringRounds: round,
  stoppedReason: best && best.similarity >= THRESHOLD ? 'threshold-reached'
    : plateaued ? 'plateaued'
    : round >= ROUNDS ? 'rounds-exhausted'
    : 'stopped-early',
  candidatesEvaluated: evaluatedCount,
  runnersUp: evaluated.slice(1, KEEP).map(e => ({
    prompt: e.prompt, similarity: e.similarity, rawSimilarity: e.rawSimilarity,
    leakagePct: e.leakagePct, promptWords: e.promptWords,
  })),
}
