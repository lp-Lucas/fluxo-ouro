@echo off
echo MotionIA FlowStudio — Instalacao
echo.
cd /d "%~dp0"

echo [1/3] Verificando Python...
python --version
if %errorlevel% neq 0 (
    echo ERRO: Python nao encontrado.
    pause & exit /b 1
)

echo.
echo [2/3] Instalando dependencias Python...
pip install flask requests werkzeug

echo.
echo [3/3] Instalando dependencias Node e buildando frontend...
call npm install
if %errorlevel% neq 0 (
    echo ERRO: npm install falhou.
    pause & exit /b 1
)

call npm run build
if %errorlevel% neq 0 (
    echo ERRO: npm run build falhou.
    pause & exit /b 1
)

echo.
echo ============================================
echo  Instalacao concluida!
echo  Execute run.bat para iniciar o FlowStudio
echo ============================================
pause
