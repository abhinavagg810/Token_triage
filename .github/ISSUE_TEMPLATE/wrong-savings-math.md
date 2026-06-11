---
name: Wrong savings math
about: A finding's dollar figure, percentage, or projection looks wrong
title: "[math] "
labels: math, bug
---

**Which analyzer / figure looks wrong?**
e.g. "cache-miss waste is 3× what I'd expect", "monthly projection ignores weekends".

**What did TokenTriage report?**
Paste the relevant finding card / terminal row / `--json` block.

**What did you expect, and why?**
Show your own math if you can — formulas live in
[`core/src/analyzers/THRESHOLDS.md`](../../core/src/analyzers/THRESHOLDS.md).

**Anonymized fixture (the most useful thing you can attach)**
A few generic-JSONL records that reproduce the issue, with hashes and ids
scrambled. TokenTriage never needs prompt bodies — please don't include any:

```jsonl
{"id":"r1","timestamp":"2026-05-04T09:12:01Z","provider":"anthropic","model":"claude-sonnet-4-5","input_tokens":3120,"output_tokens":410,"cache_read_tokens":0,"cache_write_tokens":0,"status":200,"latency_ms":2140,"session_id":"s1","system_prompt_hash":"aaaa","full_prompt_hash":"bbbb","max_tokens_set":true,"metadata":{}}
```

**Pricing**
Are you on bundled pricing or an override file? If overridden, paste the
relevant entries (rates only).
