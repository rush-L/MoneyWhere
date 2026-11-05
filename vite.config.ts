/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'MoneyWhere',
        short_name: 'MoneyWhere',
        description: 'Personal and shared money tracking',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        shortcuts: [{ name: 'Voice add', short_name: 'Voice add', description: 'Speak a transaction', url: '/?add=voice', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] }],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { navigateFallback: '/index.html' }, // app-shell caching only; no data sync yet
    }),
  ],
  test: { include: ['src/**/*.test.ts', 'supabase/tests/**/*.test.ts'] },
})
