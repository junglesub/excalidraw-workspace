# Private Excalidraw Workspace Implementation & Verification Checklist

Step-by-step implementation and quality verification checklist based on the `implement_plan.md` requirements and the 20 success criteria (Section 28).

---

## 1. Architecture & Project Foundation

- [x] **Tech Stack Selection & Project Initialization**
  - [x] Full-stack framework (Next.js 14 App Router + TypeScript + Tailwind CSS)
  - [x] SQLite driver — Node 24 built-in `node:sqlite` (zero native C++ build dependencies)
  - [x] `@excalidraw/excalidraw` dependency integration with dynamic import / client-only rendering
- [x] **Data Directory & Persistence Structure**
  - [x] Single persistent `/data` volume layout (`/data/app.db`, `/data/attachments/<doc-id>/`, `/data/thumbnails/`)
  - [x] Environment variable configuration for data path (`DATA_DIR=/data` or `./data`)
- [x] **Docker Deployment Environment**
  - [x] Multi-stage `Dockerfile` (lightweight Node runtime with standalone Next.js bundle)
  - [x] `docker-compose.yml` (single service, `./data:/data` volume mount, port mapping)

---

## 2. Database Schema & Migrations (Data Modeling)

- [x] **Database Schema Definition**
  - [x] `users`: id, username (unique), password_hash, role (`USER` | `ADMIN`), is_active, created_at, updated_at
  - [x] `documents`: id, title, owner_id (FK), scene (JSON), thumbnail_path, created_at, updated_at, deleted_at (soft delete)
  - [x] `document_members`: id, document_id (FK), user_id (FK), permission (`OWNER` | `EDITOR` | `VIEWER`), created_at, updated_at
  - [x] `document_versions`: id, document_id (FK), version_number, scene (JSON), thumbnail_path, created_by (FK), created_at, origin (nullable `VersionOrigin`)
  - [x] `attachments`: id, document_id (FK), file_name, file_size, mime_type, file_path, sha256, created_at
  - [x] `share_links`: id, document_id (FK, unique), token (unique), permission (`VIEWER`), expires_at (nullable), is_active, created_at
  - [x] `sessions`: id, user_id (FK), token, expires_at, created_at
- [x] **Migration & Initialization Routine**
  - [x] Automatic schema migration / initialization on server start
  - [x] Foreign key constraints (`PRAGMA foreign_keys = ON`) and WAL mode (`PRAGMA journal_mode = WAL`) enabled

---

## 3. Authentication & User Management

- [x] **Password Security & Session Authentication**
  - [x] Password hashing with `bcryptjs` (salt rounds 10) and secure verification
  - [x] HttpOnly, Secure, SameSite Cookie-based session management (login / logout)
  - [x] Request guards and interceptors (`requireUser`, `requireAdmin`)
- [x] **Initial Administrator Bootstrap**
  - [x] Inspect `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables on startup
  - [x] Create admin account only if no admin exists (prevents accidental password overwriting)
- [x] **User Management (Admin Only)**
  - [x] Admin-only user list API & UI
  - [x] Admin-only user creation API & UI (public registration disabled)
  - [x] Admin-only user activation/deactivation and deletion API
  - [x] Admin-only user password forced reset API
- [x] **Self-Service Features**
  - [x] Password change feature for authenticated users

---

## 4. Document Management & Permissions Engine

- [x] **Authorization Layer**
  - [x] 3-tier permission hierarchy (`OWNER`, `EDITOR`, `VIEWER`) validation logic
  - [x] Admin privilege separation (Normal Mode vs. Admin Mode)
    - [x] Normal Mode: Access only owned and shared documents
    - [x] Admin Mode: System-wide access to view, edit, delete, and reassign ownership of any document
- [x] **Document CRUD**
  - [x] Create new documents (creator becomes OWNER, private by default)
  - [x] Document renaming and metadata queries
  - [x] Atomic ownership transfer (OWNER -> new owner; previous owner retains EDITOR permission)
- [x] **Trash & Deletion Lifecycle**
  - [x] Soft delete (sets `deleted_at` timestamp and moves to Trash)
  - [x] Trash listing and document restoration
  - [x] Permanent deletion atomic transaction:
    - [x] Delete document record
    - [x] Delete version history records
    - [x] Delete memberships and share links
    - [x] Delete attachment references and garbage-collect unreferenced physical files

---

## 5. Excalidraw Editor, Storage & Version Management

- [x] **Excalidraw React Wrapper**
  - [x] `@excalidraw/excalidraw` canvas component rendering (`ExcalidrawCanvas.tsx`)
  - [x] Dark/light theme toggle and UI integration
  - [x] Edit mode (`OWNER` / `EDITOR`) vs. read-only viewer mode (`VIEWER` / public share link)
- [x] **Saving Pipeline (Auto-save & Manual Save)**
  - [x] **Auto-save**: 3-second debounce on canvas edit, updates current scene in DB (`/api/documents/[id]/scene`)
  - [x] **Auto-snapshot Policy**: Auto-save creates a recovery snapshot only when >= 5 minutes have elapsed since the last snapshot
  - [x] **Manual Save (snapshot-aware)**: 'Save' / `Ctrl+S` always reaches server; server compares normalized incoming scene with latest snapshot — if equal, no document update/snapshot and returns `Already saved`; otherwise creates exactly one `manual_save` snapshot (updating document only if incoming differs) and returns `Snapshot saved`; clean auto-save remains no-op
- [x] **Version History**
  - [x] Retains up to the 20 most recent snapshots per document (`MAX_VERSIONS = 20`)
  - [x] Version history drawer (snapshot list, timestamps, authors, thumbnails)
  - [x] Snapshot preview and rollback/restore (restore snapshots pre-restore current state with `restore` origin, then applies selected version as current)
- [x] **Thumbnail Generation & Caching**
  - [x] Live client canvas rasterization to PNG thumbnail on manual save and snapshot creation (`/data/thumbnails/<doc-id>.png`)
  - [x] Dashboard serves cached thumbnail images without client scene re-rendering (`/api/thumbnails/[...path]`)

---

## 6. Attachment & Asset Management

- [x] **Image Upload & Serving API**
  - [x] Excalidraw inserted images stored locally under `/data/attachments/<doc-id>/<file-id>`
  - [x] Metadata and document references recorded in `attachments` table
  - [x] Static file serving endpoint with session/share token authorization
- [x] **Version-Safe File Retention**
  - [x] Images deleted from current scene are preserved if referenced by any retained version snapshot
  - [x] Physical file deletion occurs only when the file is referenced neither by the active scene nor by any snapshot

---

## 7. Sharing & Read-Only Viewer

- [x] **User-Specific Sharing**
  - [x] Document OWNER shares document with specific users with `VIEWER` permission
  - [x] Member list management and permission revocation
- [x] **Public Share Links**
  - [x] Document OWNER generates an anonymous read-only share link (max 1 active link per doc)
  - [x] Optional expiration date configuration and enforcement
  - [x] Token rotation (regenerating immediately revokes previous token) and link deactivation
- [x] **Read-Only Viewer Page**
  - [x] Dedicated viewer page for unauthenticated or VIEWER users (`/share/[token]`)
  - [x] Pan and zoom navigation enabled; editing tools and saving disabled

---

## 8. Import / Export Compatibility

- [x] **Export Feature**
  - [x] Download document as standard `.excalidraw` JSON file compatible with official Excalidraw
- [x] **Import Feature**
  - [x] Upload `.excalidraw` file to create a brand new document owned by the uploader

---

## 9. Dashboard UI & Admin Mode

- [x] **Dashboard Layout & Navigation**
  - [x] **My Documents**: Grid/list of owned documents (search by title, thumbnails, last modified)
  - [x] **Shared With Me**: Documents shared by other users (`VIEWER` badge)
  - [x] **Trash**: Soft-deleted documents with individual Restore and Delete Forever actions
  - [x] **Admin Mode**: Dedicated toggle menu visible only to administrators
- [x] **Admin Mode Dashboard**
  - [x] Full user account management view (create, toggle active, reset passwords)
  - [x] System-wide document management view (inspect, edit, delete, reassign ownership)

---

## 10. Automated Tests & Quality Gate

- [x] **Unit & Integration Test Suite (Vitest)**
  - [x] **[Scenarios 1-2]** Docker Compose startup and admin auto-bootstrap (`tests/auth.test.ts`)
  - [x] **[Scenarios 3-5]** Admin user creation, authentication, and dashboard view (`tests/auth.test.ts`)
  - [x] **[Scenarios 6-8]** Document creation, editor integration, 3s debounce auto-save (`tests/documents.test.ts`)
  - [x] **[Scenarios 9-10]** Manual save snapshot and session reload persistence (`tests/documents.test.ts`)
  - [x] **[Scenarios 11-12]** Version snapshot restore and attachment preservation (`tests/versions.test.ts`, `tests/export_import.test.ts`)
  - [x] **[Scenario 13]** Document soft-delete to Trash and restore (`tests/documents.test.ts`)
  - [x] **[Scenarios 14-15]** VIEWER user sharing and write-prevention enforcement (`tests/documents.test.ts`, `tests/share.test.ts`)
  - [x] **[Scenarios 16-17]** Anonymous share link generation and unauthenticated access (`tests/share.test.ts`)
  - [x] **[Scenario 18]** Standard `.excalidraw` import / export integrity (`tests/export_import.test.ts`)
  - [x] **[Scenario 19]** Data persistence across restarts under `/data` (`tests/documents.test.ts`)
  - [x] **[Scenario 20]** Admin Mode system-wide document and user control (`tests/documents.test.ts`, `tests/auth.test.ts`)
- [x] **Build & Lint Verification**
  - [x] TypeScript type checking (`tsc --noEmit`) passing with 0 errors
  - [x] Production build (`npm run build`) passing cleanly
  - [x] Automated test suite (`npm test`) 100% passing (12 suites, 126 tests)

---

## 11. Local Draft Recovery Conflict (2026-08-31)

- [x] Load-time local/server mismatch requires an explicit writable-user choice.
- [x] The unselected version is snapshotted by default for both client and server choices.
- [x] VIEWER always sees server state without local draft access or deletion.
- [x] Empty-scene recovery, edit-to-undo cleanup, account isolation, and image recovery are covered.
- [ ] Browser manual verification (refresh with both choices, default checkbox/unchecked, retry after failure, image recovery without `/documents/undefined`, VIEWER isolation, account switching, malformed draft) — automated tests pass; manual browser scenarios not yet executed in this environment.

---

## 12. Version Origin Labels (2026-08-31)

- [x] Nullable `origin` column added via idempotent startup migration (`ALTER TABLE document_versions ADD COLUMN origin TEXT`); existing rows remain `NULL`
- [x] Legacy/null origin displays neutral `Legacy / unknown` badge
- [x] `VersionOrigin` type (`manual_save`, `auto_snapshot`, `restore`, `recovery_client_draft`, `recovery_server_version`) persisted per snapshot path
- [x] Manual save (`POST /save` → `manual_save`), auto snapshot (`PUT /scene` throttled → `auto_snapshot`), restore (`POST /versions?action=restore` snapshots pre-restore current → `restore`) record origins
- [x] Recovery snapshots distinguish discarded `Client draft` (`recovery_client_draft`) from discarded `Server version` (`recovery_server_version`)
- [x] Origin threaded through `insertSnapshot` / `createSnapshotFromScene` / `restoreVersion` / `resolveRecoveryConflict` and exposed via `listVersions` and `GET /api/documents/[id]/versions`
- [x] History drawer renders origin badge after `Version N` using existing `bg-gray-100` style; not encoded in scene JSON or thumbnail path
- [x] Focused TDD coverage: `tests/version_origin.test.ts` (legacy file migration with initializeSchema, each origin persistence, list/API exposure, badge markup) — full suite 126 tests, `npm run typecheck` clean

---

## 13. Snapshot-Aware Manual Save (2026-08-31)

- [x] Clean manual Save / `Ctrl+S` no longer silently returns; always reaches server
- [x] Server normalizes incoming, current, and latest via shared `scene_normalize` helper (sorted files, `viewBackgroundColor`, active-image filtering, hydration `dataURL` ignored) and compares
- [x] If incoming, current, and latest all equal (normalized): no `UPDATE documents`, no `INSERT document_versions`; returns `{ alreadySaved: true, snapshotCreated: false }` and client shows `Already saved`
- [x] Otherwise: creates exactly one `manual_save` snapshot; updates `documents` only when incoming differs from current; returns `{ alreadySaved: false, snapshotCreated: true }` and client shows `Snapshot saved`; regression ensures incoming==latest but current differs does not falsely return `Already saved`
- [x] Dirty manual save updates then snapshots; clean auto-save remains no-op with no request
- [x] Preserved: authorization, `compactSceneFiles` validation, snapshot cap (20), `VersionOrigin` labels, thumbnails, recovery behavior; no DB column or deps added; duplicated comparison removed via shared helper; TDD covers 4 manual paths incl. regression + `getManualSaveStatus`

---

## 14. Selectable Recovery Cards (2026-08-31)

- [x] Removed immediate `Use client draft` / `Use server version` buttons; Client draft and Server version rendered as accessible selectable cards (native buttons with `aria-pressed`, Enter/Space)
- [x] Initial selection none; clicking card selects it with visual hover plus selected `border-blue-600`/`bg-blue-50`/`ring`/`✓` and semantic `aria-pressed="true"`; summaries retained on cards
- [x] Preservation checkbox and retryable `role="alert"` error unchanged
- [x] Single bottom `Confirm selection` button disabled until selection exists or while `busy`; clicking it calls `onChoose` exactly with selected choice; busy prevents selection/confirmation changes
- [x] Maintained no Escape/backdrop close and editor load gate; no external deps or server change
- [x] Focused TDD: `tests/recovery_modal.test.ts` (4 tests) observes real modal markup and pure guard — no initial selection (`aria-pressed="false"`) with disabled `Confirm selection` and summaries, hover visual, busy disables, error `role="alert"`, and `canConfirmSelection`/`confirmRecoveryChoice` proves selected choice invokes `onChoose` once (selected `aria-pressed="true"`/`border-blue-600`/`bg-blue-50`/`✓` is implemented in component, not directly rendered in this small suite); full suite 126 tests, `npm run typecheck` clean

---

## 15. Restore Pre-State Snapshot (2026-08-31)

- [x] `restoreVersion` captures current scene and its thumbnail before replacement, snapshots that pre-restore state with `origin="restore"`, then applies selected version's scene as current and updates `documents.thumbnail_path` from restored version's thumbnail
- [x] No new snapshot of selected/restored target is created; preserves authorization, `compactSceneFiles` validation, atomic rollback, snapshot cap/GC, thumbnail safety
- [x] Focused TDD: `tests/versions.test.ts` and `tests/version_origin.test.ts` prove `v2` current → restore `v1` yields new snapshot of `v2` (not `v1`), document current `v1`, origin `restore`; full suite 126 tests, `npm run typecheck` clean

---

## 16. Document-Scoped Single-Editor Lease (2026-09-01)

- [x] SQLite `document_edit_leases` table (generation retained after release, takeover fields cleared atomically, `CREATE TABLE IF NOT EXISTS` migration)
- [x] Server state machine: `acquire`, `heartbeat` (2s), `request_takeover`, `poll_takeover` (1s), `release`, `assertActiveEditLease` with 90s expiry, 10s forced takeover, generation fencing, safe holder summaries (no token leakage)
- [x] Single lease API `POST /api/documents/[id]/lease` with 5 actions, bounded validation, stable codes `EDIT_LEASE_HELD`/`TAKEOVER_IN_PROGRESS`/`EDIT_LEASE_LOST`
- [x] Atomic fencing of `handleAutoSave`, `handleManualSave`, `resolveRecoveryConflict`, `restoreVersion` in same `BEGIN IMMEDIATE` transaction as write
- [x] Client transport: per-context `window.name` id (`getEditorContextId`), stored prior-credential helpers keyed by `{docId}:{contextId}` (`read/store/clearStoredLeaseCredentials`), `acquireLease`/`heartbeatLease`/`requestTakeover`/`pollTakeover`/`releaseLease`, `ApiError` with status/code, credentials in save/recovery payloads
- [x] Accessible `EditLeaseConflictModal` (role dialog, aria-modal, `already being edited`, `Open read-only`/`Take over editing`, busy disabled, error alert, no token leakage)
- [x] Editor load gate: writable users acquire before canvas mount or localStorage; VIEWER/deleted never touch localStorage or leases
- [x] Graceful handover: freeze canvas, cancel debounce, upload attachments, normal non-snapshot save, release/transfer, reload server scene, become read-only; forced takeover advances generation after 10s
- [x] Centralized `EDIT_LEASE_LOST` handling (cancel timers, retain draft, fetch latest scene, read-only banner), pagehide best-effort release via `sendBeacon`/`keepalive`
- [x] Title rename, sharing/permission, attachment upload, import, Trash, restore from Trash remain outside lease; no WebSocket/SSE/Redis/CRDT/queue/deps
- [x] Focused TDD: `tests/edit_lease.test.ts`, `tests/edit_lease_route.test.ts`, `tests/edit_lease_fencing.test.ts`, `tests/client_edit_lease.test.ts`, `tests/edit_lease_modal.test.ts`, updated `tests/versions.test.ts`/`tests/version_origin.test.ts`/`tests/recovery.test.ts`/`tests/export_import.test.ts`/`tests/client_save_pipeline.test.ts`; full suite 155 tests, `npm run typecheck` clean
- [ ] Browser manual verification (two writable users/tabs: conflict modal, Open read-only stays read-only and never touches draft, Take over graceful flush and read-only, forced takeover after 10s, stale tab cannot save, draft retained after loss, new editor reloads server scene before draft, VIEWER never sees modal or touches draft, deleted view read-only, title/share still work outside lease) — automated tests pass; manual browser scenarios not yet executed in this environment

---

## 17. Lease Stabilization (2026-09-01)

- [x] Restore serialized via save pipeline (freeze mutation via isRestoringRef, cancel debounce, waitForNoSaving, GET after success, only clear draft after success, finally recover)
- [x] Cancelled initial acquire and normal SPA unmount best-effort release once without React state mutation (sendBeacon/keepalive, no setState after unmount)
- [x] Single-flight takeover polling (takeoverPollInFlightRef guard, all results/errors settled, no interval overlap)
- [x] Thrown acquire 409 and latest-GET failure render safe readonly SSR scene with visible accessible error and existing retry button; no localStorage/edit until new acquire+GET
- [x] pollEditTakeover expiry fix: expired holder returns EDIT_LEASE_LOST instead of acquired
- [x] AdminMode: valid ADMIN + adminMode true => writable EDITOR meta + normal lease acquisition (fixed documentToMeta admin->VIEWER bug), propagated from page searchParams through EditorClient URLs, lease and fenced mutations
- [x] Client regressions replaced with production-connected tests (lease_stabilization_regressions, handoff serialization) rather than copied constants
- [x] Lifecycle cleanup completed for that stabilization pass; full suite 169 tests, typecheck 0, git diff --check 078659a..HEAD 0

## 18. Re-entry False-Conflict Fix (2026-09-01)

- [x] Root cause: the lease `clientId` survived reload/navigation while each page instance generates a fresh lease token, so the server's exact-credential idempotent-acquire branch missed a same-tab reload (new token), which fell through to the held/conflict gate even with a fresh heartbeat — "already being edited" with no other editor
- [x] Platform evidence: MDN Window.name — the browsing-context name survives same-tab reloads and same-origin navigations, is reset on cross-domain loads, and is NOT inherited by newly opened editor contexts (a `window.open`/target target starts unnamed; the editor never assigns opener names). `window.name` is a non-secret, per-browsing-context id (never a token/credential). MDN sessionStorage notes opener-created pages get a copy of the opener's storage, so stored data alone cannot identify a context
- [x] Fix: the client id is the per-context `window.name` id (`getEditorContextId`). The client persists the previous SERVER-ISSUED lease credentials (token + generation) in `sessionStorage` keyed by `{docId}:{contextId}` (`storeLeaseCredentials`). On acquire it sends the fresh candidate token plus the prior credentials. `acquireEditLease` rotates/generates a new lease only when the active holder exactly matches user + clientId + prior token + prior generation (`credentialedSameContextReentry`). There is no boolean bypass
- [x] Safety: rotation advances generation and uses a fresh token, fencing the previous page instance's late heartbeat/release. A copied-storage/new context has its own `window.name` id, so it cannot present valid prior credentials for the active holder's clientId and stays held/takeover. Pending takeover is never clobbered; stale-heartbeat recovery is preserved
- [x] Regressions: `tests/reentry_lease.test.ts` (8: exact-prior rotation with stale-op fencing, copied-storage/different-context rejection, stale prior token rejected, second context held, different user held, stale-clientId recovery, pending takeover not clobbered, expired acquire), `tests/edit_lease.test.ts` (credential-proven re-acquire + different-context conflict), `tests/edit_lease_route.test.ts` (prior-credential flow + malformed-pair 400), `tests/client_edit_lease.test.ts` (context-id parser/generator, storage key/read/write/clear helpers, prior-credential payload, compare-and-clear regression)
- [x] Strict Mode false-conflict fix: initial lease effect uses `InitialLeaseCoordinator` (`src/lib/client_edit_lease.ts`) constructed and subscribed strictly within committed `useEffect` lifecycles (pure render). Cryptographically secure token generation required (no weak Math.random fallback); deliverSettled immediately services late subscribers; clean resubscribe after release; lifecycle epoch guard (`initialLeaseEpochRef`) fences stale async finalizations across unmount/navigation; genuine unmount before resolution or after finalization releases cleanly once; scoped and transitioned per `docId`. Production-connected tests at `tests/initial_acquire_strict.test.ts` (9 tests). Preserves credential-proven reload, same-user stale-context recovery, generation fencing, compare-and-clear, takeover, VIEWER/admin/recovery.
- [x] Validation (2026-09-01): focused lease tests pass (reentry 8, edit_lease 16, edit_lease_route 7, client_edit_lease 13, initial_acquire_strict 9); full `npm test` 195 tests across 23 files all pass, `npm run typecheck` clean, `git diff --check 078659a..HEAD` 0

---

## 19. Canvas URL Text (2026-10-21)

- [x] `src/lib/url_text.ts` detects a standalone text element whose whole trimmed text is a web URL: `http://`, `https://`, or a `www.` address normalized to `https://`; other schemes, plain domains, whitespace/multi-line text, and empty hosts are rejected.
- [x] Sound Visual Overlay Architecture:
  - Both visible **text glyphs and an underline are displayed in slightly light blue (`#4dabf7`)** for auto-detected URLs (both default black and imported non-default colors).
  - Stored scene text stroke colours are NEVER substituted, ensuring native Excalidraw history, deltas, and save fidelity remain intact.
  - Excalidraw's element `strokeColor` retains its true stored document color at all times (`#1e1e1e` default, `#e03131` red, `#4dabf7` user blue, or imported color).
  - The URL presentation is rendered via an aligned, pointer-transparent DOM/SVG overlay: SVG `<text>` elements with `stroke="#4dabf7" stroke-width="0.5" paintOrder="stroke fill"` aligned to font family, size, baseline, and element rotation, with an underline bar placed below baseline.
  - While an element is being edited (`appState.editingTextElement`), its overlay is hidden so Excalidraw's native wysiwyg textarea operates unobstructed.
  - Excalidraw's native History, deltas, and Store handle 100% of color actions, undo, and redo without custom heuristics or synthetic wrapper state machines.
- [x] Opacity, Silhouette & Stacking Order / Occlusion Support:
  - Element opacity (0..100) is fully preserved: `opacity: 0` URLs are completely invisible (no DOM/SVG overlay emitted) and cannot navigate on `Ctrl`+click; partial opacity (e.g. 50%) sets matching CSS opacity (`0.5`) on the overlay wrapper, preserving opacity for both glyphs and underline. Overlay equality (`sameUrlUnderlines`) tracks opacity mutations.
  - Stacking order (Z-index) is strictly respected: scene array order determines visibility (later elements render above earlier elements).
  - **Actual Shape Silhouettes**: Ellipses and diamonds use exact mathematical silhouettes (`(lx/hw)^2 + (ly/hh)^2 <= 1` and `|lx|/hw + |ly|/hh <= 1`) rather than rectangular bounding boxes. A URL lying in an empty corner of an ellipse or diamond bounding box remains visible (blue) and clickable; only the filled silhouette center occludes and blocks hit-testing.
  - **Translucency & Patterned Fills**: Only fully opaque shapes (`opacity: 100`, `fillStyle: "solid"`, and opaque background color `isOpaqueColor`) solidly cover. Translucent elements (`opacity < 100`), non-solid fills (`hachure`, `cross-hatch`), and semi-transparent colors (`rgba` with alpha < 0.99) pass through without removing the blue overlay or blocking navigation.
  - **Rotated Coordinates & SAT Overlap**: Element overlap prefiltering uses the Separating Axis Theorem (SAT) on oriented bounding boxes, preventing rotated elements from being falsely dismissed. For rotated URLs, covering geometry is converted into the URL's local coordinate system ($cx_{local}, cy_{local}, \theta_{cover} - \theta_{url}$) and rendered via SVG mask cutouts (`<ellipse>`, `<polygon>`, `<rect>`).
  - A URL covered by a later opaque element is occluded: completely covered URLs emit no overlay, and partially covered URLs apply SVG mask cutouts.
  - `urlTextAtScenePoint` evaluates elements in reverse scene order (top-to-bottom); encountering any opaque covering element or text element above a URL blocks hit-testing so `Ctrl`+click never punches through covering content.
  - A URL stacked above a filled opaque rectangle remains fully visible and clickable. Wireframe/transparent shapes above a URL allow it to show through and navigate.
  - Unused `isInteractionBusy` helper removed.
- [x] Test Instrumentation Production Isolation:
  - `window.__excalidrawAPI` and `window.__lastSavedScene` are strictly gated to non-production environments with explicit `?e2e=true` URL query parameter opt-in.
  - Normal product runtime and production builds never leak these globals.
  - Resources clean up on canvas unmount to prevent cross-canvas leakage.
- [x] Persistence & Native History Fidelity:
  - The scene handed to `onSceneChange` (auto-save, localStorage drafts, recovery, snapshots) preserves exact document colors without mutation; legacy metadata (`urlAuto`, `urlStoredColor`) is stripped if encountered so stored scenes remain clean; opening or viewing a document never marks it dirty.
  - Persisted scene records in SQLite database preserve exact user/imported colors (`#1e1e1e`, `#e03131`).
  - Native Undo/Redo restores historical stored strokeColors correctly across all steps.
- [x] Interaction & Navigation:
  - `Ctrl`+click (`Cmd`+click on macOS) on visible URL text opens the normalized destination in a new tab with `window.open(..., "_blank", "noopener,noreferrer")`; plain clicks and other tools never navigate, and elements with an explicit Excalidraw `link` keep Excalidraw's own link behavior.
  - Live zoom/pan/scroll and element rotation transforms synchronize smoothly with canvas view.
  - Editing text from URL to ordinary text immediately removes the overlay; changing back restores it.
- [x] Out of scope / known limits:
  - Standalone web URLs only; text bound inside shapes (container labels), multi-line or auto-wrapped URLs, and presentation mode (`PresentationCanvas`) are excluded.
  - File exports (`.excalidraw`, PNG/SVG disk download) and server thumbnails render the stored document stroke color (not the client viewport overlay).
  - 100% opacity images are treated as bounding-box covers as per-pixel bitmap alpha is not synchronously evaluated during vector scene layout.
- [x] Unit & Regression Tests:
  - `tests/url_text.test.ts` (27 tests) covers URL normalization, hit testing, client→scene coordinate conversion, font family CSS mapping, underline/glyph geometry across font baselines, scene color preservation, legacy customData stripping, native Excalidraw monotonic versioning with delta restoration, opacity (0 and 50%), complete and partial occlusion by shapes/images, stacking order, ellipse/diamond silhouettes (empty corner clickable vs filled center blocked), translucent/patterned fill pass-through (`opacity: 50`, `hachure`, `rgba`), rotated URL coordinate conversion, and SAT rotated overlap detection.
  - Full vitest suite: all 39 test files (318 tests) pass; TypeScript check clean (`tsc --noEmit` 0 errors).
- [x] Real Browser & Package Integration Verification (`scripts/verify_url_history.mjs`):
  - Self-contained isolated harness managing its own Next.js server on dynamic port and Chrome CDP lifecycle with temporary disposable `DATA_DIR` and browser profile.
  - Pre-flight checks ensure `TEST_PORT` (3123) and `CDP_PORT` (9322) are free and unowned before starting.
  - Dynamically counted hard assertions with non-zero exit on failure:
    1. Visible blue glyph pixels measured separately from underline pixels: `url-black` (visible blue glyphs > 1000, 0 dark px, blue underline > 50 px); `url-red` (visible blue glyphs > 1000, 0 red px, blue underline > 50 px).
    2. Element opacity: opacity 0 emits 0 glyph and 0 underline pixels and no DOM node; opacity 50 emits visible blue glyph pixels and sets CSS opacity 0.5.
    3. Stacking order & occlusion: URL below opaque filled rectangle emits 0 blue pixels and is excluded from overlay; URL below image emits 0 blue pixels; URL above filled opaque rectangle remains fully visible (> 1000 blue glyph px, > 50 blue underline px).
    4. Exact silhouette support: URL in empty corner of ellipse remains visible in blue and clickable; URL in filled center of ellipse is occluded (0 blue pixels) and blocked; URL in empty corner of diamond remains visible in blue and clickable; URL in filled center of diamond is occluded (0 blue pixels) and blocked.
    5. Translucent & patterned fill pass-through: URL under translucent rectangle (opacity: 50) remains visible in blue and clickable; URL under patterned rectangle (fillStyle: hachure) remains visible in blue and clickable.
    6. Rotated URL under unrotated opaque rectangle is completely occluded and blocked.
    7. Rotated cover over URL with SAT overlap detection applies SVG mask cutout with relative angle; uncovered portion remains visible in blue and clickable, while click on covered overlap point is blocked.
    8. Server persistence fidelity via actual API (`GET /api/documents/:id`): stored scene retains `#1e1e1e` and `#e03131` without substitution.
    9. Full 9-step native Undo/Redo sequence: step 1 red, step 2 blue, step 3 green, undo 1 to blue, server save verification, undo 2 to red, undo 3 to black, redo 1 to red, redo 2 to blue.
    10. URL <-> ordinary text editing transitions: overlay correctly removed when text is edited to non-URL and restored when edited back.
    11. Viewport transforms: zoom (1.5x), scroll pan (60px, 45px), and element rotation (0.35 rad) all accurately synced.
    12. Production isolation verified: `window.__excalidrawAPI` and `__lastSavedScene` are undefined when navigating without `?e2e=true`.
  - Step-by-step evidence artifact recorded in `docs/project/evidence/url_history_evidence.json` with all 79 assertions passed.

### Coordinator review decision
GO for the documented standalone single-line URL canvas feature after static review of the actual implementation and recorded verification evidence. Worker verification: 27 focused tests, 318 total tests, clean typecheck, and 79 isolated browser assertions. Coordinator did not rerun worker tests. No production build or commit was performed. This approval retains the known limitations above, including bounding-box occlusion for bitmap images with transparent pixels; it does not claim exact per-pixel compositing support.
