#!/usr/bin/env bash
#
# Deploy, and make the deployment say which commit it is.
#
# WHY THIS EXISTS. Cloudflare recorded `Source: Unknown` for every deployment
# this Worker has ever had, with no tag and no message. On 2026-09-02 that made
# a simple question — "is master what is running?" — unanswerable except by
# comparing commit dates against deployment timestamps and reasoning about the
# gap. That is inference, not a fact, and it is not good enough for a service
# that files public issues on someone else's repository.
#
# Three records, because they fail in different ways:
#
#   --tag       the short SHA, shown in `wrangler deployments list`. This is
#               the field that was empty.
#   --message   the SHA plus the commit subject, for a human reading the
#               dashboard who should not have to look the hash up.
#   --var       COMMIT_SHA injected into the Worker, so /health reports the
#               commit it is RUNNING. The other two describe what was uploaded;
#               only this one can be checked from outside, without dashboard
#               access, against the thing actually serving traffic.
#
# Verified against wrangler's source before use: CLI vars are merged onto the
# bindings built from wrangler.jsonc, not substituted for them. `--var` cannot
# drop PUBLISH_ENABLED or the caps.
#
# A DIRTY TREE IS REFUSED. A deployment tagged with a commit that does not
# describe the code deployed is worse than an untagged one: it is a wrong
# answer wearing the costume of a right one. Override with ALLOW_DIRTY=1 only
# when you intend an untraceable deploy and have said so out loud.
#
# Usage:  npm run deploy
#         ALLOW_DIRTY=1 npm run deploy     (deliberately untraceable)
set -euo pipefail

cd "$(dirname "$0")/.."

WORKER_NAME="${WORKER_NAME:-miden-feedback-v2}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "refusing: not a git repository, so nothing can be traced to a commit" >&2
  exit 1
fi

SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --format=%s)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  if [ "${ALLOW_DIRTY:-0}" != "1" ]; then
    echo "refusing: the working tree has uncommitted changes." >&2
    echo "  Deploying now would tag the build ${SHORT}, which is NOT what would ship." >&2
    echo "  Commit them, or re-run with ALLOW_DIRTY=1 to deploy untraceably on purpose." >&2
    git status --short >&2
    exit 1
  fi
  echo "WARNING: deploying a DIRTY tree. The tag ${SHORT} does not describe what ships."
  SUBJECT="[dirty] ${SUBJECT}"
fi

# Not fatal: a hotfix may legitimately go out before it is pushed. But a SHA
# nobody else can resolve is a weak record, and the operator should know.
if ! git branch -r --contains HEAD 2>/dev/null | grep -q .; then
  echo "WARNING: ${SHORT} is not on any remote branch — nobody else can resolve this SHA."
fi

echo "Deploying ${WORKER_NAME}"
echo "  commit  ${SHA}"
echo "  branch  ${BRANCH}"
echo "  subject ${SUBJECT}"
echo

exec npx wrangler deploy \
  --name "${WORKER_NAME}" \
  --tag "${SHORT}" \
  --message "${SHA} ${SUBJECT}" \
  --var "COMMIT_SHA:${SHA}" \
  "$@"
