import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Deck Editor presentation session source contract", () => {
  it("passes the owning Deck lease into the embedded Page editor", () => {
    const source = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    expect(source).toContain("externalDeckLease");
    expect(source).toContain("deckLeaseCredentials");
  });

  it("flushes the active Page before routing to Present", () => {
    const source = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    expect(source).toMatch(/async function enterPresent[\s\S]*await flushEditor\(\)[\s\S]*router\.push\(`\/decks\/\$\{deck\.id\}\/present`\)/);
    expect(source).not.toContain('<Link href={`/decks/${deck.id}/present`}');
  });

  it("supports externally owned Deck lease credentials in embedded EditorClient", () => {
    const source = readFileSync("src/app/documents/[id]/EditorClient.tsx", "utf8");
    expect(source).toContain("externalDeckLease");
    expect(source).toContain('leaseScope: "deck"');
  });
});


describe("Present Mode Deck lease source contract", () => {
  it("uses one Deck lease instead of per-Page Document leases", () => {
    const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
    expect(source).toContain("acquireDeckLease(deck.id");
    expect(source).not.toContain("acquireLease(page.documentId");
    expect(source).toContain('leaseScope: "deck"');
    expect(source).toContain("deckId: deck.id");
  });
});

describe("recording camera controls", () => {
  it("exposes Reset View from Deck Editor through the embedded editor control", () => {
    const deckSource = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    const editorSource = readFileSync("src/app/documents/[id]/EditorClient.tsx", "utf8");
    expect(deckSource).toContain("Reset View");
    expect(deckSource).toContain("editorControlRef.current?.resetView()");
    expect(editorSource).toContain("resetView: () =>");
  });

  it("reasserts the recording frame when Present viewport scroll or zoom changes", () => {
    const source = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
    expect(source).toContain("onScrollChange");
    expect(source).toContain("fitRecordingFrame");
    expect(source).toContain('recordingFrameFitOptions("present")');
  });
});

it("does not enter Present before the embedded Page editor is ready to flush", () => {
  const source = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
  expect(source).toMatch(/async function enterPresent[\s\S]*if \(!editorControlRef\.current\)[\s\S]*return;[\s\S]*await flushEditor\(\)/);
});

describe("Deck lease duplicate acquire regression", () => {
  it("uses a persisted pending acquire token instead of creating a new token inside the effect", () => {
    for (const path of [
      "src/app/decks/[id]/DeckEditorClient.tsx",
      "src/app/decks/[id]/present/PresentModeClient.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("getOrCreateDeckLeaseAttemptToken");
      expect(source).not.toMatch(/stored\?\.leaseToken \?\? crypto\.randomUUID\(\)/);
    }
  });

  it("offers Take Over when the Deck lease is held", () => {
    const editor = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    expect(editor).toContain("Take Over");
    expect(editor).toContain("requestDeckTakeover");
    expect(editor).toContain("pollDeckTakeover");
  });
});

describe("Present toolbar layout", () => {
  it("provides pen colors, eraser, and orientation-aware external controls", () => {
    const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
    expect(source).toContain('setTool("eraser")');
    expect(source).toContain("strokeColor");
    expect(source).toContain('deck.aspectRatio === "16:9"');
    expect(source).toContain("present-toolbar-landscape");
    expect(source).toContain("present-toolbar-portrait");
  });

  it("keeps Excalidraw on-screen UI hidden in Present", () => {
    const source = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
    expect(source).toContain(".layer-ui__wrapper");
    expect(source).toContain("display: none !important");
    expect(source).toContain("strokeColor");
  });
});

it("refits the fixed recording frame when the Present canvas viewport resizes", () => {
  const source = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(source).toContain("ResizeObserver");
  expect(source).toMatch(/ResizeObserver[\s\S]*fitRecordingFrame/);
});

it("reapplies the active Present tool after scene hydration", () => {
  const source = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(source).toContain("syncPresentationTool");
  expect(source).toMatch(/hydrateSceneInMemory[\s\S]*syncPresentationTool/);
});

it("offers icon-first Select, Pen, Eraser, and Laser controls", () => {
  const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  for (const label of ["Select", "Pen", "Eraser", "Laser", "Previous page", "Next page", "Reset current page"]) {
    expect(source).toContain(`aria-label="${label}"`);
  }
  expect(source).not.toContain(">Select</button>");
  expect(source).not.toContain(">Pen</button>");
  expect(source).not.toContain(">Erase</button>");
  expect(source).not.toContain(">Laser</button>");
});

it("does not disable Present controls just because an autosave is running", () => {
  const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(source).not.toContain('status === "saving" || status === "blocked" || !deckLeaseReady');
  expect(source).toContain("presentationSceneContentChanged");
});

it("keeps icon-only Undo and removes unsupported Redo wiring", () => {
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(present).toContain('aria-label="Undo"');
  expect(present).not.toContain('aria-label="Redo"');
  expect(present).not.toContain("redoNonce");
  expect(canvas).not.toContain("redoNonce");
  expect(canvas).not.toContain('key: "y"');
});

it("shows one touch toggle after pen detection with no touch action selector", () => {
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(present).toContain("penDetected");
  expect(present).toContain("touchEnabled");
  expect(present).toContain('aria-label={touchEnabled ? "Turn touch off" : "Turn touch on"}');
  expect(present).not.toContain("Touch action mode");
  expect(present).not.toContain("PresentationTouchAction");
  expect(canvas).toContain('event.pointerType === "pen"');
  expect(canvas).toContain("presentationTouchHitsSelectionBounds");
  expect(canvas).toContain("selectedElementIds");
  expect(canvas).toContain("presentationElementsBounds");
});

it("uses same-button double-tap confirmation for Present reset", () => {
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(present).not.toContain('window.confirm(`Reset ${activePage.title}');
  expect(present).toContain("isConfirmedDoubleTap");
  expect(present).toContain("resetArmedAt");
});

it("uses double-tap confirmation for Deck baseline resets without confirm dialogs", () => {
  const source = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
  expect(source).not.toContain('window.confirm(message)');
  expect(source).toContain("baselineResetArmed");
  expect(source).toContain("isConfirmedDoubleTap");
});

it("uses icon-first fullscreen, hide controls, and exit controls in Present", () => {
  const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(source).toContain('aria-label="Full screen"');
  expect(source).toContain('aria-label="Hide controls"');
  expect(source).toContain('aria-label="Exit Present Mode"');
  expect(source).not.toContain('>{fullscreenActive ? "Exit FS" : "Full Screen"}</button>');
});

it("uses exactly one icon-only touch toggle button", () => {
  const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(source).toContain('aria-label={touchEnabled ? "Turn touch off" : "Turn touch on"}');
  expect(source).not.toContain(">Touch Off</button>");
  expect(source).not.toContain(">Touch Action</button>");
  expect((source.match(/setTouchEnabled\(/g) ?? [])).toHaveLength(1);
});

it("keeps Present hit-testing lightweight without statically bundling Excalidraw", () => {
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(canvas).not.toContain('import { getCommonBounds, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw"');
  expect(canvas).toContain("scenePointForPointer");
  expect(canvas).toContain("presentationElementsBounds");
});


it("offers Rectangle and Ellipse as icon-first Present tools", () => {
  const source = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(source).toContain('aria-label="Rectangle"');
  expect(source).toContain('aria-label="Ellipse"');
  expect(source).toContain('setTool("rectangle")');
  expect(source).toContain('setTool("ellipse")');
});

it("uses touch as Pen until a stylus has been detected", () => {
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(present).toContain("penDetected={penDetected}");
  expect(canvas).toContain("penDetected: boolean");
  expect(canvas).toContain("presentationPointerTool(event.pointerType, penDetected");
});

it("changes selected element stroke color without forcing the Pen tool", () => {
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(present).toContain("setStrokeColor(color)");
  expect(present).not.toContain('setStrokeColor(color); setTool("pen")');
  expect(canvas).toContain("applyStrokeColorToSelection");
  expect(canvas).toContain("selectedElementIds");
  expect(canvas).toContain("CaptureUpdateAction.IMMEDIATELY");
});

it("keeps configurable Laser settings outside Present and exposes them in Deck Edit", () => {
  const editor = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(editor).toContain("Laser Settings");
  expect(editor).toContain("Trail length");
  expect(editor).toContain("Trail decay");
  expect(editor).toContain("Dot size");
  expect(editor).toContain("/api/preferences/presentation-laser");
  expect(present).not.toContain("Trail length");
  expect(present).not.toContain("Trail decay");
  expect(present).not.toContain("Dot size");
});

it("re-taps active Laser to toggle persisted Trail and Dot modes", () => {
  const present = readFileSync("src/app/decks/[id]/present/PresentModeClient.tsx", "utf8");
  expect(present).toContain("toggleLaserMode");
  expect(present).toContain('tool === "laser"');
  expect(present).toContain('mode === "trail" ? "dot" : "trail"');
  expect(present).toContain("/api/preferences/presentation-laser");
});

it("renders Present Laser as a scene-neutral configurable overlay", () => {
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(canvas).toContain("presentation-laser-overlay");
  expect(canvas).toContain("laserSettings.trail.decayMs");
  expect(canvas).toContain("laserSettings.trail.length");
  expect(canvas).toContain("laserSettings.dot.size");
  expect(canvas).toContain("pointerEvents: \"none\"");
  expect(canvas).toContain('if (tool === "laser")');
});

it("renders Trail Laser as one continuous fading polyline with a single glowing head", () => {
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(canvas).toContain('laserSettings.mode === "trail"');
  expect(canvas).toContain("<polyline");
  expect(canvas).toContain('laserPoints.map((point) => `${point.x},${point.y}`).join(" ")');
  expect(canvas).toContain("trailOpacity");
  expect(canvas).toContain("<circle");
  expect(canvas).not.toContain("laserPoints.slice(1).map");
  expect(canvas).not.toContain("<line");
  expect(canvas).not.toContain('className="absolute rounded-full"');
});

it("hides Excalidraw mobile misc controls in portrait Present", () => {
  const canvas = readFileSync("src/components/PresentationCanvas.tsx", "utf8");
  expect(canvas).toContain(".presentation-excalidraw .mobile-misc-tools-container");
  expect(canvas).toMatch(/\.presentation-excalidraw \.mobile-misc-tools-container[\s\S]*display: none !important/);
});

describe("aspect-aware Deck Edit chrome", () => {
  it("passes explicit embedded toolbar orientation from Deck aspect ratio", () => {
    const deck = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    const embedded = readFileSync("src/app/decks/[id]/EmbeddedPageEditor.tsx", "utf8");
    const editor = readFileSync("src/app/documents/[id]/EditorClient.tsx", "utf8");
    const canvas = readFileSync("src/components/ExcalidrawCanvas.tsx", "utf8");
    expect(deck).toContain("deckEditorChrome(deck.aspectRatio)");
    expect(deck).toContain("toolbarOrientation={editorChrome.toolbar}");
    expect(embedded).toContain("toolbarOrientation");
    expect(editor).toContain("embeddedToolbarOrientation");
    expect(canvas).toContain("toolbarOrientation");
    expect(canvas).toContain("excalidraw-toolbar-vertical");
    expect(canvas).toContain("excalidraw-toolbar-horizontal");
    expect(canvas).not.toContain("rotate(90deg)");
  });

  it("defines separate portrait rails and a compact landscape bottom bar", () => {
    const deck = readFileSync("src/app/decks/[id]/DeckEditorClient.tsx", "utf8");
    expect(deck).toContain("deck-editor-portrait");
    expect(deck).toContain("portrait-page-rail");
    expect(deck).toContain("portrait-utility-rail");
    expect(deck).toContain("landscape-bottom-bar");
    expect(deck).toContain("Snapshots (");
  });
});
