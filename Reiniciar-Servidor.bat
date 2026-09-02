@echo off
title Reiniciar Servidor - Analizador IA de Documentos de Carga
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0reiniciar-servidor.ps1"
echo.
echo El servidor se detuvo. Presiona una tecla para cerrar esta ventana.
pause >nul
