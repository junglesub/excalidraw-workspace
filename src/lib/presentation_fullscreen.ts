export interface StandaloneDisplayState {
  mediaMatches: boolean;
  navigatorStandalone: boolean;
}

export interface FullscreenDocumentLike {
  fullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
}

export interface FullscreenElementLike {
  requestFullscreen?: () => Promise<void>;
}

export type FullscreenToggleResult = "entered" | "exited" | "unsupported" | "failed";

export function fullscreenAvailable(documentLike: Pick<FullscreenDocumentLike, "fullscreenEnabled">): boolean {
  return documentLike.fullscreenEnabled === true;
}

export function isFullscreenActive(documentLike: Pick<FullscreenDocumentLike, "fullscreenElement">): boolean {
  return !!documentLike.fullscreenElement;
}

export function isStandaloneDisplay(state: StandaloneDisplayState): boolean {
  return state.mediaMatches || state.navigatorStandalone;
}

export async function togglePresentationFullscreen(
  documentLike: FullscreenDocumentLike,
  elementLike: FullscreenElementLike,
): Promise<FullscreenToggleResult> {
  try {
    if (documentLike.fullscreenElement) {
      if (!documentLike.exitFullscreen) return "unsupported";
      await documentLike.exitFullscreen();
      return "exited";
    }
    if (!fullscreenAvailable(documentLike) || !elementLike.requestFullscreen) return "unsupported";
    await elementLike.requestFullscreen();
    return "entered";
  } catch {
    return "failed";
  }
}
