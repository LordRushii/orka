// Real capture and DOM-snapshot collection are implemented in Phase 2 (see
// phases/02-local-privacy-engine.md). `registration: "runtime"` keeps this
// script out of the manifest's always-on content_scripts list; it is only
// ever injected deliberately into the active tab once a Task Session starts
// (activeTab + scripting), never automatically on page load.
//
// `matches` below is intentionally a placeholder that matches no real site.
// WXT requires a non-empty pattern here, and any pattern used with
// `registration: "runtime"` is added to `host_permissions` at build time --
// Phase 2's real capture module must choose real match patterns deliberately
// rather than inheriting a broad default such as `*://*/*`.
export default defineContentScript({
  matches: ["*://*.orka-placeholder.invalid/*"],
  registration: "runtime",
  main() {
    console.log("Orka content script ready.");
  },
});
