import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import SiteNav from "./site-nav";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SpliceCheck — ad signalling for HLS and DASH",
  description:
    "Ad signalling in HLS and DASH, end to end: inspect a live stream, compare what goes into an ad-insertion service with what comes out, watch it continuously, or build a stream and break it on purpose.",
  metadataBase: new URL("https://splicecheck.vercel.app"),
  // Without these a link posted to LinkedIn or Slack renders as a bare URL,
  // which reads as broken rather than as understated.
  openGraph: {
    title: "SpliceCheck — ad signalling for HLS and DASH",
    description:
      "Inspect a live stream, compare what goes into an ad-insertion service with what comes out, watch it continuously, or build a stream and break it on purpose.",
    url: "https://splicecheck.vercel.app",
    siteName: "SpliceCheck",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "SpliceCheck — ad signalling in HLS and DASH, end to end" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SpliceCheck — ad signalling for HLS and DASH",
    description:
      "Inspect a live stream, compare what goes into an ad-insertion service with what comes out, watch it continuously, or build a stream and break it on purpose.",
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: "/apple-icon.png",
  },
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
      <body className="min-h-full">
        <div className="site-shell">
          <SiteNav />
          <div className="min-w-0">{children}</div>
        </div>
      </body>
    </html>
  );
}
