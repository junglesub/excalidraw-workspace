import { handleError, json, readJson, requireUser } from "@/lib/http";
import { getPresentationLaserSettings, setPresentationLaserSettings } from "@/lib/presentation_laser_settings";

export async function GET(req: Request) {
  try {
    const user = requireUser(req);
    return json({ settings: getPresentationLaserSettings(user.id) });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const user = requireUser(req);
    const body = await readJson(req, 32 * 1024);
    return json({ settings: setPresentationLaserSettings(user.id, body) });
  } catch (err) {
    return handleError(err);
  }
}
