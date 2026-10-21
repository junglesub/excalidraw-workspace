// URL text on the canvas: detect web-URL text elements, render them with a
// light-blue glyph overlay and underline, and resolve Ctrl/Cmd+click targets.
//
// The visual overlay provides the visible light-blue URL presentation
// (both glyphs and underline) without substituting stored scene text colours.
// By keeping stored scene element colours untouched, Excalidraw's native history,
// deltas, undo/redo, save, and reload remain sound and faithful without ambiguous ownership.

/** Slightly light blue used for URL text presentation (glyphs & underline) and links. */
export const URL_TEXT_COLOR = "#4dabf7";

/** Excalidraw's default text stroke colour. */
export const DEFAULT_TEXT_STROKE_COLOR = "#1e1e1e";

/** Underline thickness as a fraction of the font size (scene units). */
const URL_TEXT_UNDERLINE_THICKNESS_RATIO = 0.08;

/** Font family CSS mapping matching Excalidraw bundled fonts. */
export const FONT_FAMILY_NAMES: Record<number, string> = {
  1: 'Virgil, "Segoe UI Emoji"',
  2: 'Helvetica, "Segoe UI Emoji"',
  3: 'Cascadia, "Segoe UI Emoji"',
  5: 'Excalifont, Xiaolai, "Segoe UI Emoji"',
  6: 'Nunito, "Segoe UI Emoji"',
  7: '"Lilita One", "Segoe UI Emoji"',
  8: '"Comic Shanns", "Segoe UI Emoji"',
  9: '"Liberation Sans", "Segoe UI Emoji"',
};

export const DEFAULT_FONT_FAMILY_CSS = 'Excalifont, Xiaolai, "Segoe UI Emoji", sans-serif';

export function getFontFamilyCss(fontFamily?: number): string {
  if (!fontFamily) return DEFAULT_FONT_FAMILY_CSS;
  return FONT_FAMILY_NAMES[fontFamily] ?? DEFAULT_FONT_FAMILY_CSS;
}

/**
 * Baseline position as a fraction of the font size for each bundled font, from
 * the package's font metrics (ascender, descender, and line height). The
 * underline sits just below that baseline.
 */
export const FONT_BASELINE_RATIO: Record<number, number> = {
  1: 0.881, // Virgil
  2: 0.845, // Helvetica
  3: 0.947, // Cascadia
  5: 0.881, // Excalifont
  6: 1.004, // Nunito
  7: 0.927, // Lilita One
  8: 0.875, // Comic Shanns
  9: 0.922, // Liberation Sans
};
export const DEFAULT_FONT_BASELINE_RATIO = 0.947;
export const UNDERLINE_BELOW_BASELINE_RATIO = 0.08;

export interface UrlTextElementLike {
  id: string;
  type: string;
  isDeleted?: boolean;
  opacity?: number;
  backgroundColor?: string;
  fillStyle?: string;
  text?: string | null;
  containerId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  baseline?: number;
  lineHeight?: number;
  link?: string | null;
  customData?: Record<string, any> | null;
  version?: number;
  versionNonce?: number;
}

export interface CoveringElementBox {
  type: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

export interface UrlTextUnderline {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  text: string;
  fontSize: number;
  fontFamily: number;
  textAlign: string;
  baseline: number;
  opacity: number;
  /** Underline offset from the element's top edge, in scene units. */
  underlineTop: number;
  /** Underline thickness in scene units. */
  underlineHeight: number;
  /** Presentation colour, matching URL_TEXT_COLOR. */
  color: string;
  /** Partially covering elements stacked above this element, relative to element coordinates. */
  coveringElements?: CoveringElementBox[];
}

export interface UrlTextGeometryInput {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

const WEB_URL_PATTERN = /^(?:https?:\/\/|www\.)[^\s]+$/i;

/**
 * Returns the normalized destination for a trimmed, single-line web URL, or
 * null when the text is ordinary text. `www.` addresses are normalized to
 * https because they do not carry a scheme of their own.
 */
export function normalizeUrlText(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || !WEB_URL_PATTERN.test(trimmed)) return null;
  const withScheme = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** True for a standalone text element whose entire (trimmed) text is a web URL. */
export function isUrlTextElement(element: UrlTextElementLike): boolean {
  return urlTextHref(element) !== null;
}

/** Destination for a standalone URL text element, or null. */
export function urlTextHref(element: UrlTextElementLike): string | null {
  if (element.type !== "text" || element.isDeleted === true) return null;
  if (element.containerId) return null;
  return normalizeUrlText(element.text);
}

/** True if a CSS color string represents a solid opaque colour (alpha >= 0.99). */
export function isOpaqueColor(color?: string | null): boolean {
  if (!color) return false;
  const trimmed = color.trim().toLowerCase();
  if (trimmed === "transparent") return false;
  if (trimmed.startsWith("rgba(")) {
    const parts = trimmed.slice(5, -1).split(",").map((s) => s.trim());
    if (parts.length === 4) {
      const alpha = parseFloat(parts[3]);
      return !isNaN(alpha) && alpha >= 0.99;
    }
    return false;
  }
  if (trimmed.startsWith("hsla(")) {
    const parts = trimmed.slice(5, -1).split(",").map((s) => s.trim());
    if (parts.length === 4) {
      const alpha = parseFloat(parts[3]);
      return !isNaN(alpha) && alpha >= 0.99;
    }
    return false;
  }
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 8) {
      const alpha = parseInt(hex.slice(6, 8), 16);
      return alpha >= 250;
    }
    if (hex.length === 4) {
      const alpha = parseInt(hex[3] + hex[3], 16);
      return alpha >= 250;
    }
    return hex.length === 3 || hex.length === 6;
  }
  return true;
}

/** True if an element is opaque and can occlude content beneath it. */
export function isCoveringElement(element: UrlTextElementLike): boolean {
  if (element.isDeleted) return false;
  const opacity = element.opacity ?? 100;
  if (opacity < 100) return false; // Translucent shapes cannot solidly cover

  if (
    element.type === "rectangle" ||
    element.type === "diamond" ||
    element.type === "ellipse" ||
    element.type === "frame"
  ) {
    if (element.fillStyle && element.fillStyle !== "solid") return false;
    return isOpaqueColor(element.backgroundColor);
  }

  if (element.type === "image") {
    return opacity === 100;
  }

  return false;
}

/** Returns the 4 corner points of an element in scene coordinates. */
export function getElementCorners(element: UrlTextElementLike): { x: number; y: number }[] {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  const hw = element.width / 2;
  const hh = element.height / 2;
  if (!element.angle) {
    return [
      { x: cx - hw, y: cy - hh },
      { x: cx + hw, y: cy - hh },
      { x: cx + hw, y: cy + hh },
      { x: cx - hw, y: cy + hh },
    ];
  }
  const cos = Math.cos(element.angle);
  const sin = Math.sin(element.angle);
  const dxs = [-hw, hw, hw, -hw];
  const dys = [-hh, -hh, hh, hh];
  return dxs.map((dx, i) => ({
    x: cx + dx * cos - dys[i] * sin,
    y: cy + dx * sin + dys[i] * cos,
  }));
}

/** True if two elements have overlapping oriented bounding boxes (Separating Axis Theorem). */
export function elementsOverlap(a: UrlTextElementLike, b: UrlTextElementLike): boolean {
  const cornersA = getElementCorners(a);
  const cornersB = getElementCorners(b);

  const axes: { x: number; y: number }[] = [];
  function addAxes(corners: { x: number; y: number }[]) {
    for (let i = 0; i < 2; i++) {
      const p1 = corners[i];
      const p2 = corners[i + 1];
      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const len = Math.hypot(ex, ey);
      if (len > 0) {
        axes.push({ x: -ey / len, y: ex / len });
      }
    }
  }

  addAxes(cornersA);
  addAxes(cornersB);

  for (const axis of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    for (const p of cornersA) {
      const proj = p.x * axis.x + p.y * axis.y;
      if (proj < minA) minA = proj;
      if (proj > maxA) maxA = proj;
    }

    let minB = Infinity;
    let maxB = -Infinity;
    for (const p of cornersB) {
      const proj = p.x * axis.x + p.y * axis.y;
      if (proj < minB) minB = proj;
      if (proj > maxB) maxB = proj;
    }

    if (maxA < minB || maxB < minA) {
      return false;
    }
  }

  return true;
}

/**
 * Tests whether a scene point lies inside an element's actual shape silhouette
 * (respecting rotated ellipse, diamond, or rectangular bounds).
 */
export function pointInsideElement(element: UrlTextElementLike, point: { x: number; y: number }): boolean {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  const hw = element.width / 2;
  const hh = element.height / 2;
  if (hw <= 0 || hh <= 0) return false;

  const dx = point.x - cx;
  const dy = point.y - cy;

  let lx = dx;
  let ly = dy;
  if (element.angle) {
    const cos = Math.cos(-element.angle);
    const sin = Math.sin(-element.angle);
    lx = dx * cos - dy * sin;
    ly = dx * sin + dy * cos;
  }

  if (Math.abs(lx) > hw || Math.abs(ly) > hh) {
    return false;
  }

  if (element.type === "ellipse") {
    const nx = lx / hw;
    const ny = ly / hh;
    return nx * nx + ny * ny <= 1;
  }

  if (element.type === "diamond") {
    return Math.abs(lx) / hw + Math.abs(ly) / hh <= 1;
  }

  return true;
}

/** True if `cover` completely encloses `target` (checks all convex vertices). */
export function coversCompletely(cover: UrlTextElementLike, target: UrlTextElementLike): boolean {
  const corners = getElementCorners(target);
  return corners.every((pt) => pointInsideElement(cover, pt));
}

/** Topmost standalone URL text element under a scene point. */
export function urlTextAtScenePoint(
  elements: readonly UrlTextElementLike[],
  point: { x: number; y: number },
): { element: UrlTextElementLike; href: string } | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element.isDeleted) continue;
    if ((element.opacity ?? 100) <= 0) continue;

    if (!pointInsideElement(element, point)) continue;

    // Point hits this element!
    // If it's a visible URL text element, return it.
    const href = urlTextHref(element);
    if (href) {
      return { element, href };
    }

    // If it's an opaque covering element or text stacked above,
    // it blocks any underlying elements at this point.
    if (isCoveringElement(element) || element.type === "text") {
      return null;
    }
  }
  return null;
}

/**
 * Converts a viewport (client) point into Excalidraw scene coordinates.
 * `canvasRect` is the canvas/wrapper box; the scene is drawn at
 * `(scene + scroll) * zoom` inside it.
 */
export function scenePointForClientPoint(
  client: { clientX: number; clientY: number },
  canvasRect: { left: number; top: number },
  geometry: UrlTextGeometryInput,
): { x: number; y: number } {
  const zoom = geometry.zoom || 1;
  return {
    x: (client.clientX - canvasRect.left) / zoom - geometry.scrollX,
    y: (client.clientY - canvasRect.top) / zoom - geometry.scrollY,
  };
}

/** Overlay descriptors (scene units) for every visible, unoccluded URL text element. */
export function urlTextUnderlines(
  elements: readonly UrlTextElementLike[],
): UrlTextUnderline[] {
  const items: UrlTextUnderline[] = [];
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (!isUrlTextElement(element)) continue;
    const opacityPct = element.opacity ?? 100;
    if (opacityPct <= 0) continue; // Invisible text produces no overlay

    // Check for covering elements stacked ABOVE this element (index > i)
    let isFullyCovered = false;
    const covering: CoveringElementBox[] = [];

    const cxU = element.x + element.width / 2;
    const cyU = element.y + element.height / 2;
    const angleU = element.angle || 0;
    const cosU = Math.cos(-angleU);
    const sinU = Math.sin(-angleU);

    for (let j = i + 1; j < elements.length; j++) {
      const other = elements[j];
      if (!isCoveringElement(other)) continue;
      if (!elementsOverlap(element, other)) continue;

      if (coversCompletely(other, element)) {
        isFullyCovered = true;
        break;
      }

      const cxC = other.x + other.width / 2;
      const cyC = other.y + other.height / 2;
      const angleC = other.angle || 0;

      const dx = cxC - cxU;
      const dy = cyC - cyU;
      const localCx = dx * cosU - dy * sinU + element.width / 2;
      const localCy = dx * sinU + dy * cosU + element.height / 2;
      const localAngle = angleC - angleU;

      covering.push({
        type: other.type,
        x: localCx - other.width / 2,
        y: localCy - other.height / 2,
        cx: localCx,
        cy: localCy,
        width: other.width,
        height: other.height,
        angle: localAngle,
      });
    }

    if (isFullyCovered) continue; // Completely occluded URL is not rendered

    const fontSize = element.fontSize ?? 20;
    const fontFamily = element.fontFamily ?? 5;
    const baselineRatio = FONT_BASELINE_RATIO[fontFamily] ?? DEFAULT_FONT_BASELINE_RATIO;
    const baseline = element.baseline ?? Math.round(fontSize * baselineRatio);

    items.push({
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      angle: element.angle,
      text: element.text?.trim() ?? "",
      fontSize,
      fontFamily,
      textAlign: element.textAlign || "left",
      baseline,
      opacity: opacityPct / 100,
      underlineTop: (baselineRatio + UNDERLINE_BELOW_BASELINE_RATIO) * fontSize,
      underlineHeight: Math.max(1, fontSize * URL_TEXT_UNDERLINE_THICKNESS_RATIO),
      color: URL_TEXT_COLOR,
      coveringElements: covering.length > 0 ? covering : undefined,
    });
  }
  return items;
}

export interface UrlTextStyleResult<T extends UrlTextElementLike> {
  elements: T[];
  changed: boolean;
}

/**
 * Pass-through style evaluator: stored scene text colours are never substituted,
 * eliminating ambiguous ownership and history synchronization issues. Cleans up
 * any legacy customData metadata markers if encountered.
 */
export function styleUrlTextElements<T extends UrlTextElementLike>(
  elements: readonly T[],
): UrlTextStyleResult<T> {
  let modified = false;
  const next = elements.map((element) => {
    if (element.customData && ("urlAuto" in element.customData || "urlStoredColor" in element.customData)) {
      modified = true;
      const copy = { ...element.customData };
      delete copy.urlAuto;
      delete copy.urlStoredColor;
      return {
        ...element,
        customData: Object.keys(copy).length > 0 ? copy : undefined,
      };
    }
    return element;
  });

  return { elements: modified ? (next as T[]) : (elements as T[]), changed: modified };
}

/**
 * Strips any legacy display metadata markers so saved documents remain clean.
 * Stored element colours pass through completely untouched.
 */
export function stripUrlTextStyle<T extends UrlTextElementLike>(
  elements: readonly T[],
): T[] {
  let modified = false;
  const next = elements.map((element) => {
    if (element.customData && ("urlAuto" in element.customData || "urlStoredColor" in element.customData)) {
      modified = true;
      const copy = { ...element.customData };
      delete copy.urlAuto;
      delete copy.urlStoredColor;
      return {
        ...element,
        customData: Object.keys(copy).length > 0 ? copy : undefined,
      };
    }
    return element;
  });

  return modified ? (next as T[]) : (elements as T[]);
}
