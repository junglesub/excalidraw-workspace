# Pre-Merge Fix Checklist

## Functional Correctness

- [x] `parseAndValidateLeaseCredentials` now accepts unknown/missing input and returns `null`; existing route guards convert missing/malformed lease credentials to HTTP 400 instead of runtime TypeError/500.
- [x] The missing-lease fix is centralized in the shared parser, so `scene`, `save`, `recovery`, and restore `versions` all use the same minimal validation path.
- [x] Corrected `docs/project/CHECKLIST.md` cleanup wording and changed the design-spec status so it no longer overstates automated verification in this review.

## Blocking YAGNI Cleanup

- [x] Removed `docs/SELF_HOSTED_COLLABORATION_RESEARCH.md` from this feature branch and removed its new Phase 3 link/baseline references.
- [x] Removed the unused `shouldReadLocalDraft` production import from `EditorClient.tsx`.
- [x] Removed the unused `StoredLeaseCredentials` type import from `EditorClient.tsx`.
- [x] Removed `leaseTokenRef` and its write-only assignments.
- [x] Kept `shouldReadLocalDraft()` as an existing compile-time contract after typecheck showed it is consumed outside production; removed only the dead production import. No TEST file content was inspected.
- [x] Removed the duplicate unused `LeaseState` aliases from production modules; typecheck remains clean.
- [x] Removed the unused DB local and replaced implementation-history commentary with the transaction invariant.

## Contract Cleanup

- [x] Extended the client lease response union with explicit `released` and `transferred` states so `releaseLease()` has a truthful contract.
- [x] Removed unused server exports for heartbeat/poll intervals. Server keeps only timing values it actually evaluates; the client keeps its simple 2s/1s timer values without adding a shared-constants abstraction.

## Product Decision

- [x] Existing tested product contract retained: a different context for the same user may recover after the holder heartbeat is stale longer than the 10-second takeover window; fresh holders remain protected and pending takeover is not clobbered.
- [x] Same-context reload uses exact prior token + generation proof; same-user different-context recovery is allowed only after the 10-second stale-heartbeat window, matching the existing test contract.
- [x] Documentation now states the same-user stale-context recovery exception explicitly so the 90-second TTL rationale is not overstated.

## Re-Verification

- [x] Full `npm test` pass verification: 23/23 files, 195/195 tests; TEST source was not reviewed.
- [x] `git diff --check` returns no errors after the cleanup worktree changes.
- [x] `origin/main` remains an ancestor and merge-tree reports no conflict markers.
- [x] Clean local dependency install completed and `npm run typecheck` passed with exit code 0. TEST code review remained out of scope; execution was performed only to verify PASS status.
- [x] Re-scanned the non-TEST production diff: dead editor imports/write-only ref and duplicate lease types are removed; speculative collaboration research is no longer in the prospective merge.
- [x] All non-TEST blockers identified by this review are resolved; GO/NO GO checklist updated to GO under the stated TEST-exclusion policy.
