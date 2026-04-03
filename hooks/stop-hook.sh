#!/bin/bash
# Wario Stop Hook — forces iteration within a single Claude session.
# Blocks exit and re-feeds an iteration prompt until:
#   - Agent writes turn-result.json with status "blocked"
#   - Max iterations reached
#
# State file: {warioRoot}/task-state/{issueKey}/wario-loop.json
# Turn result: {warioRoot}/task-state/{issueKey}/turn-result.json
# Prompts: {warioRoot}/prompts/iteration-prompts.md

set -euo pipefail

HOOK_INPUT=$(cat)

# Derive wario root from this script's location (hooks/ is one level deep)
WARIO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Find the active loop state file — scan task-state dirs for wario-loop.json
STATE_FILE=""
TASK_STATE_DIR="$WARIO_ROOT/task-state"
if [[ -d "$TASK_STATE_DIR" ]]; then
  for dir in "$TASK_STATE_DIR"/*/; do
    candidate="$dir/wario-loop.json"
    if [[ -f "$candidate" ]]; then
      STATE_FILE="$candidate"
      break
    fi
  done
fi

if [[ -z "$STATE_FILE" ]]; then
  exit 0  # No active wario session — allow exit
fi

ISSUE_KEY=$(jq -r '.issueKey' "$STATE_FILE")
MAX_ITERATIONS=$(jq -r '.maxIterations // 3' "$STATE_FILE")
ITERATION=$(jq -r '.iteration // 0' "$STATE_FILE")

TASK_DIR="$WARIO_ROOT/task-state/$ISSUE_KEY"
TURN_RESULT="$TASK_DIR/turn-result.json"

# Also check common misplaced paths (agent sometimes writes to wario root or cwd)
for candidate in "$TURN_RESULT" "$WARIO_ROOT/turn-result.json" "./turn-result.json"; do
  if [[ -f "$candidate" ]] && [[ "$candidate" != "$TURN_RESULT" ]]; then
    mkdir -p "$(dirname "$TURN_RESULT")"
    mv "$candidate" "$TURN_RESULT"
    break
  fi
done

# Check if agent reported blocked
if [[ -f "$TURN_RESULT" ]]; then
  TURN_STATUS=$(jq -r '.status // "done"' "$TURN_RESULT" 2>/dev/null || echo "done")
  if [[ "$TURN_STATUS" == "blocked" ]]; then
    TURN_MSG=$(jq -r '.message // "waiting for input"' "$TURN_RESULT" 2>/dev/null || echo "")
    echo "🛑 Wario: Agent blocked — $TURN_MSG" >&2
    rm -f "$STATE_FILE"
    exit 0  # Allow exit
  fi
fi

# Check max iterations
NEXT=$((ITERATION + 1))
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $NEXT -gt $MAX_ITERATIONS ]]; then
  echo "🛑 Wario: All $MAX_ITERATIONS iterations complete for $ISSUE_KEY." >&2
  rm -f "$STATE_FILE"
  exit 0  # Allow exit
fi

# Update iteration count in state file
jq --argjson n "$NEXT" '.iteration = $n' "$STATE_FILE" > "${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "$STATE_FILE"

# --- Load iteration prompts from markdown file ---

PROMPTS_FILE="$WARIO_ROOT/prompts/iteration-prompts.md"

# Extract a section between "## <name>" and the next "## " (or EOF)
extract_section() {
  local section="$1"
  sed -n "/^## ${section}$/,/^## /{ /^## ${section}$/d; /^## /d; p; }" "$PROMPTS_FILE"
}

CHECKLIST=$(extract_section "Checklist")

if [[ $NEXT -eq 1 ]]; then
  PHASE_PROMPT=$(extract_section "First")
elif [[ $NEXT -ge $MAX_ITERATIONS ]]; then
  PHASE_PROMPT=$(extract_section "Final")
else
  PHASE_PROMPT=$(extract_section "Middle")
fi

# Substitute {{N}} and {{MAX}} placeholders
PHASE_PROMPT="${PHASE_PROMPT//\{\{N\}\}/$NEXT}"
PHASE_PROMPT="${PHASE_PROMPT//\{\{MAX\}\}/$MAX_ITERATIONS}"

PROMPT="${PHASE_PROMPT}

${CHECKLIST}"

# Block exit and re-feed the iteration prompt
jq -n \
  --arg reason "$PROMPT" \
  --arg msg "🔄 Wario iteration $NEXT/$MAX_ITERATIONS for $ISSUE_KEY" \
  '{
    "decision": "block",
    "reason": $reason
  }'

exit 0
