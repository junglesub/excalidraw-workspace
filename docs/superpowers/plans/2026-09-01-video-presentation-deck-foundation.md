# Video Presentation Deck Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first working vertical slice for presentation decks: persistent Deck/Page orchestration, CRUD APIs, and a basic Deck Editor that reuses existing Excalidraw documents as pages.

**Architecture:** Add `decks` and `deck_pages` tables. A deck owns an ordered set of page records, and each page references one existing `documents.id`, preserving the existing attachment, thumbnail, save, version, and lease systems. Deck APIs operate on deck metadata and page orchestration. For this foundation slice only, page editing links to the existing document editor; this is scaffolding, not the target Deck Editor UX. The final MVP edits the backing document inline inside the Deck Editor and hides Page backing documents from the standalone Dashboard document list.

**Tech Stack:** Next.js 15 App Router, React 18, TypeScript, Node `node:sqlite`, Vitest, Tailwind CSS, existing `@excalidraw/excalidraw` integration.

**Spec:** `docs/features/video-presentation/design.md`

## Global Constraints

- One Page = one independent Excalidraw document/scene.
- MVP aspect ratios are exactly `16:9` and `9:16`.
- Blank-page creation creates a completely new blank page.
- Page duplication copies current visual state but not old snapshot/version history, named snapshots, or recording history.
- Prefer extending existing document persistence, attachment storage, thumbnails, version snapshots, autosave, and edit lease behavior.

---

### Task 1: Deck and Page persistence domain

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/lib/types.ts`
- Create: `src/lib/decks.ts`
- Create: `tests/decks.test.ts`

**Interfaces:**
- Produces: `createDeck`, `listDecks`, `getDeck`, `renameDeck`, `deleteDeck`, `createBlankPage`, `duplicatePage`, `renamePage`, `deletePage`, `reorderPages`.
- Produces types: `DeckAspectRatio`, `DeckRow`, `DeckPageRow`, `DeckWithPages`.

- [ ] **Step 1: Write failing domain tests** covering deck creation with first blank page, supported ratios, page add/rename/delete/reorder, and duplicate copying scene without version history.
- [ ] **Step 2: Run `npx vitest run tests/decks.test.ts` and verify RED** due to missing deck module/schema.
- [ ] **Step 3: Add schema/types and minimal `src/lib/decks.ts` implementation** using transactions and existing `createDocument`/document scene storage.
- [ ] **Step 4: Run `npx vitest run tests/decks.test.ts` and verify GREEN**.

### Task 2: Deck HTTP API

**Files:**
- Create: `src/app/api/decks/route.ts`
- Create: `src/app/api/decks/[id]/route.ts`
- Create: `src/app/api/decks/[id]/pages/route.ts`
- Create: `src/app/api/decks/[id]/pages/[pageId]/route.ts`
- Create: `src/app/api/decks/[id]/pages/reorder/route.ts`
- Create: `tests/deck_routes.test.ts`

**Interfaces:**
- `GET /api/decks` -> `{ decks }`
- `POST /api/decks` body `{ title, aspectRatio }` -> `{ deck }`
- `GET /api/decks/:id` -> `{ deck }`
- `PATCH /api/decks/:id` body `{ title?, aspectRatio? }` -> `{ deck }`
- `DELETE /api/decks/:id` -> `{ ok: true }`
- `POST /api/decks/:id/pages` body `{ action: "blank" | "duplicate", pageId? }` -> `{ deck, page }`
- `PATCH /api/decks/:id/pages/:pageId` body `{ title }` -> `{ deck, page }`
- `DELETE /api/decks/:id/pages/:pageId` -> `{ deck }`
- `POST /api/decks/:id/pages/reorder` body `{ pageIds }` -> `{ deck }`

- [ ] **Step 1: Write failing route tests** for authenticated create/list/get and page operations plus unauthorized access.
- [ ] **Step 2: Run `npx vitest run tests/deck_routes.test.ts` and verify RED**.
- [ ] **Step 3: Implement routes using existing `requireUser`, `readJson`, `handleError`, and deck domain functions**.
- [ ] **Step 4: Run route tests and verify GREEN**.

### Task 3: Dashboard deck entry point and basic Deck Editor

**Files:**
- Modify: `src/app/dashboard/DashboardClient.tsx`
- Create: `src/app/decks/[id]/page.tsx`
- Create: `src/app/decks/[id]/DeckEditorClient.tsx`
- Create: `tests/deck_editor_model.test.ts`
- Create: `src/lib/deck_editor.ts`

**Interfaces:**
- Produces pure helpers `movePageId(pageIds, activeId, direction)` and `validateReorder(pageIds, requestedIds)` for UI behavior.
- Dashboard adds `+ New Deck`, defaulting to `16:9`, then routes to `/decks/:id`.
- Deck Editor shows title, ratio, ordered thumbnail rail, add blank page, duplicate, rename, delete, previous/next, and, in this foundation slice only, an `Edit page` link to `/documents/:documentId`.
- Follow-up requirement: replace the temporary `Edit page` navigation with inline Excalidraw editing inside the Deck Editor and exclude Page backing documents from standalone Dashboard document listings.

- [ ] **Step 1: Write failing pure UI-model tests** for previous/next and reorder validation.
- [ ] **Step 2: Run `npx vitest run tests/deck_editor_model.test.ts` and verify RED**.
- [ ] **Step 3: Implement helpers and Deck Editor UI/API wiring** without introducing a second save pipeline.
- [ ] **Step 4: Run model tests, `npm run typecheck`, and verify GREEN**.

### Task 4: Full verification

**Files:**
- Modify only if verification exposes a regression, with a failing regression test first.

- [ ] **Step 1: Run `npm test`** and require all existing plus new tests to pass.
- [ ] **Step 2: Run `npm run typecheck`** and require zero errors.
- [ ] **Step 3: Run `npm run build`** and require a successful production build.
- [ ] **Step 4: Review `git diff --check` and `git status --short`** for whitespace issues and unintended files.
