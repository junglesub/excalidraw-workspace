"use client";

/**
 * Thin fetch helpers used by client components. They attach credentials
 * (the session cookie) automatically and surface API error messages.
 */

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
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(msg);
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
      const msg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `Request failed (${res.status})`;
      throw new Error(msg);
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