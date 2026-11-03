@echo off
chcp 65001 >nul
title Wordly - Focus Vocab
cd /d "%~dp0"

if not exist "index.html" (
    echo [ERROR] index.html not found in this folder.
    pause
    exit /b 1
)

start "" "%~dp0index.html"
exit /b 0
