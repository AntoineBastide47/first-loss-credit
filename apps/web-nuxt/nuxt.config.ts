// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },

  // apps/web (Next.js) also defaults to :3000; give this app its own port so a
  // root `pnpm dev` (which starts both via turbo) never has them race for :3000.
  devServer: { port: 3010 },

  modules: ['@nuxtjs/tailwindcss'],

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      title: 'Scaffold-XRP',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'A starter kit for building dApps on XRPL with smart contracts' },
      ],
    },
  },

  // Vite configuration for polyfills (similar to next.config.js webpack config)
  vite: {
    resolve: {
      alias: {
        buffer: 'buffer/',
        events: 'events/',
        stream: 'stream-browserify',
      },
    },
    define: {
      'process.env': {},
      global: 'globalThis',
    },
    optimizeDeps: {
      include: ['buffer', 'events', 'process'],
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    build: {
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
  },

  // Run on client side only for wallet components
  ssr: false,

  typescript: {
    strict: true,
  },
})
