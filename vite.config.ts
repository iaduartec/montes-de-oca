import { defineConfig } from 'vite';

/**
 * Base de Vite para un juego en el navegador.
 * - `base: '/'` asume que el sitio se sirve desde la raíz (dev y hosting estático simple).
 * - El target moderno evita transpilar de más: Babylon 8 ya requiere navegadores modernos.
 * - Se sube `chunkSizeWarningLimit` porque Babylon.js es un motor grande en un único chunk.
 */
export default defineConfig({
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
});
