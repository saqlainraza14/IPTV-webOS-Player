@echo off
setlocal EnableDelayedExpansion
title Stream Deck webOS TV Installer
color 0A

cd /d "%~dp0"

set "APP_ID=com.streamdeck.app"
set "DEVICE=%~1"
set "IPK_FILE=%~2"

if "%DEVICE%"=="" set "DEVICE=tv"

if "%IPK_FILE%"=="" (
    if exist "build\com.streamdeck.app_1.0.0_all.ipk" (
        set "IPK_FILE=build\com.streamdeck.app_1.0.0_all.ipk"
    ) else (
        for /f "delims=" %%F in ('dir /b /o-d "build\*.ipk" 2^>nul') do (
            if not defined IPK_FILE set "IPK_FILE=build\%%F"
        )
    )
)

echo.
echo ============================================
echo  Stream Deck - LG webOS TV Installer
echo ============================================
echo  Device : %DEVICE%
echo  App ID : %APP_ID%
echo.

where ares-install >nul 2>&1
if errorlevel 1 (
    echo ERROR: webOS CLI not found.
    echo Install it first:
    echo   npm install -g @webos-tools/cli
    echo.
    goto :eof
)

where ares-launch >nul 2>&1
if errorlevel 1 (
    echo ERROR: webOS CLI is incomplete in PATH.
    echo Reinstall:
    echo   npm install -g @webos-tools/cli
    echo.
    goto :eof
)

if not defined IPK_FILE (
    echo No IPK found under build\
    echo Run build.bat first.
    echo.
    goto :eof
)

if not exist "%IPK_FILE%" (
    echo ERROR: IPK file not found:
    echo   %IPK_FILE%
    echo.
    goto :eof
)

echo Checking device profile "%DEVICE%"...
ares-device-info --device "%DEVICE%" >nul 2>&1
if errorlevel 1 (
    echo Device "%DEVICE%" is not configured yet.
    echo Running ares-setup-device now...
    echo Use username: prisoner, port: 9922
    echo.
    ares-setup-device
    if errorlevel 1 (
        echo.
        echo Device setup was not completed.
        echo Please run: ares-setup-device
        goto :eof
    )
)

echo.
echo Removing old app (if installed)...
ares-install --device "%DEVICE%" --remove "%APP_ID%" >nul 2>&1

echo Installing IPK:
echo   %IPK_FILE%
ares-install --device "%DEVICE%" "%IPK_FILE%"
if errorlevel 1 (
    echo.
    echo Install failed.
    goto :eof
)

echo.
echo Launching app...
ares-launch --device "%DEVICE%" "%APP_ID%"
if errorlevel 1 (
    echo Launch failed. You can open it manually from TV apps.
    goto :eof
)

echo.
echo SUCCESS: App installed and launched on "%DEVICE%".
echo.
echo Tip: next time run
echo   install-tv.bat %DEVICE%
