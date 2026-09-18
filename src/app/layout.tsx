import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ThemeToggle from "./theme-toggle";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SpliceCheck — ad-break inspector for HLS and DASH",
  description:
    "Point it at a stream and see every ad break, the decoded SCTE-35 behind it, and what will break in server-side ad insertion.",
};

/**
 * Applies a stored theme choice before first paint, so a viewer who picked
 * light does not get a frame of dark first. Absence of a stamp means "system".
 */
const noFlash = `(function(){try{var t=localStorage.getItem("splicecheck-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body className="min-h-full flex flex-col">
        <div className="pointer-events-none fixed right-3 top-3 z-50 sm:right-5 sm:top-5">
          <div className="pointer-events-auto">
            <ThemeToggle />
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
