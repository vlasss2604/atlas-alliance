import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";

// FONTS ARE FILES IN THE REPO (app/fonts) — the build never fetches from
// Google Fonts. V7 typography is Inter (HANDOFF §2, D2), variable weight,
// served as two subsets: Latin and Cyrillic (RU). The stack in globals.css
// names both, so a Cyrillic glyph falls through to the Cyrillic file.
// Inter and Geist Mono are licensed under the SIL Open Font License 1.1.
const interLatin = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  weight: "400 800",
  display: "swap",
  // No generated Arial fallback in this stack entry: it carries Cyrillic
  // and would catch RU text before the Cyrillic Inter file below.
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});
const interCyrillic = localFont({
  src: "./fonts/inter-cyrillic.woff2",
  variable: "--font-inter-cyrillic",
  weight: "400 800",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" }],
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ATLAS PROOF",
  description: "Research Intelligence for Digital Assets",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#06213b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${interLatin.variable} ${interCyrillic.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* Telegram Mini App SDK: единственный внешний скрипт; используется
            только внутри TelegramPlatformAdapter (src/client/platform.ts). */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        {children}
      </body>
    </html>
  );
}
