import "./globals.css";
import type { Metadata } from "next";
import { Footer } from "@/components/layouts/Footer";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { ThemeProvider } from "@/components/layouts/ThemeProvider";
import { getServerLocale } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: {
    default: "RelayAB",
    template: "%s · RelayAB",
  },
  description: "自托管 AI API 网关 — 用户自助管理 · 管理员可控额度",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initialLocale = await getServerLocale();
  return (
    // next-themes writes the `class` attribute on <html> client-side; we
    // suppress the resulting hydration warning because the class is
    // expected to differ between server and client.
    <html lang={initialLocale} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col antialiased">
        <ThemeProvider>
          <I18nProvider initialLocale={initialLocale}>
            <div className="flex flex-1 flex-col">{children}</div>
            <Footer />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
