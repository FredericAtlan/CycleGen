import type { Metadata } from "next";
import localFont from "next/font/local";
import AppChrome from "@/components/AppChrome";
import { APP_AUTHOR, APP_VERSION } from "@/lib/branding";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: `CycleGen v${APP_VERSION} — ${APP_AUTHOR}`,
  description: `CycleGen by ${APP_AUTHOR} — synthetic automotive driving-cycle studio (route, cycle, simulation, export).`,
  authors: [{ name: APP_AUTHOR }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
