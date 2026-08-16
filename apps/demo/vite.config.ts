import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The Discord link lands here from a phone, so binding to all interfaces
    // lets you test the real flow over your LAN or a tunnel.
    host: true,
  },
  preview: { port: 5173, host: true },
});
