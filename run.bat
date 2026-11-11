@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

rem 找一个可用的 Python
set "PY=python.exe"
where python >nul 2>nul
if errorlevel 1 set "PY=py.exe"

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 首次运行，正在创建独立 Python 环境...
    %PY% -m venv .venv
    if errorlevel 1 goto :err
)

set "VENV_PY=.venv\Scripts\python.exe"

if not exist ".venv\.deps_ok" (
    echo [2/3] 安装依赖库（只需一次，需要联网）...
    "%VENV_PY%" -m pip install --disable-pip-version-check -r requirements.txt -q
    if errorlevel 1 goto :err
    echo ok> ".venv\.deps_ok"
)

echo [3/3] 启动「智能改名 · Web 版」并自动打开浏览器...
"%VENV_PY%" webui.py
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo 出错了。请确认：
echo   1. 电脑上装过 Python 3.8 或更新版本（https://www.python.org/downloads/），
echo      安装时勾选 "Add Python to PATH"；
echo   2. 网络正常（首次安装依赖需要联网）。
echo.
pause
exit /b 1