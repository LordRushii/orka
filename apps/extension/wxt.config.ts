import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Orka — On-Device Privacy Browser Agent',
    description:
      'Locally redacts sensitive page content, then asks a selected planner to propose safe, user-approved browser actions.',
    // Requested only for the active tab, and only once a task session begins.
    permissions: ['activeTab', 'scripting', 'storage'],
  },
});
