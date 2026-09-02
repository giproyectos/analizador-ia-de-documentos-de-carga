#Requires -RunAsAdministrator
# Puesta en marcha INICIAL (una sola vez) del despliegue en produccion con
# PM2 como Servicio de Windows. Reemplaza el enfoque anterior de
# "Tarea Programada + npm run dev" (Crear-Tarea-Programada.ps1 /
# Reiniciar-Servidor.bat), que requeria una sesion de usuario iniciada y
# corria el servidor de desarrollo en vez de un build optimizado.
#
# Requisitos antes de correr esto:
#   - Node.js >= 18.17 instalado.
#   - Haber creado el archivo ".env" en la raiz del proyecto a partir de
#     ".env.example", con los valores reales (GEMINI_API_KEY, FMM_API_URL,
#     FMM_API_TOKEN).
#
# Uso (PowerShell como Administrador):
#   .\Configurar-Servicio-PM2.ps1

$ErrorActionPreference = 'Stop'
$rutaProyecto = $PSScriptRoot

if (-not (Test-Path (Join-Path $rutaProyecto ".env"))) {
    Write-Host "ERROR: no existe .env en $rutaProyecto" -ForegroundColor Red
    Write-Host "Copia .env.example a .env y completa los valores reales antes de continuar." -ForegroundColor Yellow
    exit 1
}

Write-Host "Instalando PM2 y pm2-windows-service globalmente..." -ForegroundColor Cyan
npm install -g pm2 pm2-windows-service

Write-Host ""
Write-Host "Registrando PM2 como Servicio de Windows (se te haran un par de preguntas)..." -ForegroundColor Cyan
pm2-service-install -n PM2

Set-Location -Path $rutaProyecto

Write-Host ""
Write-Host "Instalando dependencias del proyecto..." -ForegroundColor Cyan
npm install

Write-Host ""
Write-Host "Generando build de produccion..." -ForegroundColor Cyan
npm run build

Write-Host ""
Write-Host "Arrancando la aplicacion con PM2..." -ForegroundColor Cyan
pm2 start ecosystem.config.cjs
pm2 save

Write-Host ""
Write-Host "Listo. La aplicacion ahora corre como Servicio de Windows via PM2," -ForegroundColor Green
Write-Host "arranca sola al reiniciar el servidor, sin necesidad de iniciar sesion." -ForegroundColor Green
Write-Host ""
Write-Host "Verifica que responda en http://localhost:3000 y luego elimina la" -ForegroundColor Yellow
Write-Host "Tarea Programada anterior con:" -ForegroundColor Yellow
Write-Host "  Unregister-ScheduledTask -TaskName 'AnalizadorIA-DevServer' -Confirm:`$false"
