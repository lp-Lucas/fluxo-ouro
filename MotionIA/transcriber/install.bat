@echo off
echo MotionIA Transcriber — Instalacao
echo.

echo Verificando Python...
python --version
if %errorlevel% neq 0 (
    echo ERRO: Python nao encontrado. Instale em python.org
    pause
    exit /b 1
)

echo.
echo Instalando dependencias Python...
pip install flask openai-whisper

echo.
echo ============================================
echo  ATENCAO: o Whisper precisa do ffmpeg
echo  Se der erro ao transcrever, instale com:
echo.
echo  winget install Gyan.FFmpeg
echo  (ou baixe em ffmpeg.org)
echo ============================================
echo.
echo Instalacao concluida! Execute run.bat para iniciar.
pause
