/* eslint-disable no-undef, no-restricted-globals */
/**
 * Script for Academic Lens pane in Zotero's Preferences window.
 * Registered via scripts option in Zotero.PreferencePanes.register() (Beaver pattern).
 */
document.addEventListener("command", (event) => {
  const target = event.target;
  if (!target || target.id !== "al-open-settings-btn") {
    return;
  }

  try {
    const al = (typeof Zotero !== "undefined" && Zotero.AcademicLens) || window.opener?.Zotero?.AcademicLens;
    if (al && typeof al.openSettingsWindow === "function") {
      al.openSettingsWindow(window);
    }
  } catch (err) {
    if (typeof Zotero !== "undefined") Zotero.logError(err);
  }
});
