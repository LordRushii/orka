export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel instead of a popup; the
  // side panel is the only Task Session UI in V1.
  browser.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.error("Failed to configure the side panel", error);
    });
});
