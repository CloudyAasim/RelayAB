import "./globals.css";
import type { Metadata } from "next";
import { Footer } from "@/components/layouts/Footer";

export const metadata: Metadata = {
  title: "RelayAB",
  description: "Self-hosted AI API gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col antialiased">
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
