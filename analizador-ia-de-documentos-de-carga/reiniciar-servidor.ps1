# Reinicia el servidor de desarrollo (npm run dev) del Analizador IA de
# Documentos de Carga: detiene lo que este usando el puerto 3000 (si algo
# quedo colgado o la tarea programada no funciono) y lo vuelve a arrancar.
# No requiere permisos de administrador.

$port = 3000
$rutaProyecto = "c:\analizador-ia-de-documentos-de-carga"

Write-Host "Buscando procesos usando el puerto $port..."
$conexiones = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if ($conexiones) {
    $pids = $conexiones | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        try {
            Write-Host "Deteniendo proceso $procId que ocupaba el puerto $port..."
            Stop-Process -Id $procId -Force -ErrorAction Stop
        } catch {
            Write-Host "No se pudo detener el proceso $procId : $_" -ForegroundColor Yellow
        }
    }
    Start-Sleep -Seconds 2
} else {
    Write-Host "No habia ningun proceso usando el puerto $port."
}

Write-Host ""
Write-Host "Iniciando el servidor..." -ForegroundColor Green
Set-Location -Path $rutaProyecto
npm run dev
