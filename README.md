# Private Excalidraw Workspace

A private, self-hosted [Excalidraw](https://excalidraw.com) workspace designed for individuals and small teams. 

It provides full document management, version history snapshots, user access controls, and public sharing capabilities with **zero cloud dependencies**—persisting all databases, attachments, and thumbnails in a single local volume (`/data`).

---

## ✨ Features

- 🎨 **Full Excalidraw Integration** (`@excalidraw/excalidraw` 0.18.1): Drawing, shapes, text, handwriting, light/dark themes, canvas zoom/pan, and flowchart nodes via `Ctrl`/`Cmd`+arrow. Tab-to-cycle node type is not in this package version.
- 🔵 **URL Text on the Canvas**: Standalone text elements whose entire trimmed text is a web URL (`http://`, `https://`, or `www.` normalized to `https://`) display both the **text glyphs and an underline in slightly light blue (`#4dabf7`)**. `Ctrl`+click (`Cmd`+click on macOS) opens the link in a new tab; regular clicks and other tools do not navigate. The light-blue text glyphs and underline are rendered via an aligned, pointer-transparent DOM/SVG overlay that tracks zoom, pan, and rotation transforms while leaving underlying stored scene element colors untouched (`#1e1e1e` default, imported colors, or user color edits). Element opacity (0–100) and scene stacking order (Z-index) are fully respected:
  - **Actual Shape Silhouettes**: Ellipses and diamonds use true convex silhouettes rather than rectangular bounding boxes. A URL lying in the empty corner of an ellipse or diamond bounding box remains visible (blue) and clickable; only the filled center occludes and blocks navigation.
  - **Translucency & Patterned Fills**: Only fully opaque shapes (`opacity: 100`, `fillStyle: "solid"`, and opaque background color) solidly cover. Translucent elements (`opacity < 100`), non-solid fills (`hachure`, `cross-hatch`), and semi-transparent colors (`rgba` with alpha < 0.99) pass through without removing the blue overlay or blocking navigation.
  - **Rotated Coordinates & SAT Overlap**: Oriented bounding boxes are tested for overlap using the Separating Axis Theorem (SAT) so rotated intersections are accurately detected. For rotated URLs, covering geometry is converted into the URL's local coordinate space ($cx_{local}, cy_{local}, \theta_{cover} - \theta_{url}$) and rendered via SVG mask cutouts (`<ellipse>`, `<polygon>`, `<rect>`).
  - **Preserves Native Excalidraw Engine**: Native history, delta tracking, undo/redo, and server save fidelity are completely preserved without substituting stored document colors.
  - **Known limits**: Standalone URLs only (container labels and multi-line URLs are excluded); PNG/SVG disk exports and server thumbnails render the stored document stroke color; 100% opacity images are treated as bounding-box covers as per-pixel bitmap alpha is not synchronously evaluated during vector scene layout.
- 🔒 **Single-Editor Lease (One Canvas Editor Per Document)**:
  - Exactly one active canvas editor per document across users, browsers, devices, and tabs.
  - Lease acquisition before editable canvas mount; blocking conflict modal offers `Open read-only` and `Take over editing`.
  - 2-second heartbeat, 90-second lease expiry, 1-second takeover polling, forced takeover at 10 seconds.
  - Graceful handover flushes old editor, uploads attachments, and saves without forced snapshot; forced takeover advances fencing generation.
  - Server-side token + generation fencing in same SQLite transaction for auto-save, manual save, recovery, and history restore; stale writes rejected with `EDIT_LEASE_LOST`.
  - VIEWER and deleted-document views are server-only/read-only, never touch localStorage or leases.
  - Old editor becomes read-only and retains unconfirmed local draft; new editor reloads latest server scene before draft resolution. Title rename, sharing, permission, attachment upload, import, Trash, and restore from Trash remain outside the lease. No WebSocket/SSE/Redis/CRDT.
- 💾 **Robust Auto-Save & Crash Recovery**:
  - 3-second debounced server auto-saving (fenced by lease when active).
  - Browser `localStorage` drafts: compact metadata for images already on the server; inline `dataURL` only for files not yet uploaded.
  - Page unload (`beforeunload`) keepalive flush of a compact scene (no image Base64).
  - `Ctrl + S` / `Cmd + S` shortcut for instant server commit and snapshot creation.
- 🕒 **Version History & Snapshots**:
  - Automatic snapshot throttling policy and manual save points.
  - Retention cap of the 20 most recent versions.
  - 1-click restore/rollback to any past snapshot.
- 🖼️ **Real Pixel-Perfect Thumbnails**:
  - Live client-rendered 400px PNG thumbnails generated from canvas drawings for clear dashboard previews.
- 👥 **Access Control & User Sharing**:
  - Role-based permissions (`OWNER`, `EDITOR`, `VIEWER`).
  - Read-only document sharing with specific users.
  - Atomic ownership transfer between users.
- 🔗 **Public Share Links**:
  - Read-only anonymous share links with optional expiration dates.
  - Instant token rotation and revocation.
- 🗑️ **Trash & Resource Garbage Collection**:
  - Safe soft-delete with restoration support.
  - Permanent purge with atomic cleanup of SQLite records and physical attachment files.
- 🛡️ **Admin Mode & User Management**:
  - Environment-based admin auto-bootstrapping.
  - User creation, deactivation, and password reset.
  - Global document management and ownership reassignment.
  - Storage maintenance: scan disk usage, clean orphan files, and purge unreferenced attachments (24-hour grace period).
- 📎 **Disk-backed Images (Compact Scenes)**:
  - Document JSON stores image metadata only (`id`, `mimeType`, `created`). Binary files live under `data/attachments/<docId>/<fileId>`.
  - The editor fetches binaries from `/api/attachments` and hydrates Excalidraw in memory. Official `.excalidraw` export still embeds Base64 for portability.
  - New images are uploaded as multipart before the scene is saved. Max attachment size is 25 MB.
- 📦 **Native Import / Export**:
  - Fully compatible with official `.excalidraw` JSON files.

---

## 🚀 Quick Start

### 1. Run with Docker Compose (Recommended)

```bash
# Copy the environment example, then set ADMIN_PASSWORD to a unique password
# of at least 8 characters before starting Docker Compose.
cp .env.example .env

# Run latest release from GitHub Container Registry
docker compose up -d

# Or run a specific branch/tag (e.g. main)
TAG=main docker compose up -d
```

Open your browser and navigate to `http://localhost:3000`.

Sign in as `admin` (or your `ADMIN_USERNAME`) with the `ADMIN_PASSWORD` you configured. Compose requires an explicit password; production bootstrap rejects the development default `admin1234!`. Environment changes do not overwrite an existing administrator account's password. Change that password in the app.

---

### 2. Standalone Docker Run

```bash
docker run -d \
  --name private-excalidraw \
  -p 3000:3000 \
  -v ./data:/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-secure-password \
  ghcr.io/junglesub/excalidraw-workspace:latest
```

---

### 3. Local Development

Prerequisites: **Node.js 22+**

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env.local

# 3. Run automated tests
npm test

# 4. Start local development server
npm run dev
```

Development seed credentials: `admin` / `admin1234!` when `ADMIN_PASSWORD` is blank. Existing accounts keep their current credentials. Docker and other production deployments require a unique password instead.

---

## 🏗️ Architecture & Storage

All data is stored inside a single directory (`/data` or `./data`):

```text
data/
├── app.db               # SQLite database (Node built-in node:sqlite with WAL)
├── attachments/         # Per-document image files (not Base64 in scene JSON)
│   └── <docId>/<fileId>
└── thumbnails/          # PNG previews: <docId>.png and <docId>-vN.png
```

---

## 🧪 Testing & Verification

The project includes an automated test suite verifying authentication, document lifecycle, version snapshots, sharing, and thumbnails:

```bash
# Run all unit and integration tests (Vitest)
npm test

# Run TypeScript type check
npm run typecheck

# Run production build validation
npm run build
```

---

## 📚 Documentation

Detailed implementation guides and verification checklists are available in the [`docs/`](docs/) directory:
- [Implementation Plan](docs/project/implement_plan.md)
- [Verification Checklist](docs/project/CHECKLIST.md) (see section 19 for canvas URL text)
- [Attachment Transfer Status](docs/features/attachment-transfer/status.md)
- [Attachment Transfer Design](docs/features/attachment-transfer/design.md)
- [Future Roadmap & Follow-up](docs/project/TODO_FOLLOWUP.md)

---

## 📄 License

MIT License.
