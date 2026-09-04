import { handleError, json, readJson, requireUser } from "@/lib/http";
import {
  acquireDeckEditLease,
  heartbeatDeckEditLease,
  pollDeckEditTakeover,
  releaseDeckEditLease,
  requestDeckEditTakeover,
} from "@/lib/deck_edit_lease";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0;
}

function isValidGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseLeaseCredentials(body: Record<string, unknown>, requireGeneration: boolean) {
  if (!isNonEmptyBoundedString(body.clientId) || !isNonEmptyBoundedString(body.leaseToken)) return null;
  if (requireGeneration && !isValidGeneration(body.generation)) return null;
  if (!requireGeneration && body.generation !== undefined && body.generation !== null && !isValidGeneration(body.generation)) return null;
  return {
    clientId: body.clientId,
    leaseToken: body.leaseToken,
    generation: body.generation as number | undefined,
  };
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const user = requireUser(req);
    const body = await readJson(req);
    const action = body.action;
    if (typeof action !== "string" || !["acquire", "heartbeat", "request_takeover", "poll_takeover", "release"].includes(action)) {
      return json({ error: "Invalid action", code: "INVALID_ACTION" }, 400);
    }

    if (action === "acquire") {
      if (!isNonEmptyBoundedString(body.clientId) || !isNonEmptyBoundedString(body.leaseToken)) {
        return json({ error: "clientId and leaseToken are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      let priorLeaseToken: string | undefined;
      let priorGeneration: number | undefined;
      if (body.priorLeaseToken !== undefined || body.priorGeneration !== undefined) {
        if (!isNonEmptyBoundedString(body.priorLeaseToken) || !isValidGeneration(body.priorGeneration)) {
          return json({ error: "prior lease credentials are invalid", code: "INVALID_CREDENTIALS" }, 400);
        }
        priorLeaseToken = body.priorLeaseToken;
        priorGeneration = body.priorGeneration;
      }
      const result = acquireDeckEditLease({
        deckId: id,
        userId: user.id,
        role: user.role,
        clientId: body.clientId,
        leaseToken: body.leaseToken,
        priorLeaseToken,
        priorGeneration,
      });
      if (result.state === "held") return json({ ...result, code: "EDIT_LEASE_HELD" }, 409);
      return json(result, 200);
    }

    if (action === "heartbeat") {
      const creds = parseLeaseCredentials(body, true);
      if (!creds?.generation) return json({ error: "clientId, leaseToken and generation are required", code: "INVALID_CREDENTIALS" }, 400);
      return json(heartbeatDeckEditLease({ deckId: id, userId: user.id, role: user.role, ...creds, generation: creds.generation }), 200);
    }

    if (action === "request_takeover") {
      if (!isNonEmptyBoundedString(body.clientId) || !isNonEmptyBoundedString(body.leaseToken)) {
        return json({ error: "clientId and leaseToken are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      if (body.requestId !== undefined && body.requestId !== null && !isNonEmptyBoundedString(body.requestId)) {
        return json({ error: "requestId must be a valid string", code: "INVALID_CREDENTIALS" }, 400);
      }
      const result = requestDeckEditTakeover({
        deckId: id,
        userId: user.id,
        role: user.role,
        clientId: body.clientId,
        leaseToken: body.leaseToken,
        requestId: body.requestId as string | undefined,
      });
      if (result.state === "takeover_in_progress") return json({ ...result, code: "TAKEOVER_IN_PROGRESS" }, 409);
      if (result.state === "held") return json({ ...result, code: "EDIT_LEASE_HELD" }, 409);
      return json(result, 200);
    }

    if (action === "poll_takeover") {
      const creds = parseLeaseCredentials(body, false);
      if (!creds || !isNonEmptyBoundedString(body.requestId)) {
        return json({ error: "clientId, leaseToken and requestId are required", code: "INVALID_CREDENTIALS" }, 400);
      }
      const result = pollDeckEditTakeover({
        deckId: id,
        userId: user.id,
        role: user.role,
        clientId: creds.clientId,
        leaseToken: creds.leaseToken,
        requestId: body.requestId,
        generation: creds.generation,
      });
      if (result.state === "takeover_in_progress") return json({ ...result, code: "TAKEOVER_IN_PROGRESS" }, 409);
      if (result.state === "held") return json({ ...result, code: "EDIT_LEASE_HELD" }, 409);
      return json(result, 200);
    }

    const creds = parseLeaseCredentials(body, true);
    if (!creds?.generation) return json({ error: "clientId, leaseToken and generation are required", code: "INVALID_CREDENTIALS" }, 400);
    return json(releaseDeckEditLease({ deckId: id, userId: user.id, role: user.role, ...creds, generation: creds.generation }), 200);
  } catch (error) {
    return handleError(error);
  }
}
