/** Follow-up draft + AI Sales Agent speaking languages (incl. JP / PH). */

export type FollowupLanguageOption = {
  code: string;
  label: string;
};

export const FOLLOWUP_LANGUAGES: FollowupLanguageOption[] = [
  { code: "en", label: "🇺🇸 English (Default)" },
  { code: "ur", label: "🇵🇰 Urdu (اردو)" },
  { code: "fr", label: "🇫🇷 French (Français)" },
  { code: "ar", label: "🇸🇦 Arabic (العربية)" },
  { code: "de", label: "🇩🇪 German (Deutsch)" },
  { code: "ru", label: "🇷🇺 Russian (Русский)" },
  { code: "zh", label: "🇨🇳 Chinese (中文)" },
  { code: "ja", label: "🇯🇵 Japanese (日本語)" },
  { code: "fil", label: "🇵🇭 Filipino / Tagalog" },
];
