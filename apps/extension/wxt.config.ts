import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Orka — On-Device Privacy Browser Agent',
    description:
      'Locally redacts sensitive page content, then asks a selected planner to propose safe, user-approved browser actions.',
    // The toolbar action mints the temporary activeTab grant used by the
    // background capture authority. No persistent site access is requested.
    action: {
      default_title: 'Open Orka',
    },
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    // The default loopback gateway is granted up front so a local-only setup
    // works with no extra prompt. Any other gateway is opt-in: the side panel
    // requests it from a user gesture, and SECURITY-PRIVACY.md's transport
    // rule limits that to https:// once it leaves the machine.
    host_permissions: ['http://127.0.0.1:8787/*', 'http://localhost:8787/*'],
    optional_host_permissions: ['https://*/*'],
  },
});
