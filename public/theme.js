/*
 * Theme control for the static reading pages.
 *
 * The tool's nav has a React toggle; these pages are plain HTML, so this is the
 * same control written once and shared by all three. It uses the same storage
 * key and the same root attribute as the tool, so a choice made on either side
 * carries across the whole site.
 *
 * Loaded synchronously in the head: the stamping below has to happen before
 * first paint, or a viewer who picked light gets a frame of dark first.
 */
(function () {
  var KEY = "splicecheck-theme";
  var root = document.documentElement;

  try {
    var stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);
  } catch (e) {
    // Storage blocked: fall through to the system preference.
  }

  var ORDER = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  var buttons = [];

  /** Absence of a stamp is exactly what "system" means. */
  function current() {
    var t = root.getAttribute("data-theme");
    return t === "light" || t === "dark" ? t : "system";
  }

  function paint() {
    var c = current();
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-choice") === c));
    }
  }

  function apply(next) {
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch (e) {
      // Storage blocked: the choice still applies for this page view.
    }
    paint();
  }

  function mount() {
    var foot = document.querySelector(".site-nav-foot");
    if (!foot) return;

    var group = document.createElement("div");
    group.className = "theme-toggle";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Colour theme");

    ORDER.forEach(function (opt) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-choice", opt[0]);
      b.textContent = opt[1];
      b.addEventListener("click", function () { apply(opt[0]); });
      group.appendChild(b);
      buttons.push(b);
    });

    foot.appendChild(group);
    paint();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
