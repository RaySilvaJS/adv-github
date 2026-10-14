@echo off
setlocal
cd /d "%~dp0"

set "DETALHES=todos"
node scripts\varrer-oab-eproc.js 1 20000 TO

if errorlevel 1 (
    echo.
    echo A varredura terminou com erro. O progresso salvo pode ser retomado executando este arquivo novamente.
)
pause
