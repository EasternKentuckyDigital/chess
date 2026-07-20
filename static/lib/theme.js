export function resolveSiteTheme(preference, prefersDark = false) {
  if (preference === "system" || !preference) return prefersDark ? "dark" : "light";
  return ["light", "dark", "dimmed", "warm"].includes(preference) ? preference : (prefersDark ? "dark" : "light");
}
