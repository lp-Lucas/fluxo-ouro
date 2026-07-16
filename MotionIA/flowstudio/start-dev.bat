@echo off
echo MotionIA FlowStudio — Modo desenvolvimento
echo  Flask:  http://localhost:5003 (API)
echo  Vite:   http://localhost:5174 (UI)
echo.
cd /d "%~dp0"

start "FlowStudio API" cmd /k "python app.py"
timeout /t 2 /nobreak >nul
start "FlowStudio UI"  cmd /k "npm run dev"
timeout /t 3 /nobreak >nul
start http://localhost:5174
