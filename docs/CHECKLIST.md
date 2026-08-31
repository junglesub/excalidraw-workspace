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
  - [x] `document_versions`: id, document_id (FK), version_number, scene (JSON), thumbnail_path, created_by (FK), created_at
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
  - [x] **Manual Save**: 'Save' button / `Ctrl+S` immediately persists scene and generates an instant version snapshot (`/api/documents/[id]/save`)
- [x] **Version History**
  - [x] Retains up to the 20 most recent snapshots per document (`MAX_VERSIONS = 20`)
  - [x] Version history drawer (snapshot list, timestamps, authors, thumbnails)
  - [x] Snapshot preview and rollback/restore (restoring commits as a new current state snapshot)
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
  - [x] Automated test suite (`npm test`) 100% passing (6 suites, 26 tests)

---

## 11. Local Draft Recovery Conflict (2026-08-31)

- [x] Load-time local/server mismatch requires an explicit writable-user choice.
- [x] The unselected version is snapshotted by default for both client and server choices.
- [x] VIEWER always sees server state without local draft access or deletion.
- [x] Empty-scene recovery, edit-to-undo cleanup, account isolation, and image recovery are covered.
- [ ] Browser manual verification (refresh with both choices, default checkbox/unchecked, retry after failure, image recovery without `/documents/undefined`, VIEWER isolation, account switching, malformed draft) — automated tests pass; manual browser scenarios not yet executed in this environment.