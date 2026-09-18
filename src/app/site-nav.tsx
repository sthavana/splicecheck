"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./theme-toggle";

const TOOL = [
  { href: "/", label: "Inspector" },
  { href: "/compare", label: "Pipeline comparison" },
  { href: "/monitors", label: "Monitors" },
  { href: "/simulator", label: "Simulator" },
];

/** Static pages, so they are plain anchors rather than router links. */
const READING = [
  { href: "/guide", label: "Ad insertion" },
  { href: "/streaming", label: "Delivery chain" },
  { href: "/notes/fifty-five-alerts", label: "Fifty-five alerts" },
];

export default function SiteNav() {
  const path = usePathname();

  return (
    <nav className="site-nav" aria-label="Site">
      <Link href="/" className="site-nav-brand">
        Splice<span>Check</span>
      </Link>

      <div className="site-nav-group">
        <h2>Tool</h2>
        <ul>
          {TOOL.map((l) => (
            <li key={l.href}>
              <Link href={l.href} aria-current={path === l.href ? "page" : undefined}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="site-nav-group">
        <h2>Reading</h2>
        <ul>
          {READING.map((l) => (
            <li key={l.href}>
              <a href={l.href}>{l.label}</a>
            </li>
          ))}
        </ul>
      </div>

      <div className="site-nav-foot">
        <a href="https://github.com/sthavana/splicecheck">Source</a>
        <ThemeToggle />
      </div>
    </nav>
  );
}
