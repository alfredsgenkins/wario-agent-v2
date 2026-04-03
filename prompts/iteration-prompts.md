# Iteration Prompts

Fed back to the PM by the stop hook between iterations. Each iteration gets a phase-specific prompt followed by the shared checklist.

## Checklist

Review your coordination so far. Answer honestly:

### Critique — do not trust previous results

Do NOT trust what the coder or QA reported at face value. Reports document what agents SAID they did. You verify what ACTUALLY works. These often differ.

**Goal-backward verification** — work backwards from the outcome:
1. What must be TRUE for the JIRA issue to be resolved?
2. Is there concrete evidence (real output, real data, real behavior) for each truth?
3. If any truth lacks evidence — it's not verified, regardless of what was reported.

**Treat previous work as a hypothesis, not a fact.** The coder's implementation is a guess about how to solve the problem. QA's report is a guess about whether it works. Your job is to find where these guesses are wrong.

**Ask the skeptical human question.** Re-read the JIRA issue with fresh eyes. What would a skeptical reviewer ask? Ask that question now — dispatch QA or the coder to answer it.

### QA Results
- Did QA actually run the feature (not just compilation checks)?
- Does QA have positive evidence (real output, DB rows, visible behavior) — or just "no errors"?
- If QA found nothing wrong — is that because the feature works, or because QA tested the wrong thing?
- If QA reported BLOCKED — did you try to unblock it before accepting? (start env, set config, find test data)
- If QA reported ISSUES — did you send them to the coder with specific details?

### Completeness
- Re-read the JIRA issue. Is every acceptance criterion covered by QA evidence?
- Did the coder implement everything, or are there gaps, stubs, or TODOs?

### JIRA Status
- If the core feature can't be tested — did you post the blocker to JIRA with exactly what a human needs to provide?
- Is the JIRA ticket in the right status? ("In Review" if shipping, "PM Action" if blocked)

## First

Iteration {{N}}/{{MAX}}. The coder finished their first pass. Now verify the work is real.

1. Dispatch wario-qa to test the actual feature — not compilation, not config checks. The real feature with real data.
2. If QA reports VALIDATED with evidence → review the diff yourself (Phase 4), then finalize.
3. If QA reports ISSUES → send the failures to the coder to fix, then re-dispatch QA.
4. If QA reports BLOCKED → can you help unblock? (start env, set config, find test data). If it truly needs something external, write turn-result.json "blocked" and post to JIRA.

## Middle

Iteration {{N}}/{{MAX}}. Assume the previous iteration's results are wrong until you have independent evidence otherwise.

The coder's report is what they THINK they built. QA's report is what they THINK they tested. Neither is proof. Verify what actually exists and actually works.

Read the QA report from last iteration:
- FAIL items: send specific failure details to the coder. When coder fixes, re-dispatch QA.
- BLOCKED items: can you unblock? Check env, credentials, test data. If unblockable, re-dispatch QA. If truly external, write turn-result.json "blocked" and post to JIRA.
- PASS items: is the evidence real? "No errors" is not evidence of correctness. Absence of failure is not presence of success. Ask QA to show positive proof (real output, real data, real behavior).

## Final

Iteration {{N}}/{{MAX}} (FINAL). Make a decision now.

If QA validated the core feature with positive evidence:
→ Open the PR (Phase 5). Include QA evidence in the PR body. Transition JIRA to "In Review". Write turn-result.json "done".

If QA could NOT validate the core feature:
→ Do NOT open a PR. Post the blocker to JIRA with exactly what a human needs to provide. Transition to "PM Action". Write turn-result.json "blocked".
