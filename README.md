# pi-ask-jev-question

A [Pi coding agent](https://pi.dev) extension that lets the model ask **you** questions — with every option **pre-scored by [Jev](https://openrouter.ai/typesafe/jev-1.13)** (TypeSafe's System One decision model), so each question arrives with a recommended choice, calibrated probabilities, and a confidence level.

```
▸★ 1. SQLite p=1.00 conf=1.00 ▊▊▊▊▊▊▊▊▊▊
     File-based, zero-config, resumable across runs
  2. Redis  p=0.00 ░░░░░░░░░░
     Fast, shared across machines, needs a server
  3. MariaDB  p=0.00 ░░░░░░░░░░
     Reuse the WP site DB, no extra infra
  4. Type something.
 Jev: typesafe/jev-1.13 · scored 2 questions
 Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel
```

## Why

When an agent needs a human decision mid-task, a bare list of options makes *you* do all the thinking. This extension forwards the question — plus the context the model must supply — to Jev, which returns calibrated probabilities per option. You see the recommendation (`▸★`), its probability and confidence, and probability bars for every alternative before you answer. Your answer (and Jev's take) go back to the model, so it also learns when it over- or under-trusted the recommendation.

## Install

```bash
pi install git:github.com/shadyvb/pi-ask-jev-question
```

Or try it once without installing:

```bash
pi -e git:github.com/shadyvb/pi-ask-jev-question
```

### Setup

- **`OPENROUTER_API_KEY`** must be set in your environment. Jev (`typesafe/jev-1.13`) is billed through your OpenRouter account at roughly **$0.00002 per question batch** ($0.042/M input tokens, output free).
- No other configuration required. If the key is missing, or the Jev API is unreachable, the extension **fails gracefully**: you get a plain questionnaire with no recommendations — never an error.

## The tool contract (what the model sees)

```
ask_user_question(context, questions[])
  context   REQUIRED, min 20 chars — task state, constraints, why a decision
            is needed. This is what Jev evaluates the options against.
  questions 1–10 items:
            prompt    the question text
            options   2–255 items: { value, label, description? }
            allowOther  default true — adds a "Type something" free-text option
```

Single question → simple list. Multiple questions → tabbed interface (`Q1 · Q2 · … · Submit`).

## What comes back to the model

```
Q "Backend": SQLite (sqlite) [jev: SQLite p=1.00 conf=1.00 AGREED]
Q "Key Scoping": per-site (per-site) [jev: per-run p=0.41 conf=0.55 user overrode]
Jev: ok 2 scored
```

`AGREED` / `user overrode` tells the model whether the human confirmed or overruled the recommendation — useful signal for calibrating future questions.

## Autonomous answering (planned)

The scoring path already supports auto-answering; it ships **disabled**. In `extensions/ask-jev-question.ts`:

```ts
autoAnswer: { enabled: false, minProbability: 0.9, minConfidence: 0.85 }
```

Flip `enabled: true` and any question Jev scores at `p ≥ 0.9` with `confidence ≥ 0.85` is answered automatically — only genuinely uncertain questions reach you. (Search for `AUTO-ANSWER SEAM` in the source.)

## Notes

- One batched Decisions API call per tool invocation (10s timeout) — all questions scored in a single request.
- Recommended option = argmax of Jev's per-option probabilities.
- Adapted from Pi's bundled `examples/extensions/questionnaire.ts` (MIT, © earendil-works) — the UI chassis is theirs; the Jev integration is this repo's.

## License

MIT © Shadi Sharaf
