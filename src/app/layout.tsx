import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Private Excalidraw Workspace",
  description: "Self-hosted private Excalidraw workspace",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}