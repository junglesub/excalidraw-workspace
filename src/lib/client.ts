"use client";

/**
 * Thin fetch helpers used by client components. They attach credentials
 * (the session cookie) automatically and surface API error messages.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function parseErrorData(data: unknown, status: number): { message: string; code?: string } {
  if (data && typeof data === "object" && "error" in data) {
    const msg = String((data as { error: unknown }).error);
    const code = "code" in data && typeof (data as { code: unknown }).code === "string" ? String((data as { code: unknown }).code) : undefined;
    return { message: msg, code };
  }
  return { message: `Request failed (${status})` };
}

export async function api<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const { message, code } = parseErrorData(data, res.status);
    throw new ApiError(res.status, message, code);
  }
  return data as T;
}

export function apiForm<T>(url: string, form: FormData): Promise<T> {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    body: form,
  }).then(async (res) => {
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const { message, code } = parseErrorData(data, res.status);
      throw new ApiError(res.status, message, code);
    }
    return data as T;
  });
}

export interface Me {
  user: {
    id: string;
    username: string;
    role: "USER" | "ADMIN";
    is_active: boolean;
  };
}

export async function fetchMe(): Promise<Me["user"]> {
  const data = await api<Me>("/api/auth/me");
  return data.user;
}