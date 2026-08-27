import { redirect } from "next/navigation";
import ShareViewer from "./ShareViewer";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

/**
 * Public read-only share view. The actual token validation happens client-side
 * against the API (so an expired/invalid link shows a friendly message), and
 * the document is rendered in a read-only viewer.
 */
export default async function SharePage({ params }: PageProps) {
  const { token } = await params;
  if (!token) {
    redirect("/");
  }
  return <ShareViewer token={token} />;
}