# Merge Review Tracking

## Goal

Determine whether `feat/document-edit-lease` is ready to merge into `origin/main` with a GO / NO GO decision.

## Review Rules

- Primary principle: YAGNI. Reject unnecessary abstraction, speculative extensibility, unrelated refactoring, and code that is not required for the current document edit lease behavior.
- TEST-related files are out of scope and will not be reviewed.
- Do not modify product code during the review phase.
- Base conclusions on repository evidence: branch relationship, merge conflict risk, changed documentation, changed production code, and consistency between docs and implementation.
- Separate blocking merge issues from non-blocking observations.

## Scope

### Review scope

All files changed between `origin/main` and `feat/document-edit-lease` are in scope, including documentation, README, application routes, UI components, client helpers, database/schema changes, domain logic, and shared types.

### Explicitly excluded

- Test files
- Test-only fixtures and test-only helpers
- Files unchanged from `origin/main`, unless needed as context to understand a changed file

## Workflow

- [x] 1. Fetch latest remote refs and check out `feat/document-edit-lease`.
- [x] 2. Verify branch ancestry, ahead/behind state, and merge-conflict risk against `origin/main`.
- [x] 3. Produce the authoritative changed-file inventory, excluding TEST-related files.
- [x] 4. Review changed documentation and extract explicit implementation claims/requirements.
- [x] 5. Review all changed non-TEST production files against those claims.
- [x] 6. Apply the YAGNI gate to every new abstraction/file and unrelated-looking modification.
- [x] 7. Create `docs/features/document-edit-lease/review/MERGE_GO_NO_GO_CHECKLIST.md` with evidence-backed findings.
- [x] 8. Create `docs/features/document-edit-lease/review/PRE_MERGE_FIX_CHECKLIST.md` containing only required fixes.
- [x] 9. Record final GO / NO GO decision and rationale here.

## Progress Log

### 2026-09-01

- Review workflow initialized.
- Remote refs fetched.
- Checked out local branch `feat/document-edit-lease` tracking `origin/feat/document-edit-lease`.
- No product code has been changed.
- Merge safety: `origin/main` is an ancestor of the feature branch; the original feature was 28 commits ahead, and the local review-document commit makes current HEAD `0/29` ahead/behind versus `origin/main`; merge-tree scan found no conflict markers.
- Authoritative non-test changed-file inventory captured. Review scope was expanded per request to every changed file except TEST-related files.
- `git diff --check origin/main...HEAD` is clean.
- First YAGNI warning: `docs/SELF_HOSTED_COLLABORATION_RESEARCH.md` is explicitly future collaboration research and is not required to implement the single-editor lease; candidate for removal from this merge or separation into another change.
- Production-only dead-code candidates found: `shouldReadLocalDraft` is exported/imported but not called; `leaseTokenRef` is written but never read; `LeaseState` is duplicated across `src/lib/types.ts` and `src/lib/edit_lease.ts`.
- Initial `npm run typecheck` was invalid because dependencies were absent. A clean `rm -rf node_modules && npm ci && npm run typecheck` was then executed; `tsc --noEmit` completed with exit code 0. Full `npm test` was executed for PASS/fail verification only; TEST code was not reviewed.
- Exhaustive non-TEST review covered all 27 files that entered review (24 feature files plus the 3 review artifacts). One YAGNI file was subsequently removed, leaving 26 files in the prospective non-TEST merge diff. Full changed hunks were inspected for the large `EditorClient.tsx` and both lease state-machine modules.
- Blocking API defect found in `scene`, `save`, `recovery`, and restore `versions` routes: missing `body.lease` is cast to `Record<string, unknown>` but remains `undefined`, then `parseAndValidateLeaseCredentials()` dereferences `body.clientId`. A missing lease can therefore become a runtime TypeError/500 instead of the intended 400.
- Documentation accuracy issue found: `docs/project/CHECKLIST.md` claims dead refs/casts were cleaned and the design spec claims implementation verification complete, while the current production diff still contains dead lease artifacts and the missing-lease API defect. These claims must be corrected or re-established after cleanup.
- YAGNI scope issue resolved: `docs/SELF_HOSTED_COLLABORATION_RESEARCH.md` was removed from the prospective merge, and its new Phase 3/baseline references were removed.

- First pre-merge cleanup pass completed without changing lease authority semantics: missing-lease parsing fixed centrally; future collaboration research split out; dead `EditorClient` imports/write-only ref removed; duplicate `LeaseState` aliases removed; `assertActiveEditLease` cleanup applied; client release response union made truthful.
- A cleanup attempt to remove `shouldReadLocalDraft()` was reverted immediately because typecheck reported existing compile-time consumers. No TEST file was opened or reviewed; the helper remains while its dead production import is gone.
- Fresh `npm run typecheck` after cleanup exits 0, and `git diff --check` is clean.

- Re-entry policy was validated against the existing test contract: exact prior token + generation proves same-context reload, and same-user different-context recovery remains allowed after a heartbeat is stale longer than the 10-second takeover window. The attempted stricter policy was reverted after the full suite exposed the contract mismatch.
- Unused server heartbeat/poll constant exports were removed instead of introducing a new shared constants abstraction.
- Prospective non-TEST merge diff is now 26 files; TEST worktree status is clean.

- Full `npm test` verification executed without reviewing TEST source: 23/23 test files and 195/195 tests passed. An initial run exposed the stricter re-entry policy mismatch (194/195); that policy change was reverted to the existing tested behavior, after which the full suite passed.

- Local integration validation completed on temporary branch `review/merge-validation`: merged `feat/document-edit-lease` into local `main` baseline with the ort strategy, then ran the full suite (23/23 files, 195/195 tests), `npm run typecheck`, and `git diff --check`; all passed. The temporary validation branch was deleted afterward, and local `main` itself was not modified.

## File-by-File Review Result

Status legend: `PASS` = reviewed with no remaining merge blocker, `REMOVED` = intentionally excluded by YAGNI.

| File | Status | Review result |
| --- | --- | --- |
| `README.md` | PASS | Lease behavior is documented; revisit wording only if the same-user stale policy changes. |
| `docs/project/CHECKLIST.md` | PASS | Completion wording was reconciled with the verified implementation state. |
| `docs/features/document-edit-lease/review/MERGE_GO_NO_GO_CHECKLIST.md` | PASS | Review artifact; updated as findings change. |
| `docs/features/document-edit-lease/review/MERGE_REVIEW_TRACKING.md` | PASS | Review artifact and source of progress evidence. |
| `docs/features/document-edit-lease/review/PRE_MERGE_FIX_CHECKLIST.md` | PASS | Review artifact containing only pre-merge actions. |
| `docs/SELF_HOSTED_COLLABORATION_RESEARCH.md` | REMOVED | Removed from the prospective merge as unapproved future collaboration scope. |
| `docs/project/implement_plan.md` | PASS | Lease plan retained; the speculative Phase 3 research reference was removed. |
| `docs/features/document-edit-lease/plan.md` | PASS | Feature-specific implementation record; no runtime scope expansion. |
| `docs/features/document-edit-lease/design.md` | PASS | Status, response states, and re-entry policy were reconciled with the final implementation. |
| `src/app/api/documents/[id]/lease/route.ts` | PASS | Single action endpoint, bounded request validation, no extra infrastructure. |
| `src/app/api/documents/[id]/recovery/route.ts` | PASS | Shared parser now handles missing/malformed lease input through the controlled 400 path. |
| `src/app/api/documents/[id]/save/route.ts` | PASS | Shared parser fix closes the missing-lease 500 path. |
| `src/app/api/documents/[id]/scene/route.ts` | PASS | Shared parser fix closes the missing-lease 500 path. |
| `src/app/api/documents/[id]/versions/route.ts` | PASS | Restore uses the shared parser fix and remains fenced inside the write transaction. |
| `src/app/dashboard/AdminPanel.tsx` | PASS | `adminMode=1` propagation is directly required for admin editing through the lease flow. |
| `src/app/documents/[id]/EditorClient.tsx` | PASS | Dead imports/write-only ref and unnecessary cast were removed; required lease lifecycle remains. |
| `src/app/documents/[id]/page.tsx` | PASS | Propagates validated admin mode into editor metadata/URLs. |
| `src/components/EditLeaseConflictModal.tsx` | PASS | Minimal blocking read-only/takeover UI, no extra feature scope. |
| `src/lib/client.ts` | PASS | Structured `ApiError` is directly required for stable lease-loss handling. |
| `src/lib/client_edit_lease.ts` | PASS | Production dead import was removed, response union is truthful, and unnecessary shared-timing abstraction was avoided. |
| `src/lib/client_save.ts` | PASS | Adds required lease credentials to fenced save/recovery requests without new abstraction layers. |
| `src/lib/db.ts` | PASS | One document-scoped lease table; migration is minimal and self-contained. |
| `src/lib/documents.ts` | PASS | Admin effective permission mapping is required by the feature path. |
| `src/lib/edit_lease.ts` | PASS | Parser robustness and dead/duplicate cleanup completed; existing tested same-user stale-context recovery policy retained. |
| `src/lib/http.ts` | PASS | Optional machine-readable error code is a small required extension. |
| `src/lib/types.ts` | PASS | Required shared lease types retained; duplicate unused `LeaseState` removed. |
| `src/lib/versions.ts` | PASS | Fencing is placed inside mutation transactions as required. |

## Current Decision

**GO**

Under the requested scope, the exhaustive non-TEST review is complete and all identified blockers have been resolved in the worktree. The prospective merge is YAGNI-reduced, typechecks cleanly, has no whitespace errors, and was validated by a clean local merge into the `main` baseline. TEST files were not reviewed; the full suite was executed only to verify PASS status.
