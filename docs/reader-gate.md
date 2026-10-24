# Changing the AI reader: the reader gate

The AI reader is the pinned model plus `READER_PROMPT` and `READER_PROMPT_VERSION` (`packages/extraction`), `addressedText`, and `verifyReadings`. Every change to any of these must pass the reader gate before it merges.

## What the gate is

The gate is 32 deals with keys. 10 are seen (A–J) and 22 are unseen, held out. The deals, keys and scripts are kept outside this repository, with the held-out sets. Implementers do not see or run them; the owner or the auditing reviewer runs the gate and records the result on the pull request.

The gate fails if any of these happens:
- a wrong value;
- a trap is read;
- an extra value appears;
- a false conflict appears;
- fewer unseen items are read correctly than in the recorded baseline (544 of 550 at reader-v2, offline).

99% of unseen items is the goal. The gate reports it but does not fail on it.

## Which run a change needs

- **Code after the model call** (`verifyReadings`, unit conversion, how readings become proposals). An offline run is enough. It re-verifies the saved model responses with the new code and is free.
- **Anything that changes what is sent to the model or who answers** (the prompt text, `addressedText`, the parser's addresses, the model, the effort, the schema). A live run is needed: one model call per deal, with a spending cap. Bump `READER_PROMPT_VERSION` for any prompt or address change, so stored readings name what produced them.

Live runs cost money. The owner approves each one.

## Keeping the gate honest

Once a gate deal's wording has shaped a change, it no longer counts as unseen. After a change that was tuned against the gate's misses, refresh the unseen deals with a new held-out set (v14) before trusting the unseen score again.
