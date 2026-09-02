Diagnóstico del Error — Analizador IA de Documentos de Carga
Contexto
Aplicación frontend en Vite + TypeScript que usa la API de Google Gemini para analizar documentos PDF de carga. Al ejecutar la app aparece "Error en el Análisis".
Causa Raíz Identificada
El archivo dist/ (versión compilada que está corriendo en el servidor) fue generado sin la variable de entorno GEMINI_API_KEY disponible al momento del build, por lo que la API key llega como undefined en runtime y la llamada a Gemini falla silenciosamente.
Arquitectura relevante

.env.local define: GEMINI_API_KEY=<REDACTED>

vite.config.ts mapea en tiempo de compilación:

ts  const env = loadEnv(mode, '.', '');
  define: {
    'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
  }

index.tsx consume: new GoogleGenAI({ apiKey: process.env.API_KEY })

Vite incrusta la key directamente en el bundle al compilar. Si el .env.local no está presente o no es encontrado durante el build, la key queda como undefined en el dist/.
Acciones a realizar

Verificar que .env.local existe en la raíz del proyecto (mismo nivel que vite.config.ts y package.json)
Verificar que .env.local contiene exactamente:

   GEMINI_API_KEY=<REDACTED>

Ejecutar el build desde la carpeta raíz del proyecto:

bash   npm run build

Validar que la key quedó incrustada en el bundle resultante:

bash   # En Windows:
   findstr "AIzaSy" dist\assets\index-*.js
   # En Linux/Mac:
   grep "AIzaSy" dist/assets/index-*.js
Debe aparecer la key en el output. Si no aparece, el .env.local no fue encontrado durante el build.

Servir el nuevo dist/ generado (reemplazar el anterior).

Verificaciones adicionales realizadas

✅ Conectividad general a internet: OK (ping a google.com responde)
✅ Conectividad a generativelanguage.googleapis.com: OK (puerto 443 accesible)
✅ API key válida y activa: confirmado (curl a /v1beta/models devuelve lista completa de modelos)
✅ vite.config.ts: correcto, no requiere cambios
✅ .env.local: correcto, no requiere cambios
✅ index.tsx: correcto, no requiere cambios
❌ dist/ actual: compilado sin la variable de entorno → requiere rebuild