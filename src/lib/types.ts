// Shared types across the private Excalidraw workspace.

export type Role = "USER" | "ADMIN";
export type Permission = "OWNER" | "EDITOR" | "VIEWER";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  scene: string; // JSON
  thumbnail_path: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentMeta {
  id: string;
  title: string;
  owner_id: string;
  owner_username: string;
  permission: Permission;
  thumbnail_path: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentMemberRow {
  id: string;
  document_id: string;
  user_id: string;
  permission: Permission;
  created_at: string;
  updated_at: string;
}

export type VersionOrigin =
  | "manual_save"
  | "auto_snapshot"
  | "restore"
  | "recovery_client_draft"
  | "recovery_server_version";

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  version_number: number;
  scene: string; // JSON
  thumbnail_path: string | null;
  created_by: string; // user id
  created_at: string;
  origin: VersionOrigin | null;
}

export interface AttachmentRow {
  id: string;
  document_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  file_path: string;
  sha256: string | null;
  created_at: string;
}

export interface ShareLinkRow {
  id: string;
  document_id: string;
  token: string;
  permission: Permission;
  expires_at: string | null;
  is_active: number;
  created_at: string;
}

/** The standard Excalidraw scene payload shape. */
export interface ExcalidrawScene {
  type: string;
  version: number;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export const DEFAULT_SCENE: ExcalidrawScene = {
  type: "excalidraw",
  version: 2,
  elements: [],
  appState: {},
  files: {},
};

export function emptyScene(): ExcalidrawScene {
  return JSON.parse(JSON.stringify(DEFAULT_SCENE));
}

export function sceneToJson(scene: ExcalidrawScene): string {
  return JSON.stringify(scene);
}

export function jsonToScene(json: string): ExcalidrawScene {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.elements)) {
      return parsed as ExcalidrawScene;
    }
    return emptyScene();
  } catch {
    return emptyScene();
  }
}

export interface ShareLinkInfo {
  documentId: string;
  token: string;
  permission: Permission;
  expires_at: string | null;
}