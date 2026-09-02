# Actualiza el codigo desde git, reconstruye el build de produccion y
# reinicia el proceso administrado por PM2.
# Requiere que ya se haya corrido Configurar-Servicio-PM2.ps1 una vez.
#
# Uso:
#   .\Desplegar.ps1

$ErrorActionPreference = 'Stop'
$rutaProyecto = $PSScriptRoot

Set-Location -Path $rutaProyecto

Write-Host "Actualizando codigo (git pull)..." -ForegroundColor Cyan
git pull

Write-Host ""
Write-Host "Instalando dependencias..." -ForegroundColor Cyan
npm install

Write-Host ""
Write-Host "Generando build de produccion..." -ForegroundColor Cyan
npm run build

Write-Host ""
Write-Host "Reiniciando el servicio con PM2..." -ForegroundColor Cyan
pm2 restart ecosystem.config.cjs --update-env

Write-Host ""
Write-Host "Despliegue completado." -ForegroundColor Green
pm2 status
