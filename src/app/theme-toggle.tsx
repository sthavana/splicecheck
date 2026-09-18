"use client";

import { useSyncExternalStore } from "react";

type Choice = "system" | "light" | "dark";

const ORDER: Choice[] = ["system", "light", "dark"];
const LABEL: Record<Choice, string> = { system: "System", light: "Light", dark: "Dark" };
const KEY = "splicecheck-theme";

/*
 * The root attribute is the source of truth — an inline script in the document
 * head stamps it from storage before first paint, so there is no frame of the
 * wrong theme. This subscribes to that attribute rather than keeping a second
 * copy of the state in React.
 */
let listeners: (() => void)[] = [];

function subscribe(cb: () => void) {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function getSnapshot(): Choice {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : "system";
}

/** No stamp exists during server render, which is exactly what "system" means. */
function getServerSnapshot(): Choice {
  return "system";
}

function apply(next: Choice) {
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the choice still applies for this session.
  }
  for (const l of listeners) l();
}

export default function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border border-edge bg-panel p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      {ORDER.map((c) => (
        <button
          key={c}
          id={`theme-${c}`}
          type="button"
          onClick={() => apply(c)}
          aria-pressed={choice === c}
          className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
            choice === c ? "bg-raise-strong text-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {LABEL[c]}
        </button>
      ))}
    </div>
  );
}
