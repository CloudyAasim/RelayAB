import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Footer } from "@/components/layouts/Footer";
import { I18nProvider } from "@/components/i18n/I18nProvider";
import { ThemeProvider } from "@/components/layouts/ThemeProvider";
import { Toaster } from "@/components/layouts/Toaster";
import { getServerLocale } from "@/lib/i18n/server";
import { NavigationLoadingBar } from "@/components/NavigationLoadingBar";
import { resolvePublicUrl } from "@/lib/public-url";

/**
 * The line Google prints under the title.
 *
 * It used to be the same phrase as the H1 ("自托管 AI API 网关 — 用户自助管理 ·
 * 管理员可控额度"), so the crawler filled the rest of the snippet by repeating
 * the heading: the result read as the same sentence twice and a cut-off third.
 * A description earns its space by answering what the page is *for*, in the
 * words someone would search with.
 */
const DESCRIPTION =
  "RelayAB 是自托管的 AI API 网关：把上游模型密钥收拢到一处，统一代理 OpenAI 兼容与 Anthropic 请求，按 Key 分配额度、模型权限与有效期，并记录每次调用的用量。";

/** Absolute base for canonical, Open Graph and the sitemap. */
async function metadataBase(): Promise<URL | undefined> {
  try {
    return new URL(await resolvePublicUrl());
  } catch {
    // A malformed configured URL must not take every page down with it; the
    // tags simply go out without an absolute base, as they did before.
    return undefined;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const base = await metadataBase();
  return {
    metadataBase: base,
    title: {
      default: "RelayAB",
      template: "%s · RelayAB",
    },
    description: DESCRIPTION,
    applicationName: "RelayAB",
    openGraph: {
      type: "website",
      siteName: "RelayAB",
      title: "RelayAB — 自托管 AI API 网关",
      description: DESCRIPTION,
    },
    twitter: {
      card: "summary",
      title: "RelayAB — 自托管 AI API 网关",
      description: DESCRIPTION,
      images: ["/icon.png"],
    },
  };
}

/**
 * `resizes-content` tells a browser to shrink the layout viewport when the on-screen
 * keyboard opens. Without it the keyboard is an overlay: the composer - which is
 * pinned to the bottom of a full-height chat - sits underneath it, and no amount
 * of viewport arithmetic fixes that. Browsers that do not implement it ignore the
 * value and behave as before.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // iOS zooms the page when a field is focused if the layout is only as wide as
  // the device; capping the scale stops that sideways scroll being locked in.
  maximumScale: 5,
  interactiveWidget: "resizes-content",
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
