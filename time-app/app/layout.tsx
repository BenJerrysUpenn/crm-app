import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Withers Time",
  description: "Scheduling and time clock",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
