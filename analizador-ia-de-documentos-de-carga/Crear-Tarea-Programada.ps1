#Requires -RunAsAdministrator
# Crea una Tarea Programada de Windows que arranca el servidor de desarrollo
# (npm run dev) automaticamente cada vez que se inicia sesion en este equipo.
#
# COMO USARLO:
#   1. Clic derecho sobre este archivo -> "Ejecutar con PowerShell" como Administrador
#      (o abrir PowerShell como Administrador y ejecutar: .\Crear-Tarea-Programada.ps1)
#   2. Si aparece un aviso de politica de ejecucion, ejecutar antes:
#      powershell -ExecutionPolicy Bypass -File .\Crear-Tarea-Programada.ps1

$taskName   = "AnalizadorIA-DevServer"
$scriptPath = "c:\analizador-ia-de-documentos-de-carga\start-dev-server.ps1"

if (-not (Test-Path $scriptPath)) {
    Write-Host "ERROR: no se encontro $scriptPath" -ForegroundColor Red
    exit 1
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Host "La tarea '$taskName' ya existe. Se elimina para volver a crearla..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Arranca 'npm run dev' del Analizador IA de Documentos de Carga al iniciar sesion" -Force

Write-Host ""
Write-Host "Tarea programada '$taskName' creada correctamente." -ForegroundColor Green
Write-Host "El servidor arrancara solo la proxima vez que se inicie sesion en Windows."
Write-Host ""
Write-Host "Para probarla ahora mismo sin reiniciar sesion, ejecuta:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host ""
Write-Host "Para revisar su estado:"
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Select-Object TaskName, State"
