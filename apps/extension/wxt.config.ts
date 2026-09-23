import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Orka — On-Device Privacy Browser Agent',
    description:
      'Locally redacts sensitive page content, then asks a selected planner to propose safe, user-approved browser actions.',
    // The toolbar action opens the panel; the panel itself requests tab access
    // from the Start gesture and mints the background capture authority against
    // the active tab. No persistent site access is requested at install.
    action: {
      default_title: 'Open Orka',
    },
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    // Standing read/act access to normal web pages, granted at install so a task
    // starts on the current tab with no prompt, ever. Non-web surfaces
    // (chrome://, the Web Store, file://, PDF viewer) are deliberately excluded,
    // which is also the boundary the capture authority enforces per round. The
    // loopback entries keep the default local gateway reachable; `https://*/*`
    // additionally backs any remote gateway the user configures.
    host_permissions: [
      'http://127.0.0.1:8787/*',
      'http://localhost:8787/*',
      'https://*/*',
      'http://*/*',
    ],
  },
});
