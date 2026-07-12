import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Repurpose Studio",
};

export default function RepurposeStudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
