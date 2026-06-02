import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Withers CRM",
  description: "Catering pipeline",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
