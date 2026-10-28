# Private Excalidraw Workspace — Todo Follow-up & Verification Report

## 1. Summary of Verification Results

> Historical verification summary. The repository-wide audit dated 2026-10-26 in section 4 supersedes any implication below that the complete application has no outstanding defects.

A full source code audit, TypeScript type check, and automated testing suite have been conducted across all 10 core phases defined in `implement_plan.md` and `CHECKLIST.md`.

| Phase | Domain | Status | Key Implementation Files |
|---|---|---|---|
| Phase 1 | Architecture & Foundation (Next.js 14, Node 24 `node:sqlite`, `/data` volume, Dockerfile, docker-compose) | ✅ **Completed & Verified** | `package.json`, `Dockerfile`, `docker-compose.yml`, `src/lib/config.ts` |
| Phase 2 | Database Schema & Migrations (7 tables, WAL mode, foreign keys ON, indexes) | ✅ **Completed & Verified** | `src/lib/db.ts`, `src/lib/types.ts` |
| Phase 3 | Authentication & User Management (bcrypt hashing, cookie sessions, Admin bootstrap, Admin user management) | ✅ **Completed & Verified** | `src/lib/users.ts`, `src/lib/passwords.ts`, `src/app/api/auth/*`, `src/app/api/admin/users/*` |
| Phase 4 | Document Management & Permissions (3-level permissions, atomic ownership transfer, Trash soft delete, permanent delete & file GC) | ✅ **Completed & Verified** | `src/lib/documents.ts`, `src/lib/trash.ts`, `src/app/api/documents/*` |
| Phase 5 | Excalidraw Editor, Storage & Versions (3s debounce auto-save, 5min snapshot policy, instant manual save, 20 versions rolling limit, PNG thumbnails) | ✅ **Completed & Verified** | `src/lib/versions.ts`, `src/lib/thumbnails.ts`, `src/components/ExcalidrawCanvas.tsx`, `src/app/documents/[id]/EditorClient.tsx` |
| Phase 6 | Attachment & Asset Management (`/data/attachments/<docId>/`, version-safe retention policy) | ✅ **Completed & Verified** | `src/lib/attachments.ts`, `src/app/api/attachments/*` |
| Phase 7 | Sharing & Read-Only Viewer (VIEWER user sharing, anonymous public share links with expiration/rotation, read-only viewer mode) | ✅ **Completed & Verified** | `src/lib/share_links.ts`, `src/app/share/[token]/*`, `src/app/api/share/*` |
| Phase 8 | Import / Export (Standard `.excalidraw` format compatibility) | ✅ **Completed & Verified** | `src/lib/exc_io.ts`, `src/app/api/documents/import/*`, `src/app/api/documents/[id]/export/*` |
| Phase 9 | Dashboard UI & Admin Mode (My Documents, Shared With Me, Trash, Admin Mode management panel) | ✅ **Completed & Verified** | `src/app/dashboard/DashboardClient.tsx`, `src/app/dashboard/AdminPanel.tsx` |
| Phase 10 | Automated Test Suite (20 MVP Success Scenarios with Vitest) | ✅ **Completed & Passed** | `tests/auth.test.ts`, `tests/documents.test.ts`, `tests/versions.test.ts`, `tests/share.test.ts`, `tests/thumbnails.test.ts`, `tests/export_import.test.ts` |

---

## 2. Completed Test Suite Coverage

The automated test suite (`npm test`) verifies all 20 success criteria from Section 28 of `implement_plan.md`:

- [x] **Scenario 1-2**: Docker Compose startup and admin auto-bootstrap via `ADMIN_USERNAME` & `ADMIN_PASSWORD` (no duplicate overwrite).
- [x] **Scenario 3**: Administrator creates new user accounts (`createUser`); public self-registration disabled.
- [x] **Scenario 4-5**: User sign-in (`createSession`, cookie auth) and Dashboard view rendering.
- [x] **Scenario 6-7**: Creating new Excalidraw documents (`createDocument`, initial OWNER, private by default).
- [x] **Scenario 8**: Debounced auto-save (`updateScene` updating current scene without redundant snapshot creation).
- [x] **Scenario 9**: Manual save (`createSnapshotFromDoc` / `/api/documents/[id]/save` creating instant recovery snapshot).
- [x] **Scenario 10**: Persistent session and document reload after sign-out and sign-in.
- [x] **Scenario 11**: Version history snapshot rollback (`restoreVersion` committing as a new current state snapshot).
- [x] **Scenario 12**: Uploading image attachments (`storeAttachment`) and preserving them across version restores.
- [x] **Scenario 13**: Trash lifecycle (`softDelete`), restoration (`restoreDocument`), and permanent deletion with file GC (`permanentDelete`).
- [x] **Scenario 14**: User-to-user document sharing with `VIEWER` permission (`addMember`).
- [x] **Scenario 15**: Enforcement of read-only access for `VIEWER` users (`requireWrite` prevention, `requireRead` permission).
- [x] **Scenario 16**: Anonymous read-only share link creation, expiration date validation, token regeneration (rotation), and revocation.
- [x] **Scenario 17**: Public read-only access via share link token without requiring login (`getValidShareLinkByToken`).
- [x] **Scenario 18**: Standard `.excalidraw` JSON file export and import (`exportSceneAsExcalidrawJson`, `importExcalidrawJson`).
- [x] **Scenario 19**: Full data persistence across restarts under `/data` (`app.db`, `attachments/`, `thumbnails/`).
- [x] **Scenario 20**: Admin Mode system-wide document management, user management, and atomic ownership transfer (`transferOwnership`).

---

## 3. Verification Commands

```bash
# Run all automated tests
npm test

# Run TypeScript type verification
npm run typecheck

# Build production bundle
npm run build
```

## 4. Repository-wide Ponytail audit — 2026-10-26

What this repo does: Self-hosted drawing documents, version history, sharing, and Deck-based presentations. This audit assumes one server process with local SQLite storage, used by an individual or small team, including simultaneous browser tabs. It does not assume a multi-server deployment.

Scope: Inventoried all 178 tracked files: 92 source files, 41 test/support files, 25 documentation/evidence files, and 20 configuration, asset, package, or deployment files. Checked source entry points and references, including Next.js file conventions, dynamic startup imports, and ambient declarations. Read the main authentication, authorization, persistence, attachment, restore, and lease paths; inspected selected portions of the larger editor and presentation components. This was an audit, not an implementation pass. Only this existing report was edited.

### Must fix

1. **Restoring the oldest retained image version can delete its image permanently** (`src/lib/versions.ts:427`, `src/lib/versions.ts:136`, `src/lib/attachments.ts:478`).
   - **What this is:** Restore first creates a recovery snapshot of the current document. Snapshot insertion trims ordinary history to 20 versions and collects unused attachment files.
   - **Problem:** With 20 ordinary snapshots, restore the oldest snapshot whose image occurs nowhere else. Creating the recovery snapshot removes the selected version and its image before the selected scene is applied. Reproduction threw `Attachment file not found for image element: oldimage`; SQL rollback restored the attachment row, but the physical file was gone.
   - **Fix:** Keep the selected restore scene protected until it becomes current. Run history trimming and physical attachment deletion only after the restore succeeds; defer physical deletion until the outer transaction commits. Add one regression covering the 20-version boundary with a unique image.
   - **If we skip it:** A failed restore can destroy the only image bytes even though the database rolls back.

2. **Deck and standalone document leases allow simultaneous writes to the same page** (`src/lib/edit_lease.ts:166`, `src/lib/deck_edit_lease.ts:110`, `src/lib/versions.ts:25`).
   - **What this is:** A Deck page uses a backing document. Deck and standalone document editing have separate lease tables and save authorization branches.
   - **Problem:** Acquired a Deck lease for client A and a document lease for its backing page for client B. Both returned `acquired`, and both `handleAutoSave` calls succeeded. Each lease only checks its own scope, so one save overwrites the other. Hiding backing documents from the dashboard does not prevent direct document/API access.
   - **Fix:** Route backing-page write authorization through its Deck lease and reject standalone document lease acquisition for Deck pages. Apply the same rule to restore and other scene mutation paths; do not introduce another locking system. Cover the cross-scope case with one regression.
   - **If we skip it:** Different tabs can overwrite the same page while both appear to hold valid exclusive editing rights.

3. **Any signed-in user can read another user's private thumbnail** (`src/app/api/thumbnails/[...path]/route.ts:20`).
   - **What this is:** The thumbnail endpoint returns document and version preview PNGs from disk.
   - **Problem:** It checks login and path containment but never checks access to the owning document. A session belonging to an unrelated user fetched the owner's thumbnail and received HTTP 200. Knowledge of the document/thumbnail ID is sufficient; its randomness does not replace authorization.
   - **Fix:** Resolve the owning document from the stored thumbnail path and enforce its read permission before returning bytes. Test both current and version thumbnails with an unrelated user's session.
   - **If we skip it:** Private drawing content remains visible through its preview even when the full document is forbidden.

### Should fix

4. **Docker copies local data and unnecessary files into the builder** (`Dockerfile:13`).
   - **What this is:** The builder uses `COPY . .`, and the repository has no `.dockerignore`.
   - **Problem:** A local build context can include `.env`, `data/`, `.git/`, `.next/`, local `node_modules/`, and tool state. Host dependencies can overlay the Linux dependencies installed in the earlier stage. Local credentials and document data enter the builder/cache unnecessarily. This is a static finding; no Docker build was run and no claim is made that those files occur in the final runner image.
   - **Fix:** Add a small `.dockerignore` excluding secrets, local data, host dependencies, generated output, Git metadata, and tool state.
   - **If we skip it:** Local builds send extra data to the builder and can become dependent on host files.

5. **Quick-start credentials disagree with production bootstrap** (`README.md:75`, `.env.example:8`, `docker-compose.yml:11`, `src/lib/users.ts:99`).
   - **What this is:** README and the environment example advertise `admin1234!`; Compose falls back to `change-me-please`.
   - **Problem:** Without an environment override, production accepts the shared Compose fallback, which differs from the README. With the example `admin1234!` in `.env`, a fresh production database rejects bootstrap. The current local development account working does not establish that a fresh production setup works.
   - **Fix:** Require an explicit production `ADMIN_PASSWORD` in Compose, and document that the development seed password is rejected for fresh production bootstrap. Explain that existing accounts are not overwritten by environment changes.
   - **If we skip it:** Fresh deployments either start with an advertised shared fallback or fail with the documented development password.

6. **Unused exports, state, and configuration add maintenance work** (`src/lib/documents.ts:269`, `src/lib/trash.ts:83`, `src/lib/config.ts:44`, `src/app/documents/[id]/EditorClient.tsx:191`).
   - **What this is:** Earlier helpers and editor state remain after their callers disappeared.
   - **Problem:** Whole-tree reference searches found no callers for `isSceneReferencingAttachment`, `isAnySnapshotReferencingAttachment`, `requireOwnerAndPurge`, `CreateSnapshotOptions`, or `Authed`. `forceDeleteAttachment` has only an unused import; `AUTO_INTERVAL` has only a historical plan reference. `sessionSecret` is generated and advertised in `.env.example` but never consumed. `previewVersion` and its setter are unused. Extra compiler checks reported 26 unused declarations/imports across source and tests; required route signature parameters must not be deleted blindly.
   - **Fix:** Delete confirmed dead declarations and their unused imports. Remove the unused secret setting/example. Remove the unused `initialUpdatedAt` prop and its two callers together if retaining the current fresh-server-scene recovery flow. Keep used state values such as `isDeleted`; only its setter is unused.
   - **If we skip it:** Readers continue tracing behavior and configuration that have no effect.

### Nice to have

7. **Two tracked assets can be removed** (`src/app/icon.svg:1`, `public/.gitkeep`).
   - **What this is:** The app stores the same SVG in `src/app/icon.svg` and `public/favicon.svg`, plus an empty file originally used to keep `public/` in Git.
   - **Problem:** SHA-256 hashes of the SVGs are identical. Layout and manifest explicitly reference `/favicon.svg`. `icon.svg` is also a Next.js convention asset, so it is used implicitly, but a second identical icon is unnecessary. `public/` already contains a tracked asset, so `.gitkeep` serves no purpose.
   - **Fix:** Keep `public/favicon.svg` as the canonical asset and remove `src/app/icon.svg` and `public/.gitkeep`. Verify rendered metadata after cleanup.
   - **If we skip it:** Icon edits can diverge between two copies; the empty marker adds clutter.

### File necessity decisions

| Files or group | Decision | Reason |
| --- | --- | --- |
| `src/` runtime modules and routes | Keep, except the duplicate icon above | No wholly disconnected runtime module was established. `src/lib/init.ts` is dynamically imported by instrumentation. |
| `src/types/sqlite.d.ts` | Keep | Ambient declaration included by TypeScript; installed Node types are version 20 while the application uses `node:sqlite`. Import-only analysis would misclassify it. |
| `next-env.d.ts`, framework/config files, package manifest and lockfile | Keep | Framework, type checking, CSS processing, dependency installation, or deployment inputs. A lockfile is necessary for the current `npm ci` workflow. |
| Five runtime dependencies | Keep | Excalidraw, Next.js, React, React DOM, and password hashing each have actual runtime use. No replacement dependency was proposed. |
| `tests/` | Keep | Regressions cover different lease, save, recovery, attachment, and presentation cases. Similar filenames alone are not grounds to delete tests. Several UI checks inspect source strings, so passing them is not equivalent to browser interaction validation. |
| `scripts/verify_url_history.mjs` and evidence JSON | Keep | Referenced by `CHECKLIST.md`; provides browser verification beyond the Node test suite. Not rerun in this audit. |
| 25 documentation/evidence files | Keep as history; distinguish current status | Product designs, implementation plans, and previous verification are context, not runtime dependencies. Do not treat an old completed checklist as evidence for untested paths. This audit reuses the existing follow-up document. |
| `public/.gitkeep`, `src/app/icon.svg` | Removal candidates | Empty marker and duplicate asset; no files were deleted during audit. |
| `.next/`, `node_modules/`, `*.tsbuildinfo` | Generated, not application source | Re-creatable output/dependencies; not tracked and not deleted. Dependency storage changes should use the requested shared pnpm/uv approach when separately undertaken. |
| `data/`, `.env` | Preserve | Actual user data and local settings; not disposable cleanup targets. |
| `.orca/`, `.my-orch/`, `.freebuff/` | Preserve unless their owner confirms disposal | Local tooling/state, not tracked runtime modules. Old state is not enough evidence to delete active agent/tool files. |

### Verification and limits

- `npm test`: **39 test files, 318 tests passed**, exit 0.
- `npm run typecheck`: passed, exit 0.
- Extra diagnostic: `tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false`: exit 1, **26 unused declaration/import diagnostics**. These flags are not part of the current normal typecheck.
- Isolated reproductions used new operating-system temporary `DATA_DIR` directories and the installed local `tsx` loader. They did not open or modify workspace `data/`. Reproduced findings 1–3 against the real server helpers/thumbnail route; the two save calls in finding 2 both succeeded.
- `next lint`: exited 1 after showing the initial ESLint configuration prompt. No linter is configured and no lint setup was accepted; do not count lint as passed.
- No packages installed, no application code changed, no files deleted, no commit/push, and **no build performed**.

Verdict: Fix the destructive restore ordering, overlapping lease scopes, and private thumbnail access before calling the entire application release-ready. Existing tests passing does not cover these reproduced failures.

Lean: Approximately **100 source/asset lines and 2 tracked files** can be removed through the confirmed dead declarations and duplicate asset; **0 runtime dependencies** identified for removal. Estimate excludes deleting tests, product features, historical documentation, or generated local files. `tsx` is not invoked by committed scripts, but was useful for the isolated audit and is not treated as a confirmed removal.

Not checked: Production build, Docker execution/image inspection, live production state, a fresh browser/iPad/Pencil pass, external dependency advisories, multi-process deployment, and a line-by-line reread of every historical plan or every line of the large UI components. All tracked paths were inventoried; the report does not claim exhaustive execution of every file.

## 5. Audit implementation — 2026-10-28

User authorized implementation of the seven findings. Apply the existing audit fixes in this workspace; no new dependencies, build, deployment, or commits are required. Use this existing document as the implementation plan and progress record.

Architecture: Keep existing SQLite transactions and lease tables. Defer destructive file cleanup until the outer transaction commits, so rollback cannot lose attachment bytes. Backing documents require their owning Deck lease for scene writes and restores. Thumbnail reads enforce the owning document's permission.

- [x] Add failing regressions to `tests/versions.test.ts` for oldest-image restore and outer-transaction rollback preserving files/history.
- [x] Add failing regressions to `tests/deck_edit_lease.test.ts` for cross-scope acquisition/writes/restores, including pre-existing document credentials.
- [x] Add failing route checks to `tests/thumbnails.test.ts` for current/version previews, unrelated sessions, and shared access.
- [x] Fix cleanup at the existing transaction boundary (`db.ts`, `attachments.ts`, `versions.ts`); verify focused tests.
- [x] Enforce Deck scope in document leases and version restore; pass Deck credentials through baseline reset and embedded history restore. Update affected baseline tests and verify focused tests.
- [x] Resolve thumbnail ownership from stored paths and enforce read access; verify focused tests.
- [x] Add `.dockerignore`; require an explicit production password in Compose and align README/environment example.
- [x] Remove confirmed dead declarations/imports/state and duplicate assets. Preserve local `.env`, user data, tool state, existing dependencies, and useful regression tests.
- [x] Run the full test suite, normal and unused-code type checks, and diff checks. Update results here. No build.

Review focus: nested rollback must not delete files; normal committed cleanup must still happen; old standalone credentials must not bypass Deck fencing; Deck baseline/history restore must still work; authorized users must retain thumbnail access while unrelated users and revoked memberships cannot reuse cached responses.

### Implementation outcome

All seven audit findings are addressed in the working tree. Section 4 is preserved as the original evidence; its outstanding-fix verdict is superseded by this implementation record.

- Storage: the existing transaction wrapper queues attachment GC and trimmed-thumbnail removal until the outer commit. Rollback drops those actions. Standalone snapshot insertion also participates in a transaction. The oldest unique image survives both a successful restore and an aborted outer transaction; committed retention still removes unreferenced resources, as verified by the existing import/export GC regression.
- Lease scope: document lease validation rejects Deck backing pages with `DECK_LEASE_REQUIRED`, fencing both new acquisitions and previously issued credentials. Autosave, manual save, recovery, and history restore share authorization. Embedded history restore sends Deck scope; baseline reset requires Deck credentials inside the transaction. Removed the old restore-without-lease wrapper and its unused active-document-lease helper.
- Thumbnails: stored current/version paths resolve their owning document before serving bytes. Unrelated users receive 403; revoked membership takes effect on the next request. Successful responses use `private, no-store`. Administrator asset reads retain the existing attachment-route policy.
- Deployment: `.dockerignore` excludes local secrets, data, host dependencies, generated output, and tool state. Compose requires an explicit password. README and `.env.example` distinguish development fallback credentials from production bootstrap and explain that existing accounts are unchanged. Local `.env` and user data were preserved.
- Cleanup: removed duplicate `src/app/icon.svg` and empty `public/.gitkeep`; retained `public/favicon.svg` and its explicit layout/manifest references. Removed confirmed dead exports, unused session-secret/port configuration, unused editor props/state, and unused test imports/locals while preserving side effects and assertions. Dependencies and package lock are unchanged.

Verification on 2026-10-28:

| Check | Result |
| --- | --- |
| Pre-fix regressions | 5 failed as expected: restore/rollback, cross-scope acquisition/old credentials, thumbnail access/cache policy |
| Full `npm test` after fixes | 39 files, **324 tests passed**, exit 0; includes embedded Deck history restore and 10-page baseline reset |
| `npm run typecheck` | Passed, exit 0 |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Passed, exit 0; no remaining unused-local/import diagnostics |
| `git diff --check` | Passed |
| Independent read-only review | No blockers; checked related callers, nested cleanup, lease scope, thumbnail authorization, and configuration |

Ruling: reuse the existing audit/follow-up document for the plan and results. User requested implementation, so proceeded inline without another approval round. No dependencies were installed. No build, Docker execution, browser/iPad validation, commit, push, or deployment was performed. Docker is unavailable in this shell, so its configuration was reviewed statically. The pre-existing unconfigured lint script remains outside these seven fixes; no lint success is claimed.

## 6. Local squash integration — 2026-10-28

User requested squash-merging `feature/url-text-links` into `main` and leaving this workspace checked out on `main`. Include the URL canvas feature and all seven audit fixes. Commit the pending fixes on the source branch first, then use `git merge --squash` on `main` to produce one integration commit. The fetched `origin/main` and local `main` both point to `70445a1` before integration. Verify the source and merged trees with the full test suite. No build or remote push is part of this request.

Integration verification: the source branch was committed as `b6c0879` after all 324 tests passed. The conflict-free squash result on `main` passed all 324 tests (39 files), `npm run typecheck`, the additional unused-code type check, and the staged diff check. The merged application tree matches the source branch; this integration record is the only subsequent documentation update. Leave the source branch available and the workspace on `main`. No build, push, or deployment was performed.
