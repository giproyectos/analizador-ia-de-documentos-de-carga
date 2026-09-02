/**
 * Servidor de producción del Analizador IA de Documentos de Carga.
 *
 * Sirve el build estático generado por `npm run build` (carpeta dist/) y
 * expone /api/fmm como proxy hacia el web service del FMM, agregando el
 * header 'Token' del lado del servidor (nunca en el navegador).
 *
 * Reemplaza al proxy de desarrollo de Vite (server.proxy en vite.config.ts),
 * que solo existe cuando se corre `vite dev` y no aplica a un build de
 * producción real.
 */
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const FMM_API_URL = process.env.FMM_API_URL || 'http://www.siza.com.co/spdcitas-1.0/api/formulario';
const FMM_API_TOKEN = process.env.FMM_API_TOKEN;
const fmmApiUrl = new URL(FMM_API_URL);

const distDir = path.join(__dirname, '..', 'dist');

const app = express();

app.get('/api/fmm', async (req, res) => {
    if (!FMM_API_TOKEN) {
        console.error('Falta configurar FMM_API_TOKEN en el entorno del servidor.');
        res.status(500).json({ error: 'El servidor no tiene configurado el acceso al servicio de FMM.' });
        return;
    }

    const nmformZf = req.query.nmform_zf;
    if (!nmformZf || Array.isArray(nmformZf)) {
        res.status(400).json({ error: "Falta o es inválido el parámetro 'nmform_zf'." });
        return;
    }

    const targetUrl = new URL(fmmApiUrl.toString());
    targetUrl.searchParams.set('nmform_zf', String(nmformZf));

    // El dominio del servicio de FMM esta detras de un WAF/CDN cuya resolucion
    // DNS falla de forma intermitente (ENOTFOUND esporadico). Se reintenta un
    // par de veces antes de reportar error al navegador.
    const MAX_INTENTOS = 3;
    let ultimoError;
    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        try {
            const upstreamResponse = await fetch(targetUrl, {
                method: 'GET',
                headers: { Token: FMM_API_TOKEN },
            });
            const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
            const body = await upstreamResponse.text();
            res.status(upstreamResponse.status).set('Content-Type', contentType).send(body);
            return;
        } catch (error) {
            ultimoError = error;
            console.error(`Error al consultar el servicio de FMM (intento ${intento}/${MAX_INTENTOS}):`, error);
            if (intento < MAX_INTENTOS) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
    }

    console.error('Se agotaron los reintentos contra el servicio de FMM:', ultimoError);
    res.status(502).json({ error: 'No se pudo conectar con el servicio de búsqueda de FMM.' });
});

app.use(express.static(distDir));

// SPA fallback: cualquier otra ruta GET sirve el mismo index.html.
app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Analizador IA de Documentos de Carga escuchando en el puerto ${PORT}`);
});
