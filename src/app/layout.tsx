import "./globals.css";
import type { Metadata } from "next";
import { Footer } from "@/components/layouts/Footer";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { ThemeProvider } from "@/components/layouts/ThemeProvider";
import { Toaster } from "@/components/layouts/Toaster";
import { getServerLocale } from "@/lib/i18n/server";
import { NavigationLoadingBar } from "@/components/NavigationLoadingBar";

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
    <html lang={initialLocale} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col antialiased">
        <ThemeProvider>
          <I18nProvider initialLocale={initialLocale}>
            <Toaster>
              <NavigationLoadingBar />
              <div className="flex flex-1 flex-col">{children}</div>
              <Footer />
            </Toaster>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
