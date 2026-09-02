import path from 'path';
import { defineConfig, loadEnv } from 'vite';


export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');

    // El endpoint del FMM (Boris Beltrán) no responde con headers CORS, así que
    // el navegador no puede llamarlo directamente. Este proxy corre en el
    // proceso Node de Vite (no en el navegador) y reenvía la petición al
    // servicio real, agregando el header 'Token' del lado del servidor para
    // que nunca quede expuesto en el bundle del cliente.
    const fmmApiUrl = new URL(env.FMM_API_URL || 'http://www.siza.com.co/spdcitas-1.0/api/formulario');
    const fmmApiToken = env.FMM_API_TOKEN;

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          '/api/fmm': {
            target: fmmApiUrl.origin,
            changeOrigin: true,
            rewrite: (requestPath) => requestPath.replace(/^\/api\/fmm/, fmmApiUrl.pathname),
            configure: (proxy) => {
              proxy.on('proxyReq', (proxyReq) => {
                if (fmmApiToken) {
                  proxyReq.setHeader('Token', fmmApiToken);
                }
              });
            },
          },
        },
      },
      plugins: [],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
