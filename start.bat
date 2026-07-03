@echo off
chcp 65001 >nul
echo ================================
echo   考研单词记忆 - 启动程序
echo ================================
echo.

REM 检查 Python 是否安装
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python 3.8+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

REM 检查 pywebview 是否安装
python -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo [提示] 正在安装依赖 pywebview...
    pip install pywebview>=4.0
    if errorlevel 1 (
        echo [错误] 安装依赖失败，请手动执行: pip install pywebview>=4.0
        pause
        exit /b 1
    )
)

echo [启动] 正在启动考研单词记忆应用...
echo.
python app.py
