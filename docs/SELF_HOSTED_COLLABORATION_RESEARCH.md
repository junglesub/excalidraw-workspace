# Self-Hosted Excalidraw Collaboration Research

Date: 2026-09-01
Status: Research only; not approved for implementation

## Decision Summary

Implement the single-editor lease first. Treat it as a small, replaceable safety layer rather than the foundation of collaboration.

For later self-hosted real-time collaboration, the recommended direction is:

- keep the existing Next.js application responsible for authentication, document metadata, attachments, history, and durable scene storage;
- run a separate self-hosted collaboration service for rooms, presence, and live scene synchronization;
- start from Excalidraw's upstream collaboration behavior and room-server example instead of inventing a generic collaboration framework;
- use short-lived room authorization issued by the application server;
- persist settled or periodic room state back through the existing document storage boundary;
- keep the deployment single-instance initially, without Redis or multi-region coordination.

This is a multi-week subsystem, not a small extension of the single-editor lease.

## What Is Available

### Excalidraw upstream collaboration

Excalidraw's application repository contains its collaboration client logic, including room lifecycle, encrypted scene transport, presence, and synchronization behavior. The separate `excalidraw-room` repository provides a minimal Socket.IO room server example.

These are the closest references for preserving Excalidraw semantics, but they are not a drop-in `@excalidraw/collab` package for this application. Authentication, authorization, durable persistence, history, attachments, and deployment integration remain application work.

### Yjs and Hocuspocus

Yjs provides CRDT shared data types, offline support, and an awareness protocol. Hocuspocus supplies a self-hosted WebSocket backend and Yjs provider with authentication and persistence hooks.

This reduces transport and distributed-state plumbing, but the application would still need a carefully designed mapping between Excalidraw scene elements and shared Yjs state. It would also need custom handling for attachments, application permissions, version history, and restore behavior. Adopting Yjs therefore does not remove the largest product-integration decisions.

### Hosted collaboration platforms

Hosted products can reduce operational work, but they do not match the self-hosted requirement. They are not recommended for the current direction.

## Recommended Target Architecture

```text
Browser / embedded Excalidraw
        │
        ├── HTTPS ──> Next.js application
        │             - authentication and authorization
        │             - document metadata
        │             - attachments
        │             - history and restore
        │             - durable scene persistence
        │
        └── WebSocket ──> collaboration service
                          - room membership
                          - live scene updates
                          - cursor/presence state
                          - reconnect synchronization
```

Room entry should require a short-lived token issued by the Next.js server after checking the user's document permission. The collaboration service should validate that token and restrict the connection to the authorized document room and role.

The room loads its initial scene from durable storage. During collaboration, the service periodically or after a quiet interval persists a canonical scene through one server-owned save path. Attachments continue to use the existing attachment APIs; live messages should reference attachment IDs rather than carry binary data.

## Product Semantics That Need Explicit Design

### History and restore

Per-user edits arrive as a continuous shared stream, so the current meaning of a manual save snapshot cannot be copied unchanged. A later design must decide when collaborative snapshots are created and how their author/origin is presented.

Restore cannot silently replace an active room. It should snapshot the current collaborative state first, then apply the selected historical state as a new room-wide update visible to all participants.

### Local draft recovery

The existing localStorage recovery flow is designed for a single local editor against one server version. In a collaborative room, reconnect synchronization normally becomes the primary recovery mechanism.

During migration, local drafts should only be evaluated before joining a room. If a divergent local draft exists, the user must explicitly choose whether to discard it or import it as a new change after the current room state is loaded. VIEWER users remain server/room-only and must not read or delete local drafts.

### Permissions and presence

Application permissions remain authoritative. Presence is ephemeral and must not be stored as document content. Permission revocation must close or downgrade an existing room connection, not merely block the next page load.

## Relationship to the Single-Editor Lease

The lease is still useful now because collaboration will take materially longer to design and ship. It prevents concurrent writes while preserving the existing save, snapshot, and local recovery model.

Keep the lease isolated at the document write boundary. Do not introduce CRDT types, room abstractions, WebSockets, or generic presence infrastructure into the lease implementation. When collaboration is enabled for a document, the collaboration room replaces the lease rather than layering on top of it.

## Deliberately Deferred

- Redis, horizontal room-server scaling, and multi-region routing
- a generic collaboration framework shared with unrelated features
- collaborative comments, voice/video, or activity feeds
- offline-first collaborative editing guarantees
- a final CRDT-versus-upstream-protocol decision before a focused prototype

Add these only after real concurrency or product requirements demand them.

## Suggested Validation Before Implementation

Build a throwaway prototype against one document with two browsers. It should prove:

1. element create/update/delete convergence;
2. reconnect without losing acknowledged edits;
3. permission-checked room entry and revocation;
4. attachment references surviving synchronization;
5. durable reload after every browser disconnects;
6. snapshot-before-restore behavior for all connected clients.

Use the prototype to choose between adapting Excalidraw's upstream collaboration protocol and mapping the scene to Yjs/Hocuspocus. Do not carry prototype code into production unless its boundaries and failure handling pass review.

## Official References

- [Excalidraw collaboration client](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)
- [Excalidraw room server example](https://github.com/excalidraw/excalidraw-room/blob/master/README.md)
- [Excalidraw development and self-hosting notes](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/introduction/development.mdx)
- [Yjs documentation](https://docs.yjs.dev/)
- [Yjs awareness protocol](https://docs.yjs.dev/api/about-awareness)
- [Yjs offline support](https://docs.yjs.dev/getting-started/allowing-offline-editing)
- [Hocuspocus overview](https://tiptap.dev/hocuspocus/)
- [Hocuspocus provider](https://tiptap.dev/docs/hocuspocus/provider/overview)
