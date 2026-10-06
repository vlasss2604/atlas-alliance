// THE DISPLAY LANGUAGE FOR DATES AND "TIME AGO" (D-171).
//
// Presentation only. The app provider sets it from the user's saved
// language (/api/me) before its children render, so every formatted day
// and relative age on screen follows the user's explicit EN / RU choice.
// English is the default; nothing here reads a browser, device or
// Telegram locale. It never reaches the server and decides nothing.
export type DisplayLanguage = "EN" | "RU";

let current: DisplayLanguage = "EN";

export function setDisplayLanguage(language: DisplayLanguage): void {
  current = language;
}

export function displayLanguage(): DisplayLanguage {
  return current;
}
