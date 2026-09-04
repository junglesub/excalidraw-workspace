import { getDb } from "./db";
import {
  DEFAULT_PRESENTATION_LASER_SETTINGS,
  normalizePresentationLaserSettings,
  type PresentationLaserSettings,
  type PresentationLaserSettingsPatch,
} from "./presentation_laser";

export {
  DEFAULT_PRESENTATION_LASER_SETTINGS,
  normalizePresentationLaserSettings,
  type PresentationLaserSettings,
  type PresentationLaserSettingsPatch,
} from "./presentation_laser";

export function getPresentationLaserSettings(userId: string): PresentationLaserSettings {
  const row = getDb().prepare("SELECT presentation_laser_settings FROM users WHERE id = ?").get(userId) as
    | { presentation_laser_settings: string }
    | undefined;
  if (!row) return DEFAULT_PRESENTATION_LASER_SETTINGS;
  try {
    return normalizePresentationLaserSettings(JSON.parse(row.presentation_laser_settings));
  } catch {
    return DEFAULT_PRESENTATION_LASER_SETTINGS;
  }
}

export function setPresentationLaserSettings(userId: string, patch: PresentationLaserSettingsPatch): PresentationLaserSettings {
  const next = normalizePresentationLaserSettings(patch, getPresentationLaserSettings(userId));
  getDb().prepare("UPDATE users SET presentation_laser_settings = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(next), new Date().toISOString(), userId);
  return next;
}
