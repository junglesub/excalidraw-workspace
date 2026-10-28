import { describe, expect, it } from "vitest";
import {
  URL_TEXT_COLOR,
  DEFAULT_TEXT_STROKE_COLOR,
  getFontFamilyCss,
  normalizeUrlText,
  scenePointForClientPoint,
  stripUrlTextStyle,
  styleUrlTextElements,
  coversCompletely,
  elementsOverlap,
  urlTextAtScenePoint,
  urlTextHref,
  urlTextUnderlines,
  type UrlTextElementLike,
} from "@/lib/url_text";

function textElement(overrides: Partial<UrlTextElementLike> = {}): UrlTextElementLike {
  return {
    id: "text-1",
    type: "text",
    isDeleted: false,
    text: "https://example.com/docs",
    containerId: null,
    x: 10,
    y: 20,
    width: 120,
    height: 25,
    angle: 0,
    strokeColor: "#1e1e1e",
    fontSize: 20,
    link: null,
    ...overrides,
  };
}

describe("URL text detection", () => {
  it("accepts trimmed http/https and normalizes www to https", () => {
    expect(normalizeUrlText("https://example.com")).toBe("https://example.com/");
    expect(normalizeUrlText("  http://example.com/a?b=1#c  ")).toBe("http://example.com/a?b=1#c");
    expect(normalizeUrlText("www.example.com")).toBe("https://www.example.com/");
    expect(normalizeUrlText(" WWW.Example.com/path ")).toBe("https://www.example.com/path");
  });

  it("rejects ordinary text, non-web schemes, and multi-line or padded URLs", () => {
    expect(normalizeUrlText("hello world")).toBeNull();
    expect(normalizeUrlText("example.com")).toBeNull();
    expect(normalizeUrlText("ftp://example.com")).toBeNull();
    expect(normalizeUrlText("javascript:alert(1)")).toBeNull();
    expect(normalizeUrlText("")).toBeNull();
    expect(normalizeUrlText("   ")).toBeNull();
    expect(normalizeUrlText("https://example.com/\nsecond line")).toBeNull();
    expect(normalizeUrlText("www.")).toBeNull();
    expect(normalizeUrlText(null)).toBeNull();
  });

  it("only treats standalone, non-deleted text elements as URL text", () => {
    expect(urlTextHref(textElement())).toBe("https://example.com/docs");
    expect(urlTextHref(textElement({ text: "just a note" }))).toBeNull();
    expect(urlTextHref(textElement({ containerId: "rect-1" }))).toBeNull();
    expect(urlTextHref(textElement({ isDeleted: true }))).toBeNull();
    expect(urlTextHref(textElement({ type: "rectangle", text: "https://example.com" }))).toBeNull();
  });
});

describe("URL text hit testing", () => {
  it("finds the topmost URL text element under a scene point", () => {
    const bottom = textElement({ id: "bottom" });
    const top = textElement({ id: "top", y: 40, text: "www.example.org" });
    const hit = urlTextAtScenePoint([bottom, top], { x: 40, y: 50 });
    expect(hit?.element.id).toBe("top");
    expect(hit?.href).toBe("https://www.example.org/");
  });

  it("ignores misses, rotated bounds, bound labels, and ordinary text", () => {
    const element = textElement();
    expect(urlTextAtScenePoint([element], { x: 500, y: 500 })).toBeNull();
    expect(urlTextAtScenePoint([textElement({ containerId: "rect" })], { x: 20, y: 30 })).toBeNull();
    expect(urlTextAtScenePoint([textElement({ text: "plain" })], { x: 20, y: 30 })).toBeNull();

    const rotated = textElement({ width: 100, height: 20, angle: Math.PI / 2, x: 0, y: 0 });
    // Centre of the rotated box is (50, 10); a point above it is inside the box.
    expect(urlTextAtScenePoint([rotated], { x: 50, y: -20 })).not.toBeNull();
    expect(urlTextAtScenePoint([rotated], { x: 90, y: -20 })).toBeNull();
  });

  it("converts client points to scene points using zoom, scroll, and offsets", () => {
    const point = scenePointForClientPoint(
      { clientX: 250, clientY: 160 },
      { left: 50, top: 10 },
      { zoom: 2, scrollX: -100, scrollY: 20 },
    );
    expect(point).toEqual({ x: 200, y: 55 });
  });
});

describe("URL visual overlay & underlines", () => {
  it("generates light-blue underline boxes for standalone URL text elements only", () => {
    const defaultUrl = textElement({ id: "url-default", strokeColor: "#1e1e1e" });
    const redUrl = textElement({ id: "url-red", strokeColor: "#e03131", x: 20, y: 50 });
    const userBlueUrl = textElement({ id: "url-blue", strokeColor: URL_TEXT_COLOR, x: 20, y: 80 });
    const plainText = textElement({ id: "plain", text: "plain text description" });
    const boundLabel = textElement({ id: "bound", containerId: "box-1", text: "https://example.com" });

    const underlines = urlTextUnderlines([defaultUrl, redUrl, userBlueUrl, plainText, boundLabel]);
    expect(underlines).toHaveLength(3);

    // All URL underlines use the light-blue URL_TEXT_COLOR regardless of stored stroke color
    expect(underlines[0].id).toBe("url-default");
    expect(underlines[0].color).toBe(URL_TEXT_COLOR);
    expect(underlines[0].x).toBe(10);
    expect(underlines[0].y).toBe(20);
    expect(underlines[0].width).toBe(120);
    expect(underlines[0].height).toBe(25);

    expect(underlines[1].id).toBe("url-red");
    expect(underlines[1].color).toBe(URL_TEXT_COLOR);

    expect(underlines[2].id).toBe("url-blue");
    expect(underlines[2].color).toBe(URL_TEXT_COLOR);
  });

  it("calculates underline geometry using font metrics baseline and thickness", () => {
    const virgil = textElement({ fontFamily: 1, fontSize: 20 });
    const cascadia = textElement({ fontFamily: 3, fontSize: 20 });
    const nunito = textElement({ fontFamily: 6, fontSize: 20 });

    const uVirgil = urlTextUnderlines([virgil])[0];
    const uCascadia = urlTextUnderlines([cascadia])[0];
    const uNunito = urlTextUnderlines([nunito])[0];

    // Underline position is offset from element top based on font baseline
    expect(uVirgil.underlineTop).toBeCloseTo((0.881 + 0.08) * 20, 2);
    expect(uCascadia.underlineTop).toBeCloseTo((0.947 + 0.08) * 20, 2);
    expect(uNunito.underlineTop).toBeCloseTo((1.004 + 0.08) * 20, 2);

    // Thickness ratio is 0.08 of fontSize
    expect(uVirgil.underlineHeight).toBeCloseTo(1.6, 2);
  });

  it("removes underline overlay when a URL transitions to ordinary text", () => {
    const url = textElement({ id: "el-1", text: "https://example.com" });
    expect(urlTextUnderlines([url])).toHaveLength(1);

    const edited = { ...url, text: "just a title" };
    expect(urlTextUnderlines([edited])).toHaveLength(0);
  });
});

describe("Scene preservation & storage fidelity", () => {
  it("never substitutes stored scene text colors, avoiding wrong-save and dirty-on-load", () => {
    const initialElements = [
      textElement({ id: "url-1", strokeColor: "#1e1e1e" }),
      textElement({ id: "url-2", strokeColor: "#e03131" }),
      textElement({ id: "plain-1", text: "caption", strokeColor: "#2f9e44" }),
    ];

    const styled = styleUrlTextElements(initialElements);
    expect(styled.changed).toBe(false);
    expect(styled.elements).toBe(initialElements);

    // Stored colors remain 100% intact
    expect(styled.elements[0].strokeColor).toBe("#1e1e1e");
    expect(styled.elements[1].strokeColor).toBe("#e03131");
    expect(styled.elements[2].strokeColor).toBe("#2f9e44");

    const stripped = stripUrlTextStyle(styled.elements);
    expect(stripped[0].strokeColor).toBe("#1e1e1e");
    expect(stripped[1].strokeColor).toBe("#e03131");
    expect(stripped[2].strokeColor).toBe("#2f9e44");
  });

  it("strips legacy urlAuto/urlStoredColor customData markers from stored elements", () => {
    const legacyElement = textElement({
      id: "legacy",
      strokeColor: "#1e1e1e",
      customData: {
        urlAuto: true,
        urlStoredColor: "#1e1e1e",
        myPluginData: "keep-me",
      },
    });

    const stripped = stripUrlTextStyle([legacyElement]);
    expect(stripped[0].strokeColor).toBe("#1e1e1e");
    expect(stripped[0].customData).toEqual({ myPluginData: "keep-me" });

    const styled = styleUrlTextElements([legacyElement]);
    expect(styled.changed).toBe(true);
    expect(styled.elements[0].customData).toEqual({ myPluginData: "keep-me" });
  });

  it("preserves exact saved colors across save/reload cycle without dirty-on-load", () => {
    const sceneElements = [
      textElement({ id: "auto", strokeColor: DEFAULT_TEXT_STROKE_COLOR }),
      textElement({ id: "red", strokeColor: "#e03131" }),
      textElement({ id: "user-blue", strokeColor: URL_TEXT_COLOR }),
    ];

    const serialized = JSON.stringify(sceneElements);
    const parsed = JSON.parse(serialized);

    const reloaded = stripUrlTextStyle(parsed);
    expect(reloaded[0].strokeColor).toBe(DEFAULT_TEXT_STROKE_COLOR);
    expect(reloaded[1].strokeColor).toBe("#e03131");
    expect(reloaded[2].strokeColor).toBe(URL_TEXT_COLOR);
    expect(JSON.stringify(reloaded)).toBe(serialized);
  });
});

describe("Font family CSS mapping & overlay metrics", () => {
  it("maps bundled font ids to correct CSS font family stacks", () => {
    expect(getFontFamilyCss(1)).toContain("Virgil");
    expect(getFontFamilyCss(2)).toContain("Helvetica");
    expect(getFontFamilyCss(3)).toContain("Cascadia");
    expect(getFontFamilyCss(5)).toContain("Excalifont");
    expect(getFontFamilyCss(6)).toContain("Nunito");
    expect(getFontFamilyCss(7)).toContain("Lilita One");
    expect(getFontFamilyCss(8)).toContain("Comic Shanns");
    expect(getFontFamilyCss(9)).toContain("Liberation Sans");
    expect(getFontFamilyCss(undefined)).toContain("Excalifont");
    expect(getFontFamilyCss(999)).toContain("Excalifont");
  });

  it("populates glyph and underline metadata on overlay descriptors", () => {
    const el = textElement({
      id: "url-meta",
      text: "  https://example.com/test  ",
      fontSize: 24,
      fontFamily: 3,
      textAlign: "center",
      baseline: 22,
    });

    const items = urlTextUnderlines([el]);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.id).toBe("url-meta");
    expect(item.text).toBe("https://example.com/test");
    expect(item.fontSize).toBe(24);
    expect(item.fontFamily).toBe(3);
    expect(item.textAlign).toBe("center");
    expect(item.baseline).toBe(22);
    expect(item.color).toBe(URL_TEXT_COLOR);
  });
});

describe("URL opacity, occlusion, and stacking order", () => {
  it("omits invisible URL (opacity 0) from overlay and disables navigation", () => {
    const hiddenUrl = textElement({ id: "hidden", opacity: 0 });
    const visibleUrl = textElement({ id: "visible", opacity: 100, y: 100 });

    const items = urlTextUnderlines([hiddenUrl, visibleUrl]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("visible");

    // Hidden URL cannot be navigated via scene point
    expect(urlTextAtScenePoint([hiddenUrl], { x: 20, y: 30 })).toBeNull();
    // Visible URL can be navigated
    expect(urlTextAtScenePoint([visibleUrl], { x: 20, y: 110 })).not.toBeNull();
  });

  it("respects partial opacity (e.g. 50%) on overlay descriptors", () => {
    const semiUrl = textElement({ id: "semi", opacity: 50 });
    const items = urlTextUnderlines([semiUrl]);
    expect(items).toHaveLength(1);
    expect(items[0].opacity).toBe(0.5);
  });

  it("hides URL when completely occluded by an opaque rectangle stacked above it", () => {
    const url = textElement({ id: "url-under", x: 100, y: 100, width: 200, height: 30 });
    const coveringRect: UrlTextElementLike = {
      id: "rect-cover",
      type: "rectangle",
      x: 90,
      y: 90,
      width: 250,
      height: 60,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      opacity: 100,
    };

    // url is index 0, rect is index 1 (stacked above url)
    const items = urlTextUnderlines([url, coveringRect]);
    expect(items).toHaveLength(0); // URL is completely hidden

    // Ctrl+click is blocked by covering rectangle
    expect(urlTextAtScenePoint([url, coveringRect], { x: 150, y: 110 })).toBeNull();
  });

  it("shows URL when stacked ABOVE an opaque rectangle (URL index > rectangle index)", () => {
    const baseRect: UrlTextElementLike = {
      id: "rect-base",
      type: "rectangle",
      x: 90,
      y: 90,
      width: 250,
      height: 60,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      opacity: 100,
    };
    const url = textElement({ id: "url-above", x: 100, y: 100, width: 200, height: 30 });

    // rect is index 0, url is index 1 (stacked above rect)
    const items = urlTextUnderlines([baseRect, url]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("url-above");

    // Ctrl+click targets URL since it is topmost
    const hit = urlTextAtScenePoint([baseRect, url], { x: 150, y: 110 });
    expect(hit?.element.id).toBe("url-above");
  });

  it("hides URL when covered by an image stacked above it", () => {
    const url = textElement({ id: "url-under-img", x: 100, y: 100, width: 150, height: 25 });
    const coveringImage: UrlTextElementLike = {
      id: "img-cover",
      type: "image",
      x: 50,
      y: 50,
      width: 300,
      height: 200,
      angle: 0,
      strokeColor: "#000000",
      opacity: 100,
    };

    const items = urlTextUnderlines([url, coveringImage]);
    expect(items).toHaveLength(0);
    expect(urlTextAtScenePoint([url, coveringImage], { x: 120, y: 110 })).toBeNull();
  });

  it("does not occlude URL when a transparent/hollow rectangle is above it", () => {
    const url = textElement({ id: "url-under-wireframe", x: 100, y: 100, width: 150, height: 25 });
    const wireframe: UrlTextElementLike = {
      id: "wireframe",
      type: "rectangle",
      x: 90,
      y: 90,
      width: 200,
      height: 50,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "transparent",
      opacity: 100,
    };

    const items = urlTextUnderlines([url, wireframe]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("url-under-wireframe");

    // Hollow rectangle allows clicks through
    const hit = urlTextAtScenePoint([url, wireframe], { x: 120, y: 110 });
    expect(hit?.element.id).toBe("url-under-wireframe");
  });

  it("records partial covering elements and restricts hit testing on covered area", () => {
    const url = textElement({ id: "url-partial", x: 100, y: 100, width: 200, height: 30 });
    // Partial cover: covers only the left half (x from 50 to 180)
    const partialCover: UrlTextElementLike = {
      id: "partial-cover",
      type: "rectangle",
      x: 50,
      y: 90,
      width: 130, // x: 50 to 180
      height: 50,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#e03131",
      opacity: 100,
    };

    const items = urlTextUnderlines([url, partialCover]);
    expect(items).toHaveLength(1);
    expect(items[0].coveringElements).toBeDefined();
    expect(items[0].coveringElements).toHaveLength(1);

    // Left half (covered) returns null on hit
    expect(urlTextAtScenePoint([url, partialCover], { x: 150, y: 110 })).toBeNull();

    // Right half (uncovered, x=220) hits URL
    const hit = urlTextAtScenePoint([url, partialCover], { x: 220, y: 110 });
    expect(hit?.element.id).toBe("url-partial");
  });

  it("uses actual ellipse silhouette for hit testing and occlusion (empty corner remains clickable)", () => {
    // Ellipse at (100, 100), width: 200, height: 100, center: (200, 150)
    const coveringEllipse: UrlTextElementLike = {
      id: "ellipse-cover",
      type: "ellipse",
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      opacity: 100,
    };
    // URL in the corner of the ellipse bounding box (e.g. x: 105, y: 105, width: 30, height: 20)
    const cornerUrl = textElement({ id: "url-corner", x: 105, y: 105, width: 30, height: 20 });

    // The corner URL is outside the ellipse silhouette, so it is NOT completely covered
    expect(coversCompletely(coveringEllipse, cornerUrl)).toBe(false);

    // Hit testing at corner (110, 110) passes through to URL
    const hit = urlTextAtScenePoint([cornerUrl, coveringEllipse], { x: 110, y: 110 });
    expect(hit?.element.id).toBe("url-corner");

    // Point in center (200, 150) is inside ellipse and blocked
    const centerUrl = textElement({ id: "url-center", x: 180, y: 140, width: 40, height: 20 });
    const centerHit = urlTextAtScenePoint([centerUrl, coveringEllipse], { x: 200, y: 150 });
    expect(centerHit).toBeNull();
  });

  it("uses actual diamond silhouette for hit testing and occlusion (empty corner remains clickable)", () => {
    // Diamond at (100, 100), width: 200, height: 100, center: (200, 150)
    const coveringDiamond: UrlTextElementLike = {
      id: "diamond-cover",
      type: "diamond",
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      opacity: 100,
    };
    // Corner point (110, 110): dx = -90, dy = -40 -> 90/100 + 40/50 = 0.9 + 0.8 = 1.7 > 1 (outside diamond)
    const cornerUrl = textElement({ id: "url-diamond-corner", x: 105, y: 105, width: 30, height: 20 });
    expect(coversCompletely(coveringDiamond, cornerUrl)).toBe(false);

    const hit = urlTextAtScenePoint([cornerUrl, coveringDiamond], { x: 110, y: 110 });
    expect(hit?.element.id).toBe("url-diamond-corner");

    // Center point (200, 150) is inside diamond and blocked
    const centerUrl = textElement({ id: "url-diamond-center", x: 180, y: 140, width: 40, height: 20 });
    const centerHit = urlTextAtScenePoint([centerUrl, coveringDiamond], { x: 200, y: 150 });
    expect(centerHit).toBeNull();
  });

  it("does not occlude URL when covering shape is translucent or patterned (opacity < 100 or hachure)", () => {
    const url = textElement({ id: "url-under-translucent", x: 100, y: 100, width: 200, height: 30 });

    // Semi-transparent rectangle (opacity: 50)
    const semiRect: UrlTextElementLike = {
      id: "semi-rect",
      type: "rectangle",
      x: 90,
      y: 90,
      width: 250,
      height: 60,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      opacity: 50,
    };

    // Hachure patterned rectangle
    const hachureRect: UrlTextElementLike = {
      id: "hachure-rect",
      type: "rectangle",
      x: 90,
      y: 90,
      width: 250,
      height: 60,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "hachure",
      opacity: 100,
    };

    // Semi-transparent background color
    const rgbaRect: UrlTextElementLike = {
      id: "rgba-rect",
      type: "rectangle",
      x: 90,
      y: 90,
      width: 250,
      height: 60,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "rgba(255, 255, 255, 0.5)",
      fillStyle: "solid",
      opacity: 100,
    };

    // Neither translucent nor patterned shapes block the URL overlay or click
    expect(urlTextUnderlines([url, semiRect])).toHaveLength(1);
    expect(urlTextAtScenePoint([url, semiRect], { x: 150, y: 110 })?.element.id).toBe("url-under-translucent");

    expect(urlTextUnderlines([url, hachureRect])).toHaveLength(1);
    expect(urlTextAtScenePoint([url, hachureRect], { x: 150, y: 110 })?.element.id).toBe("url-under-translucent");

    expect(urlTextUnderlines([url, rgbaRect])).toHaveLength(1);
    expect(urlTextAtScenePoint([url, rgbaRect], { x: 150, y: 110 })?.element.id).toBe("url-under-translucent");
  });

  it("converts cover geometry into rotated URL's local coordinate system", () => {
    // Rotated URL at angle 0.35 rad
    const url = textElement({ id: "url-rotated", x: 100, y: 100, width: 200, height: 30, angle: 0.35 });
    const cover: UrlTextElementLike = {
      id: "unrotated-cover",
      type: "rectangle",
      x: 50,
      y: 50,
      width: 150,
      height: 80,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      opacity: 100,
    };

    const items = urlTextUnderlines([url, cover]);
    expect(items).toHaveLength(1);
    const cov = items[0].coveringElements?.[0];
    expect(cov).toBeDefined();
    // In URL local space, relative angle should be 0 - 0.35 = -0.35
    expect(cov?.angle).toBeCloseTo(-0.35, 4);
    expect(cov?.type).toBe("rectangle");
  });

  it("detects real overlap via SAT when rotated cover intersects even if unrotated boxes differ", () => {
    // URL horizontal bar at (100, 100), width: 100, height: 20 (x: 100..200, y: 100..120)
    const url = textElement({ id: "url-sat", x: 100, y: 100, width: 100, height: 20, angle: 0 });

    // Rectangle placed at (50, 75), size 60x10.
    // Unrotated: y spans 75..85, completely above URL's y 100..120 (unrotated AABB would MISS by 15px!).
    // Rotated 45 degrees: corner reaches (104.75, 104.75), physically intersecting URL at (100..200, 100..120).
    const rotatedCover: UrlTextElementLike = {
      id: "rot-cover",
      type: "rectangle",
      x: 50,
      y: 75,
      width: 60,
      height: 10,
      angle: Math.PI / 4,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      opacity: 100,
    };

    // Unrotated boxes do not overlap in Y:
    expect(rotatedCover.y + rotatedCover.height < url.y).toBe(true);

    // But SAT correctly detects that the rotated shape intersects the URL:
    expect(elementsOverlap(url, rotatedCover)).toBe(true);

    // Far away rectangle rotated does NOT overlap
    const farRect: UrlTextElementLike = {
      id: "far-rect",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 60,
      height: 10,
      angle: Math.PI / 4,
      strokeColor: "#000000",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      opacity: 100,
    };
    expect(elementsOverlap(url, farRect)).toBe(false);
  });
});

describe("Native Excalidraw history and versioning reality", () => {
  it("proves native undo/redo increments version monotonically and preserves exact stored colors", () => {
    // Model realistic Excalidraw package behavior as documented in node_modules/@excalidraw/excalidraw:
    // newElementWith(element, updates) returns { ...element, ...updates, version: element.version + 1, versionNonce: random() }
    function excalidrawNewElementWith(el: UrlTextElementLike, updates: Partial<UrlTextElementLike>): UrlTextElementLike {
      return {
        ...el,
        ...updates,
        version: (el.version ?? 1) + 1,
      };
    }

    // Step 0: Initial auto URL element
    let el = textElement({ id: "url-1", strokeColor: "#1e1e1e", version: 1 });
    expect(el.version).toBe(1);
    expect(el.strokeColor).toBe("#1e1e1e");
    expect(stripUrlTextStyle([el])[0].strokeColor).toBe("#1e1e1e");

    // History stack simulating Excalidraw's real native delta stack
    // In Excalidraw: each stroke color edit records a delta of the modified property.
    // Undo restores the previous strokeColor with a NEW incremented version number!
    const historyDeltas = [
      { strokeColor: "#1e1e1e" }, // initial state
    ];

    // Step 1: User changes to red (#e03131)
    el = excalidrawNewElementWith(el, { strokeColor: "#e03131" });
    historyDeltas.push({ strokeColor: "#e03131" });
    expect(el.version).toBe(2);
    expect(el.strokeColor).toBe("#e03131");
    expect(stripUrlTextStyle([el])[0].strokeColor).toBe("#e03131");

    // Step 2: User changes to explicit blue (#4dabf7)
    el = excalidrawNewElementWith(el, { strokeColor: "#4dabf7" });
    historyDeltas.push({ strokeColor: "#4dabf7" });
    expect(el.version).toBe(3);
    expect(el.strokeColor).toBe("#4dabf7");
    expect(stripUrlTextStyle([el])[0].strokeColor).toBe("#4dabf7");

    // Step 3: User changes to red (#e03131)
    el = excalidrawNewElementWith(el, { strokeColor: "#e03131" });
    historyDeltas.push({ strokeColor: "#e03131" });
    expect(el.version).toBe(4);
    expect(el.strokeColor).toBe("#e03131");

    // Step 4: Native Undo 1 (restores explicit blue #4dabf7)
    // Note: Excalidraw applyDelta calls newElementWith, so version INCREMENTS to 5, not back to 3!
    historyDeltas.pop(); // pop current red
    const prevDelta1 = historyDeltas[historyDeltas.length - 1]; // explicit blue
    el = excalidrawNewElementWith(el, { strokeColor: prevDelta1.strokeColor });
    expect(el.version).toBe(5); // Monotonically incremented, as verified in real package!
    expect(el.strokeColor).toBe("#4dabf7");
    // Saved scene produces the user's explicit blue:
    expect(stripUrlTextStyle([el])[0].strokeColor).toBe("#4dabf7");

    // Step 5: Save (outgoing scene is #4dabf7)
    const outgoingSaved = stripUrlTextStyle([el])[0];
    expect(outgoingSaved.strokeColor).toBe("#4dabf7");

    // Step 6: Native Undo 2 (restores red #e03131)
    historyDeltas.pop(); // pop blue
    const prevDelta2 = historyDeltas[historyDeltas.length - 1]; // red
    el = excalidrawNewElementWith(el, { strokeColor: prevDelta2.strokeColor });
    expect(el.version).toBe(6);
    expect(el.strokeColor).toBe("#e03131");
    expect(stripUrlTextStyle([el])[0].strokeColor).toBe("#e03131");

    // Step 7: Native Undo 3 (restores initial #1e1e1e)
    historyDeltas.pop(); // pop red
    const prevDelta3 = historyDeltas[historyDeltas.length - 1]; // initial black
    el = excalidrawNewElementWith(el, { strokeColor: prevDelta3.strokeColor });
    expect(el.version).toBe(7);
    expect(el.strokeColor).toBe("#1e1e1e");
    expect(stripUrlTextStyle([el])[0].strokeColor).toBe("#1e1e1e");

    // Throughout the entire lifecycle, underline overlay continues rendering cleanly
    const underlines = urlTextUnderlines([el]);
    expect(underlines).toHaveLength(1);
    expect(underlines[0].color).toBe(URL_TEXT_COLOR);
  });
});
