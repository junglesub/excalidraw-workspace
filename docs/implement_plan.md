# Private Excalidraw Workspace Requirements & Implementation Plan

## 1. Purpose

Build a self-hosted web application embedding Excalidraw.

Users must be able to create Excalidraw documents in the browser, save them to the server, and reopen them from a dashboard for editing.

The service targets individuals and small user groups, prioritizing the following over complex SaaS features:

- Simple self-hosting
- Reliable document persistence
- Document version recovery
- Multi-user accounts
- Clear document ownership and sharing permissions
- Read-only sharing
- Architecture ready for future collaborative editing expansions

Do not fork Excalidraw itself; embed the official `@excalidraw/excalidraw` package inside the application.

---

## 2. Technical Direction

### Application

Develop a new wrapper application.

Do not fork the Excalidraw upstream repository or Nib.

```text
Application
├── Dashboard
├── Authentication
├── Document Management
├── Sharing
├── Version History
├── Admin
└── Excalidraw Editor
    └── @excalidraw/excalidraw
```

### Database

Use SQLite.

Targeting personal and small self-hosted environments, no separate DB server is required.

### File Storage

Images and attachments are stored in the local filesystem rather than inside SQLite.

```text
/data
├── app.db
├── attachments/
└── thumbnails/
```

All persistent application data is consolidated under `/data`.

---

## 3. Deployment

The default deployment unit is Docker Compose.

```text
docker compose
└── app
    ├── Web Application
    ├── SQLite
    ├── Excalidraw
    └── /data volume
```

Separate PostgreSQL, Redis, S3, OIDC Providers, etc. are not required in the MVP.

Reverse proxy and HTTPS are not mandatory internal components of the application.

Connecting with Caddy, Nginx, Traefik, etc., can be provided as separate deployment examples.

---

## 4. Authentication

### 4.1 User Accounts

The application provides its own user account system.

Users log in with the following credentials:

```text
username
password
```

Email is not required.

Public registration is not provided.

---

### 4.2 Initial Administrator

The initial administrator account is bootstrapped via environment variables.

Example:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
```

Created only on application startup when no administrator account exists.

Changing environment variables does not automatically overwrite the password of an already created administrator account.

---

### 4.3 User Creation

Only administrators can create new user accounts.

Users cannot sign up on their own.

---

### 4.4 Password Management

Users can change their own passwords.

Administrators can reset user passwords.

No artificial complexity policy is enforced at the application level.

Passwords must always be stored in secure password hash format.

Plaintext passwords are never stored.

---

## 5. User Roles

The system accounts have the following roles:

```text
USER
ADMIN
```

ADMIN can use all general user features.

---

## 6. Admin Mode

Administrators operate within the same permission scope as normal users by default after logging in.

In normal mode, they can only access:

- Their own documents
- Documents shared with them

Other users' private documents cannot be viewed in normal mode.

Administrators must explicitly enter `Admin Mode` to use system-wide management privileges.

No additional password prompt is required when entering Admin Mode.

Admin Mode provides the following capabilities:

- View user list
- Create users
- Deactivate or delete users
- Reset user passwords
- View all documents across the system
- View any document
- Edit any document
- Delete any document
- Manage document ownership as needed

---

## 7. Documents

### 7.1 Document Creation

All users can create new Excalidraw documents.

The user who creates a document becomes its OWNER.

New documents are always created in a private state.

---

### 7.2 Core Document Attributes

Documents have at least the following information:

```text
id
title
owner
scene
created_at
updated_at
deleted_at
```

Additionally, they link to the following resources:

```text
attachments
thumbnail
versions
members
share_link
```

---

## 8. Document Permission Model

Document permissions are designed from the beginning with three tiers:

```text
OWNER
EDITOR
VIEWER
```

Even if the EDITOR sharing feature is not exposed in the MVP UI, the data model and authorization layer treat EDITOR as an independent role.

Future collaborative editing features can be enabled without changing the DB schema.

---

### 8.1 OWNER

Each document has exactly one OWNER.

The OWNER can perform the following operations:

- Read document
- Edit document
- Rename document
- Delete document
- Restore from Trash
- Permanently delete
- View version history
- Restore previous version
- Manage user sharing
- Create and revoke share links
- Transfer document ownership

---

### 8.2 EDITOR

Reserved role for future edit sharing and real-time collaboration.

Included in the permission model and DB schema.

In the MVP, regular users cannot grant EDITOR permissions to other users.

Must be activatable in the future.

---

### 8.3 VIEWER

VIEWER can read the document but cannot modify it.

---

## 9. Ownership Transfer

The OWNER can transfer document ownership to another user.

A document must always have exactly one OWNER.

Ownership transfer is processed as an atomic transaction.

The previous OWNER is converted to the EDITOR role after ownership transfer.

Example:

```text
Before
alice: OWNER
bob: VIEWER

Transfer alice → bob

After
bob: OWNER
alice: EDITOR
```

---

## 10. Saving

### 10.1 Auto-Save

When a document changes, it automatically saves approximately 3 seconds after the last change.

Operates via debouncing.

Continuous editing does not repeat unnecessary save requests.

Auto-save updates the current document state but does not create a new recovery version snapshot every time.

---

### 10.2 Manual Save

Users can use an explicit `Save` feature.

Manual save persists immediately regardless of debounce wait status.

Manual save generates a recovery version snapshot immediately.

---

## 11. Version History

Each document maintains the 20 most recent recovery snapshots.

Snapshots are not created on every auto-save request.

Recovery snapshot creation policy:

```text
Auto editing
→ Current state auto-save
→ Can create snapshot if >= 5 minutes have passed since last snapshot

Manual Save
→ Immediately save current state
→ Immediately create snapshot
```

Old snapshots exceeding the most recent 20 are pruned.

Users can inspect past states in the version history view and restore them.

Restoring an earlier version is itself committed as a new current state snapshot.

---

## 12. Images and Attachments

Images and other binary resources inserted into Excalidraw documents are stored in the local filesystem.

The database stores metadata and file references.

Per-document storage namespaces are used:

```text
/data/attachments/
└── <document-id>/
    ├── ...
    └── ...
```

---

### 12.1 Versions and Attachments

Even if an image is removed from the current scene, the physical file is not deleted if a preserved version snapshot still references it.

Files can be physically deleted only when referenced nowhere across:

- The active document scene
- Preserved version snapshots

Restoring previous versions must never break embedded images.

---

## 13. Document Deletion and Trash

Document deletion is soft delete by default.

Deleted documents move to `Trash`.

There is no automatic permanent purge expiration period.

In Trash, users can:

- Restore document
- Permanently delete document

On permanent deletion:

1. Delete active document record
2. Delete version history
3. Delete document memberships
4. Remove share links
5. Remove attachment references
6. Delete physical files that are no longer referenced
7. Remove thumbnails

---

## 14. Dashboard

The initial screen after logging in is the Dashboard, not the Excalidraw editor.

The Dashboard provides at least the following sections:

```text
Dashboard
├── My Documents
├── Shared With Me
├── Trash
└── Admin Mode
```

`Admin Mode` is displayed only to administrators.

---

## 15. My Documents

Displays documents owned by the current user.

Document cards or list items display at least:

- Title
- Thumbnail preview
- Last modified timestamp

Supports document title search.

Tags and folders are not provided in the MVP.

---

## 16. Shared With Me

Displays documents shared with the current user by other users.

In the MVP, actual shared permissions use VIEWER only.

Users can read shared documents but cannot modify them.

---

## 17. Thumbnails

Thumbnails are stored as separate files to render document lists quickly.

Thumbnails are not re-rendered from the Excalidraw scene on every dashboard visit.

Thumbnails are updated at:

- Manual save
- New version snapshot creation

PNG-based thumbnails are used as the standard.

---

## 18. User-to-User Sharing

The OWNER can share documents with specific application users.

There is no artificial limit on the number of shared users.

In the MVP, the permission granted to users is VIEWER.

Internal data model must support:

```text
OWNER
EDITOR
VIEWER
```

---

## 19. Public Share Links

The OWNER can generate read-only share links accessible to unauthenticated users.

Users with a share link can view the document without an account.

MVP share links provide VIEWER permissions only.

Designed with extensible permission concepts to support future EDITOR links.

---

### 19.1 Share Link Count

A document has at most one active share link at any time.

---

### 19.2 Share Link Expiration

Share links have no expiration date by default.

The OWNER can set an optional expiration timestamp.

Access to expired links is rejected.

The OWNER can deactivate or regenerate share links at any time.

Regenerating a link immediately invalidates the previous token.

---

## 20. Read-Only Viewer

When shared users or anonymous share-link users open a document, Excalidraw is presented in read-only view mode.

Navigation features such as zoom and pan remain available in viewer mode.

Modifying document content or saving to the server is disabled.

---

## 21. Import / Export

Maintain full compatibility with the standard `.excalidraw` file format.

### Import

Users can upload `.excalidraw` files to create new documents.

### Export

Users can download their documents as `.excalidraw` files.

Data is never locked into an internal service format.

---

## 22. Backup

The MVP does not implement an internal backup scheduler or backup management UI.

All persistent data is consolidated under `/data`:

```text
/data
├── app.db
├── attachments/
└── thumbnails/
```

Operators can back up the entire application by backing up the `/data` volume itself.

---

## 23. Real-Time Collaboration

Real-time collaborative editing is not included in the MVP scope.

The MVP provides:

```text
Document owner → Edit
Viewer → Read only
```

The EDITOR role exists in the data model but is not enabled for users.

---

## 24. Future Collaboration Roadmap

### Phase 1: MVP

- User accounts
- Administrator bootstrap and management
- Document management
- Embedded Excalidraw
- Save / Load pipeline
- Auto-save with debouncing
- Manual save with snapshots
- Version history (20 snapshots)
- File storage and retention
- Trash and restore
- User-specific read-only sharing
- Anonymous read-only share links
- Import / Export

### Phase 2

Enable EDITOR permissions.

Allow users to grant edit permissions to other users.

Support sequential editing with optimistic concurrency control.

### Phase 3

Integrate Excalidraw collaboration infrastructure or compatible room servers for real-time collaborative editing:

- Real-time cursors
- Multi-user scene synchronization
- Collaborative editing & conflict resolution
- Presence

---

## 25. Excluded from MVP

The following features are not implemented in the initial version:

- Public registration
- Email verification
- Email-based password reset
- OIDC / Google / GitHub login
- S3 / R2 storage
- PostgreSQL / Redis
- Real-time collaborative editing
- Active EDITOR sharing UI
- Tags & Folders
- Full-text search
- Comments & Notifications
- In-app backup UI
- Automatic trash emptying
- Mobile-specific native app

---

## 26. Initial Data Model

```text
User
Document
DocumentMember
DocumentVersion
Attachment
ShareLink
Session
```

Entity Relationships:

```text
User
 │
 │ owns
 ▼
Document
 ├── DocumentVersion
 ├── Attachment
 ├── ShareLink
 └── DocumentMember
          │
          └── User
```

---

## 27. Core Product Principles

### Simple Self-Hosting

Users can start the service with:

```bash
docker compose up -d
```

### Upstream-Friendly

Never fork Excalidraw directly. Use `@excalidraw/excalidraw` as a dependency to follow upstream updates easily.

### Private by Default

All documents are created private. Accessible to others only when explicitly shared.

### Data Ownership

Standard `.excalidraw` export allows users to take their data outside the service anytime.

### Local-First Infrastructure

SQLite and local volumes are used as primary storage with zero mandatory external cloud services.

### Future-Proof Permissions

Even with VIEWER-only sharing in MVP, OWNER, EDITOR, and VIEWER are decoupled from the beginning.

---

## 28. MVP Success Criteria

The MVP goals are achieved when the following 20 scenarios operate correctly:

1. Administrator runs the application with Docker Compose.
2. Initial administrator account is auto-created from environment variables.
3. Administrator can create new user accounts.
4. User logs in.
5. Dashboard is displayed.
6. User creates a new Excalidraw document.
7. Browser operates Excalidraw normally.
8. Changes are auto-saved.
9. User explicitly saves with Save button.
10. Document reopens after logout and re-login.
11. Document can be restored to previous version snapshots.
12. Documents containing images are saved and restored properly.
13. Deleted documents can be restored from Trash.
14. User can share documents with other accounts with VIEWER permission.
15. Shared users can read but cannot modify documents.
16. OWNER can create anonymous read-only share links.
17. Users with the link can view documents without logging in.
18. `.excalidraw` import and export work correctly.
19. All data is preserved when `/data` is retained across container recreations.
20. Administrator can manage all users and documents in Admin Mode.