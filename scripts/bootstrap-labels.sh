#!/usr/bin/env bash
# One-time label bootstrap. Run LOCALLY with your own gh auth.
# Creates only — never edits or deletes an existing label.
set -euo pipefail
REPO="${REPO:-0xMiden/wallet}"

create() {
  local name="$1" color="$2" desc="$3"
  if gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' | grep -Fxq "$name"; then
    echo "exists, skipping: $name"
  else
    gh label create "$name" --repo "$REPO" --color "$color" --description "$desc"
    echo "created: $name"
  fi
}

create "source:in-app-feedback" "0E8A16" "Filed from the in-app feedback form by an anonymous reporter"
create "pipeline:v2"            "C5DEF5" "Drafted by miden-feedback-v2"
create "triage:auto-deduped"    "FBCA04" "Absorbed one or more duplicate reports"
create "triage:needs-review"    "D93F0B" "Classifier was uncertain; awaiting human triage"
create "recurring"              "B60205" "Report count crossed the recurrence threshold"

for p in android mobile extension; do
  create "platform:$p" "1D76DB" "Affects the $p build"
done

for c in NTL_TIMEOUT STUCK_NOTE BALANCE_MISMATCH MISSING_PRIVATE_NOTE CONSUME_STUCK \
         SYNC_CURSOR_RESET NODE_UNREACHABLE TX_SUBMIT_FAILED PROVE_TIMEOUT \
         IMPORT_EXPORT_FAILED BIOMETRIC_AUTH_FAILED UI_RENDER_DEFECT; do
  create "err:$c" "5319E7" "QA error taxonomy: $c"
done

echo
echo "Done. This script never runs 'gh label edit' or 'gh label delete'."
echo "Narrow your Claude Code allowlist to match:"
echo '  allow:   Bash(gh label create *), Bash(gh label list *)'
echo '  confirm: gh label delete, gh label edit'
