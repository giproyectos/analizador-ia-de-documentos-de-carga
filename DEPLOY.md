# Despliegue en producción

Este proyecto se sirve con un pequeño servidor Node/Express (`server/index.js`)
que:
1. Sirve el build optimizado de Vite (`dist/`).
2. Expone `/api/fmm`, que hace de proxy hacia el web service del FMM (Boris
   Beltrán / Zona Franca Cartagena) agregando el header `Token` del lado del
   servidor — así el navegador nunca ve el token ni sufre el bloqueo de CORS
   del servicio original (`www.siza.com.co` no responde con headers CORS).

El proceso se administra con [PM2](https://pm2.keymetrics.io/), registrado
como **Servicio de Windows** (arranca solo al reiniciar el servidor, sin
necesidad de que haya una sesión de usuario iniciada).

> Esto reemplaza el enfoque anterior (`Crear-Tarea-Programada.ps1` +
> `Reiniciar-Servidor.bat`, que corrían `npm run dev` bajo una Tarea
> Programada "al iniciar sesión"). Esos archivos quedan obsoletos una vez
> migrado — ver el final de este documento.

## 1. Puesta en marcha inicial (una sola vez por servidor)

Requisitos: Node.js ≥ 18.17 instalado en el servidor.

1. Clonar/tener el repo en el servidor, con VS Code (o git) apuntando a la
   rama que se vaya a desplegar.
2. Copiar `.env.example` a `.env` y completar los valores reales:
   ```
   GEMINI_API_KEY=...
   FMM_API_URL=http://www.siza.com.co/spdcitas-1.0/api/formulario
   FMM_API_TOKEN=...
   PORT=3000
   ```
   `.env` **no** se sube a git (está en `.gitignore`).
3. Abrir PowerShell **como Administrador** en la carpeta del proyecto y
   correr:
   ```powershell
   .\Configurar-Servicio-PM2.ps1
   ```
   Esto instala PM2 y lo registra como Servicio de Windows, instala las
   dependencias, genera el build de producción, y arranca la app.
4. Verificar que responda en `http://localhost:3000` (o el `PORT` que hayas
   configurado).
5. Una vez confirmado que funciona, eliminar la Tarea Programada anterior:
   ```powershell
   Unregister-ScheduledTask -TaskName "AnalizadorIA-DevServer" -Confirm:$false
   ```

## 2. Desplegar una nueva versión (día a día)

Cada vez que haya cambios nuevos que publicar (después de un `git merge` o
`git checkout` a la rama correspondiente):

```powershell
.\Desplegar.ps1
```

Esto hace `git pull`, `npm install`, `npm run build` y reinicia el proceso
en PM2 sin downtime perceptible.

## 3. Comandos útiles de PM2

```powershell
pm2 status                              # ver si el proceso está corriendo
pm2 logs analizador-ia-documentos-carga # ver logs en vivo
pm2 restart analizador-ia-documentos-carga
pm2 stop analizador-ia-documentos-carga
```

Los logs también quedan en archivo, en `logs/out.log` y `logs/error.log`
(carpeta ignorada por git).

## 4. Variables de entorno

Ver `.env.example` para la lista completa y de qué depende cada una
(tiempo de build vs. tiempo de ejecución).

## Notas / limitaciones conocidas

- Si en algún momento Boris habilita CORS en su web service, el proxy
  `/api/fmm` de `server/index.js` puede simplificarse o incluso quitarse
  (llamando directo desde el navegador) — no es urgente, esto ya funciona.
- El proxy de desarrollo (`server.proxy` en `vite.config.ts`, usado por
  `npm run dev`) es independiente de este servidor de producción; ambos
  hacen lo mismo pero para entornos distintos.
