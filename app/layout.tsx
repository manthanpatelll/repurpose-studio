import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Repurpose Studio",
  description:
    "A local, in-browser NLE that auto-cuts retakes from raw footage into vertical short-form clips.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
