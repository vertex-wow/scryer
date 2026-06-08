import { setupDropdown } from "../dropdown.js";

const LOCALES = [
  { value: "enUS", label: "English (US)" },
  { value: "enGB", label: "English (GB)" },
  { value: "deDE", label: "German" },
  { value: "frFR", label: "French" },
  { value: "esES", label: "Spanish (Spain)" },
  { value: "esMX", label: "Spanish (Latin America)" },
  { value: "ptBR", label: "Portuguese (Brazil)" },
  { value: "ptPT", label: "Portuguese (Portugal)" },
  { value: "ruRU", label: "Russian" },
  { value: "koKR", label: "Korean" },
  { value: "zhTW", label: "Traditional Chinese" },
  { value: "zhCN", label: "Simplified Chinese" },
  { value: "itIT", label: "Italian" },
];

export function getLocaleLabel(val: string): string {
  const loc = LOCALES.find((l) => l.value === val);
  return loc ? loc.label : val;
}

export function buildLocaleDropdownHtml(currentLocale: string): string {
  const s = (val: string, target: string) => (val === target ? " selected" : "");

  // Determine prefix display
  let displayTop = currentLocale;
  let displayBottom = "";

  // Parse lang and region, e.g. "enUS" -> "en", "US"
  if (currentLocale && currentLocale.length === 4) {
    const lang = currentLocale.substring(0, 2);
    const region = currentLocale.substring(2, 4);

    // Check if this lang prefix is unique in our list
    const matchingPrefixes = LOCALES.filter((l) => l.value.startsWith(lang));

    if (matchingPrefixes.length === 1) {
      displayTop = lang;
    } else {
      displayTop = lang;
      displayBottom = region;
    }
  }

  const triggerLabel = displayBottom
    ? `<div class="locale-stack"><span>${displayTop}</span><span>${displayBottom}</span></div>`
    : `<span class="locale-single">${displayTop}</span>`;

  const fullLabel = getLocaleLabel(currentLocale);
  const tooltip = `WoW locale (GetLocale)&#10;${fullLabel}`;

  return `
    <div id="locale-dropdown" class="custom-dropdown" title="${tooltip}">
      <div id="locale-dropdown-trigger" class="custom-dropdown-trigger">
        ${triggerLabel}
      </div>
      <div id="locale-dropdown-menu" class="custom-dropdown-menu hidden">
        ${LOCALES.map(
          (loc) => `
          <div class="dropdown-item${s(currentLocale, loc.value)}" data-value="${loc.value}">
            <span class="dropdown-item-text">${loc.value} - ${loc.label}</span>
          </div>
        `,
        ).join("")}
      </div>
    </div>
  `;
}

export function setupLocaleDropdown() {
  setupDropdown("locale-dropdown", "locale-dropdown-menu", (value) => {
    // We expect vscode to be available in the global scope in main.ts
    // but to avoid undefined error, we dispatch an event
    const evt = new CustomEvent("localeChange", { detail: value });
    document.dispatchEvent(evt);
  });
}
