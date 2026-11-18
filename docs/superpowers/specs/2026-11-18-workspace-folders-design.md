# Workspace folders

Status: Implemented and independently reviewed (GO, 2026-11-18). See `docs/project/TODO_FOLLOWUP.md` for the final decision, evidence attribution, and limited browser coverage.

## Confirmed scope

Application folders and nested folders containing standalone drawing documents and presentation Decks, including moving existing items into folders.

## Approaches

Recommended: an owner-scoped `folders` table with nullable `parent_id`, and nullable `folder_id` references on existing documents and Decks. Null means workspace root. Reuse SQLite transactions, authentication, and existing dashboard cards.

Alternative: a unified workspace-items table wrapping documents, Decks, and folders. It centralizes item handling but adds an identity and lifecycle layer unnecessary for the current two content types.

The user confirmed the feature scope. The recommended approach and defaults below are implementer proposals for review.

## Proposed behavior

- My Documents shows immediate child folders, Decks, and documents; breadcrumbs navigate ancestors. Keep the existing tabs and card styles.
- Create, rename, move, and delete folders. Names are trimmed, required, and limited to 100 characters. Duplicate names are allowed; identity comes from IDs.
- Move actions offer a destination selector including root. Reject moving folders into themselves or descendants.
- New documents, Decks, and imported `.excalidraw` documents are created atomically in the current folder. Reject invalid destinations before creating content.
- Confirm folder deletion, then transactionally move immediate child folders and all contained document/Deck references to its parent before deleting it. Preserve all content and descendant structure.
- Search titles within the current folder across folders, documents, and Decks. Distinguish an empty folder from no search matches.
- Store the current folder in the dashboard URL for browser history and editor return navigation. Fall back to root for inaccessible or deleted folders.

## Permissions and lifecycle

- Folders are personal. Only their owner may list or modify them. Items and destination folders must share that owner. Personal folder endpoints do not grant an admin bypass.
- Shared With Me keeps existing document permissions without exposing the owner's private folder metadata. Folder sharing and inherited permissions are outside this iteration.
- Deck backing documents remain hidden and cannot be moved separately. Moving a Deck preserves its pages and existing identifiers.
- Trashed documents retain their association; deleting a folder reparents their associations too so restore always targets a valid folder or root.
- Transferring document ownership to another user clears its folder atomically, including admin reassignment paths. Same-owner transfer retains the association.
- Organization changes only metadata; scenes, attachments, snapshots, share links, and editor lease rules keep their existing behavior.

## Implementation

Add an idempotent startup migration for folders, nullable references, and indexes. Existing content starts at root. Centralize destination validation, owner checks, cycle prevention, and transactional folder operations in a small `src/lib/folders.ts` module. Follow current API route conventions for folders and item moves. Return organization metadata only to the owner.

Integrate current-folder creation and import in existing library operations, avoiding a second request that could leave content in the wrong location. No new dependencies or physical storage directory changes. Drag-and-drop, bulk operations, manual ordering, and folder trash are deferred proposals.

## Verification and documentation

Test nested creation, moves and cycle rejection, cross-user isolation, populated-folder deletion without content loss, current-folder creation/import, Deck-page move rejection, ownership transfer, trash restore, and repeatable migration of existing data. Run relevant Vitest tests and TypeScript checking. Do not run a build unless the user requests one.

Update README, the existing project implementation plan, and verification checklist with delivered behavior and actual checks. Keep this document's status accurate.
