import { handleError, json, readJson, requireUser, adminModeFrom } from "@/lib/http";
import {
  acquireEditLease,
  heartbeatEditLease,
  requestEditTakeover,
  pollEditTakeover,
  releaseEditLease,
} from "@/lib/edit_lease";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isNonEmptyBoundedString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim().length > 0;
}

function isValidGeneration(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function parseLeaseCredentials(body: Record<string, unknown>, requireGeneration: boolean): { clientId: string; leaseToken: string; generation?: number } | null {
  const clientId = body.clientId;
  const leaseToken = body.leaseToken;
  const generation = body.generation;
  if (!isNonEmptyBoundedString(clientId) || !isNonEmptyBoundedString(leaseToken)) return null;
  if (requireGeneration && !isValidGeneration(generation)) return null;
  if (!requireGeneration && generation !== undefined && generation !== null && !isValidGeneration(generation)) return null;
  return { clientId: clientId as string, leaseToken: leaseToken as string, generation: generation as number | undefined };
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const adminMode = adminModeFrom(req, user);
    const body = await readJson(req);
    const action = body.action;
    if (typeof action !== "string" || !["acquire", "heartbeat", "request_takeover", "poll_takeover", "release"].includes(action)) {
      return json({ error: "Invalid action", code: "INVALID_ACTION" }, 400);
    }

    if (action === "acquire") {
      const clientId = body.clientId;
      const leaseToken = body.leaseToken;
      if (!isNonEmptyBoundedString(clientId) || !isNonEmptyBoundedString(leaseToken)) {
        return json({ error: "clientId and leaseToken are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      // Optional prior server-issued lease credentials proving same-context re-entry.
      // They must be presented as a pair and well-formed; the server itself verifies
      // that they exactly match the active holder.
      let priorLeaseToken: string | undefined;
      let priorGeneration: number | undefined;
      if (body.priorLeaseToken !== undefined || body.priorGeneration !== undefined) {
        if (!isNonEmptyBoundedString(body.priorLeaseToken) || !isValidGeneration(body.priorGeneration)) {
          return json({ error: "prior lease credentials are invalid", code: "INVALID_CREDENTIALS" }, 400);
        }
        priorLeaseToken = body.priorLeaseToken;
        priorGeneration = body.priorGeneration;
      }
      const result = acquireEditLease(
        { docId: id, userId: user.id, role: user.role, adminMode, clientId, leaseToken, priorLeaseToken, priorGeneration },
      );
      if (result.state === "held") {
        return json({ ...result, code: "EDIT_LEASE_HELD" }, 409);
      }
      return json(result, 200);
    }

    if (action === "heartbeat") {
      const creds = parseLeaseCredentials(body, true);
      if (!creds || creds.generation === undefined) {
        return json({ error: "clientId, leaseToken and generation are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      const result = heartbeatEditLease(
        { docId: id, userId: user.id, role: user.role, adminMode, clientId: creds.clientId, leaseToken: creds.leaseToken, generation: creds.generation },
      );
      // heartbeat may return takeover_pending; that's still 200 but signals transfer
      if (result.state === "takeover_pending") {
        return json(result, 200);
      }
      return json(result, 200);
    }

    if (action === "request_takeover") {
      const clientId = body.clientId;
      const leaseToken = body.leaseToken;
      const requestId = body.requestId;
      if (!isNonEmptyBoundedString(clientId) || !isNonEmptyBoundedString(leaseToken)) {
        return json({ error: "clientId and leaseToken are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      if (requestId !== undefined && requestId !== null && !isNonEmptyBoundedString(requestId)) {
        return json({ error: "requestId must be a valid string", code: "INVALID_CREDENTIALS" }, 400);
      }
      const result = requestEditTakeover(
        { docId: id, userId: user.id, role: user.role, adminMode, clientId, leaseToken, requestId: requestId as string | undefined },
      );
      if (result.state === "takeover_in_progress") {
        return json({ ...result, code: "TAKEOVER_IN_PROGRESS" }, 409);
      }
      if (result.state === "held") {
        return json({ ...result, code: "EDIT_LEASE_HELD" }, 409);
      }
      return json(result, 200);
    }

    if (action === "poll_takeover") {
      const creds = parseLeaseCredentials(body, false);
      const requestId = body.requestId;
      if (!creds || !isNonEmptyBoundedString(requestId)) {
        return json({ error: "clientId, leaseToken and requestId are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      if (creds.generation !== undefined && !isValidGeneration(creds.generation)) {
        return json({ error: "generation must be a positive integer", code: "INVALID_CREDENTIALS" }, 400);
      }
      const result = pollEditTakeover(
        { docId: id, userId: user.id, role: user.role, adminMode, clientId: creds.clientId, leaseToken: creds.leaseToken, requestId: requestId as string, generation: creds.generation },
      );
      if (result.state === "takeover_in_progress") {
        return json({ ...result, code: "TAKEOVER_IN_PROGRESS" }, 409);
      }
      if (result.state === "held") {
        return json({ ...result, code: "EDIT_LEASE_HELD" }, 409);
      }
      return json(result, 200);
    }

    if (action === "release") {
      const creds = parseLeaseCredentials(body, true);
      if (!creds || creds.generation === undefined) {
        return json({ error: "clientId, leaseToken and generation are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      const result = releaseEditLease(
        { docId: id, userId: user.id, role: user.role, adminMode, clientId: creds.clientId, leaseToken: creds.leaseToken, generation: creds.generation },
      );
      return json(result, 200);
    }

    return json({ error: "Invalid action" }, 400);
  } catch (err) {
    return handleError(err);
  }
}
