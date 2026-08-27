import { redirect } from "next/navigation";
import ShareViewer from "./ShareViewer";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { token: string };
}

/**
 * Public read-only share view. The actual token validation happens client-side
 * against the API (so an expired/invalid link shows a friendly message), and
 * the document is rendered in a read-only viewer.
 */
export default function SharePage({ params }: PageProps) {
  if (!params?.token) {
    redirect("/");
  }
  return <ShareViewer token={params.token} />;
}