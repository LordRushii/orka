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
  },
});
