export type PresentationLaserMode = "trail" | "dot";

export interface PresentationLaserSettings {
  mode: PresentationLaserMode;
  trail: {
    color: string;
    coreSize: number;
    glowSize: number;
    length: number;
    decayMs: number;
  };
  dot: {
    color: string;
    size: number;
    glowSize: number;
  };
}

export type PresentationLaserSettingsPatch = {
  mode?: PresentationLaserMode;
  trail?: Partial<PresentationLaserSettings["trail"]>;
  dot?: Partial<PresentationLaserSettings["dot"]>;
};

export const DEFAULT_PRESENTATION_LASER_SETTINGS: PresentationLaserSettings = {
  mode: "trail",
  trail: { color: "#e03131", coreSize: 8, glowSize: 18, length: 50, decayMs: 1000 },
  dot: { color: "#e03131", size: 10, glowSize: 22 },
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};

const color = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;

export function normalizePresentationLaserSettings(
  input: PresentationLaserSettingsPatch | null | undefined,
  base: PresentationLaserSettings = DEFAULT_PRESENTATION_LASER_SETTINGS,
): PresentationLaserSettings {
  return {
    mode: input?.mode === "dot" || input?.mode === "trail" ? input.mode : base.mode,
    trail: {
      color: color(input?.trail?.color, base.trail.color),
      coreSize: clamp(input?.trail?.coreSize, 2, 32, base.trail.coreSize),
      glowSize: clamp(input?.trail?.glowSize, 0, 64, base.trail.glowSize),
      length: Math.round(clamp(input?.trail?.length, 5, 200, base.trail.length)),
      decayMs: Math.round(clamp(input?.trail?.decayMs, 100, 5000, base.trail.decayMs)),
    },
    dot: {
      color: color(input?.dot?.color, base.dot.color),
      size: clamp(input?.dot?.size, 2, 32, base.dot.size),
      glowSize: clamp(input?.dot?.glowSize, 0, 64, base.dot.glowSize),
    },
  };
}
