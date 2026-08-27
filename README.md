# Private Excalidraw Workspace

A private, self-hosted [Excalidraw](https://excalidraw.com) workspace designed for individuals and small teams. 

It provides full document management, version history snapshots, user access controls, and public sharing capabilities with **zero cloud dependencies**—persisting all databases, attachments, and thumbnails in a single local volume (`/data`).

---

## ✨ Features

- 🎨 **Full Excalidraw Integration** (`@excalidraw/excalidraw` 0.18.1): Drawing, shapes, text, handwriting, light/dark themes, canvas zoom/pan, and flowchart nodes via `Ctrl`/`Cmd`+arrow. Tab-to-cycle node type is not in this package version.
- 💾 **Robust Auto-Save & Crash Recovery**:
  - 3-second debounced server auto-saving.
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
# Run latest release from GitHub Container Registry
docker compose up -d

# Or run a specific branch/tag (e.g. main)
TAG=main docker compose up -d
```

Open your browser and navigate to `http://localhost:3000`.

**Default Admin Credentials:**
- **Username**: `admin`
- **Password**: `admin1234!` *(Configure `ADMIN_PASSWORD` in `docker-compose.yml` for production)*

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
- [Implementation Plan](docs/implement_plan.md)
- [Verification Checklist](docs/CHECKLIST.md)
- [Attachment Transfer Status](docs/ATTACHMENT_FILE_TRANSFER_STATUS.md)
- [Attachment Transfer Design](docs/superpowers/specs/2026-08-27-direct-attachment-transfer-design.md)
- [Future Roadmap & Follow-up](docs/TODO_FOLLOWUP.md)

---

## 📄 License

MIT License.
