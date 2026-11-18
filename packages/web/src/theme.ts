export type Theme = "system" | "dark" | "light";
const KEY = "cafe.theme";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "system" || v === "light" ? v : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {}
}
