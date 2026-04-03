# Iteration Prompts

Fed back to the PM by the stop hook between iterations. Each iteration gets a phase-specific prompt followed by the shared checklist.

## Checklist

Review your coordination so far. Answer honestly:

### Critique — verify, don't trust

Do NOT trust what the coder or QA reported at face value. Reports document what agents SAID they did. You verify what ACTUALLY works. These often differ.

**Verification method** — for each acceptance criterion in the JIRA issue:
1. State the criterion in one sentence.
2. State the concrete evidence that proves it works (real output, real data, real behavior).
3. If you cannot state the evidence — that criterion is NOT verified, regardless of what was reported.

**Read the diff.** Run `git diff {upstreamBranch}...HEAD`. The diff is ground truth. Check for:
- Stubs, TODOs, empty handlers, placeholder returns
- Code that exists but is never called (orphaned)
- Hardcoded values where real data should flow

**Challenge negative results.** If QA reported "no data," "empty response," or "feature not found" — the most likely explanation is a bug in the implementation, not absence of data. Dispatch the coder to investigate before accepting it.

### QA Results
- Did QA actually run the feature (not just compilation checks)?
- Does QA have positive evidence (real output, DB rows, visible behavior) — or just "no errors"?
- If QA found nothing wrong — is that because the feature works, or because QA tested the wrong thing?
- If QA reported BLOCKED — did you try to unblock it before accepting? (start env, set config, find test data)
- If QA reported ISSUES — did you send them to the coder with specific details?

### Escalation
- If the same issue has come back from coder→QA twice — the coder's approach is wrong. Don't send the same fix again. Tell the coder to reconsider their understanding of the system and try a different approach.
- If QA keeps reporting BLOCKED on the same thing — can YOU unblock it? Or is this genuinely external?

### JIRA Status
- If the core feature can't be tested — did you post the blocker to JIRA with exactly what a human needs to provide?
- Is the JIRA ticket in the right status? ("In Review" if shipping, "PM Action" if blocked)

## First

Iteration {{N}}/{{MAX}}. The coder finished their first pass. Now verify the work is real.

1. Read the diff: `git diff {upstreamBranch}...HEAD`. Understand what was actually built.
2. Dispatch wario-qa to test the actual feature — not compilation, not config checks. Include in the QA prompt:
   - Every acceptance criterion from the JIRA issue
   - What the expected outcome should be for each (expected data, expected behavior, expected UI)
   - Environment info and credentials
3. If QA reports VALIDATED with positive evidence → review the diff yourself (Phase 4), then finalize.
4. If QA reports ISSUES → send the specific failures to the coder to fix, then re-dispatch QA.
5. If QA reports BLOCKED → can you help unblock? (start env, set config, find test data). If it truly needs something external, write turn-result.json "blocked" and post to JIRA.

## Middle

Iteration {{N}}/{{MAX}}. Assume the previous iteration's results are wrong until you have independent evidence otherwise.

The coder's report is what they THINK they built. QA's report is what they THINK they tested. Neither is proof.

Read the QA report from last iteration and act:
- **FAIL items**: send specific failure details to the coder. If this is the second time the same issue is coming back, tell the coder their approach may be fundamentally wrong — don't just describe the symptom, ask them to reconsider their understanding of the system.
- **BLOCKED items**: can you unblock? Check env, credentials, test data. If truly external, write turn-result.json "blocked" and post to JIRA.
- **PASS items**: is the evidence real? "No errors" is not evidence of correctness. Absence of failure is not presence of success. Ask QA to show positive proof — real output, real data, real behavior that matches the acceptance criteria.

After coder fixes, re-dispatch QA with the specific criteria that failed — don't just say "test again."

## Final

Iteration {{N}}/{{MAX}} (FINAL). You must ship or block now. No more iterations.

**If QA validated the core feature with positive evidence — run the full Phase 5:**
1. `jira_set_plan` — the implementation plan
2. `jira_set_test_results` — QA evidence summary
3. `gh pr create` per repo — body includes what was built and QA evidence
4. `jira_add_comment` with PR link(s) and summary
5. `jira_transition_issue` to "In Review"
6. `git checkout {upstreamBranch}` per repo
7. Write turn-result.json with status "done"

Do NOT skip any step. Every step is required.

**If QA could NOT validate the core feature:**
1. `jira_set_plan` — still write the plan
2. `jira_set_test_results` — what was attempted and what blocked
3. Do NOT open a PR
4. `jira_add_comment` with what's built and what's blocking (exactly what a human needs to provide)
5. `jira_transition_issue` to "PM Action"
6. `git checkout {upstreamBranch}` per repo
7. Write turn-result.json with status "blocked"
