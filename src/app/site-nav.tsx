"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./theme-toggle";

interface Group {
  title: string;
  /** What the group is for — the difference between these is not obvious from the names. */
  note: string;
  items: { href: string; label: string; external?: boolean }[];
}

/**
 * The simulator sits in its own group rather than under the tool. Everything
 * under TOOL points at a stream somebody else is running; the simulator builds
 * the stream first and then analyses it, which is a different thing to reach
 * for and belongs under its own heading.
 */
const GROUPS: Group[] = [
  {
    title: "Tool",
    note: "Point it at a live stream",
    items: [
      { href: "/", label: "Inspector" },
      { href: "/compare", label: "Pipeline comparison" },
      { href: "/monitors", label: "Monitors" },
      { href: "/vast", label: "Ad response" },
    ],
  },
  {
    title: "Simulator",
    note: "Build a stream, then break it",
    items: [{ href: "/simulator", label: "Chain simulator" }],
  },
  {
    title: "Reading",
    note: "How the chain works",
    // Static pages, so these are plain anchors rather than router links.
    items: [
      { href: "/guide", label: "Ad insertion", external: true },
      { href: "/streaming", label: "Delivery chain", external: true },
      { href: "/notes/fifty-five-alerts", label: "Fifty-five alerts", external: true },
    ],
  },
];

export default function SiteNav() {
  const path = usePathname();

  return (
    <nav className="site-nav" aria-label="Site">
      <Link href="/" className="site-nav-brand">
        Splice<span>Check</span>
      </Link>

      {GROUPS.map((g) => (
        <div className="site-nav-group" key={g.title}>
          <h2>{g.title}</h2>
          <p className="site-nav-note">{g.note}</p>
          <ul>
            {g.items.map((l) => (
              <li key={l.href}>
                {l.external ? (
                  <a href={l.href}>{l.label}</a>
                ) : (
                  <Link href={l.href} aria-current={path === l.href ? "page" : undefined}>
                    {l.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="site-nav-foot">
        <a href="https://github.com/sthavana/splicecheck">Source</a>
        <ThemeToggle />
      </div>
    </nav>
  );
}
