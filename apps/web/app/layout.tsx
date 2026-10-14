import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Internship Autopilot",
  description:
    "Discover internships, prepare truthful applications, and track every next step.",
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
