import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { Footer, Nav } from "@/components/chrome";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", axes: ["wdth"], display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "311Relay · Operations",
  description: "See something. Send it. Track it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <div className="hazard h-1.5" aria-hidden />
        <header className="border-b border-rule bg-paper/90 backdrop-blur-[2px]">
          <div className="mx-auto flex max-w-[1480px] items-center gap-6 px-6 py-3">
            <Link href="/" className="group flex items-baseline gap-3" aria-label="311Relay home">
              <span className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-full bg-signal font-wide text-[11px] font-black text-white">311</span>
                <span className="font-wide text-[22px] font-black leading-none tracking-tight">
                  311<span className="text-signal">Relay</span>
                </span>
              </span>
            </Link>
            <div className="ml-auto">
              <Suspense>
                <Nav />
              </Suspense>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1480px] px-6 pt-6">{children}</main>
        <Suspense>
          <Footer />
        </Suspense>
      </body>
    </html>
  );
}
