import Link from "next/link";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={`motion-safe:animate-spin ${className}`}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

export function RouteLoadingStatus({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`w-full h-full flex items-center justify-center gap-2 text-sm text-gray-500 ${className}`.trim()}
    >
      <Spinner className="h-4 w-4 text-blue-600 shrink-0" />
      <span>{label}</span>
    </div>
  );
}

export function EditorRouteLoadingShell({
  label,
  backgroundClassName = "bg-gray-50",
}: {
  label: string;
  backgroundClassName?: string;
}) {
  return (
    <div className={`h-screen overflow-hidden flex flex-col ${backgroundClassName}`}>
      <header className="h-12 shrink-0 bg-white border-b px-4 flex items-center">
        <Link href="/dashboard" className="text-sm font-medium text-gray-600 hover:text-gray-900">
          ← Dashboard
        </Link>
      </header>
      <main className="flex-1 min-h-0">
        <RouteLoadingStatus label={label} />
      </main>
    </div>
  );
}
