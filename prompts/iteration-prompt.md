# Iteration Prompts

Fed back to the PM by the stop hook between iterations. Each iteration gets a phase-specific prompt followed by the shared checklist.

## Checklist

Do NOT trust what the coder or QA reported at face value. Reports document what agents SAID they did. You verify what ACTUALLY works. These often differ.

**For each acceptance criterion in the JIRA issue:**
1. State the criterion.
2. State the concrete evidence that proves it works (real output, real data, real behavior).
3. No evidence → not verified, regardless of what was reported.

**Challenge negative results.** "No data found," "empty response," or "feature not found" is more likely a bug than genuinely missing data. Dispatch the coder to investigate before accepting it.

**Read the diff.** `git diff {upstreamBranch}...HEAD` is ground truth. Look for stubs, TODOs, orphaned code, hardcoded values.

**Escalation.** If the same issue has come back from coder→QA twice, the coder's approach is wrong. Tell them to reconsider, not just retry.

## First

Iteration {{N}}/{{MAX}}. The coder finished their first pass. Verify the work is real.

1. Dispatch wario-qa with every acceptance criterion and expected outcome — not just "test the feature."
2. VALIDATED with evidence → Phase 4, then finalize.
3. ISSUES → send failures to coder, re-dispatch QA.
4. BLOCKED → try to unblock. If truly external → turn-result.json "blocked" + post to JIRA.

## Middle

Iteration {{N}}/{{MAX}}. Assume previous results are wrong until proven otherwise.

The coder's report is what they THINK they built. QA's report is what they THINK they tested. Neither is proof.

- **FAIL items**: send to coder. Second time same issue? Tell them their approach is fundamentally wrong.
- **BLOCKED items**: can you unblock? If truly external → turn-result.json "blocked" + post to JIRA.
- **PASS items**: "No errors" is not evidence. Absence of failure is not presence of success. Ask QA for positive proof.

After coder fixes, re-dispatch QA with the specific criteria that failed.

## Final

Iteration {{N}}/{{MAX}} (FINAL). Ship or block now. Run the full Phase 5 from your system prompt — every step, no shortcuts.
