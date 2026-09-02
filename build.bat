@echo off
setlocal EnableDelayedExpansion
title Stream Deck webOS Builder
color 0A

echo.
echo ============================================
echo  Stream Deck — webOS IPK Builder (Windows)
echo ============================================
echo.

cd /d "%~dp0"

:: ── Step 1: Generate icons ───────────────────────────────────────────────────
echo [1/3] Generating PNG icons...
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    node generate_icons.js .
    if !ERRORLEVEL! EQU 0 (
        echo       icon.png and largeIcon.png created.
    ) else (
        echo       WARNING: icon generation failed. Using placeholder icons.
        call :create_placeholder_icons
    )
) else (
    echo       Node.js not found. Attempting Python fallback...
    call :create_placeholder_icons
)

:: ── Step 2: Download HLS.js if missing ──────────────────────────────────────
echo.
echo [2/3] Checking for hls.min.js...
if exist hls.min.js (
    echo       hls.min.js already present.
) else (
    where curl >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo       Downloading HLS.js 1.6.16 (ES5 build)...
        curl -L -o hls.min.js "https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js"
        if !ERRORLEVEL! EQU 0 (
            echo       hls.min.js downloaded.
        ) else (
            echo       WARNING: Download failed. App will use CDN fallback.
            call :create_hls_stub
        )
    ) else (
        echo       curl not available. Creating CDN-loader stub...
        call :create_hls_stub
    )
)

:: ── Step 3: Build IPK ────────────────────────────────────────────────────────
echo.
echo [3/3] Building IPK package...

:: TV-installable packages should be produced with the official LG packager.
:: The custom builders are retained only as a last resort for offline packaging.
:: Try ares-package first (official webOS SDK)
where ares-package >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo       Using ares-package (webOS SDK)...
    if not exist build mkdir build
    ares-package . -o build
    if !ERRORLEVEL! EQU 0 (
        echo.
        echo  SUCCESS! IPK created in .\build\
        goto :done
    )
)

:: Try Node.js IPK builder (create_ipk.js)
where node >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo       WARNING: Falling back to custom Node.js IPK builder.
    echo       This package may not be accepted by LG install services.
    node create_ipk.js . build
    if !ERRORLEVEL! EQU 0 ( goto :done )
)

:: Try Python IPK builder
where python >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo       Using Python IPK builder...
    python create_ipk.py . build
    if !ERRORLEVEL! EQU 0 ( goto :done )
)

where python3 >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo       Using python3 IPK builder...
    python3 create_ipk.py . build
    if !ERRORLEVEL! EQU 0 ( goto :done )
)

echo.
echo  ERROR: Could not build IPK.
echo  Please install one of:
echo    - webOS CLI:  npm install -g @webos-tools/cli
echo    - Python 3.x (python.org)
echo  For TV installation, webOS CLI is strongly recommended.
echo.
goto :eof

:done
echo.
echo ============================================
echo  Build complete!
echo ============================================
echo.
echo  INSTALLATION:
echo  1. Enable Developer Mode on your LG TV:
echo     Settings ^> General ^> TV Management ^> Developer Mode
echo  2. Note your TV's IP address from the Developer Mode screen.
echo  3. Register and upload via Developer Mode app, OR use ares-cli:
echo       ares-setup-device
echo       ares-install --device tv build\*.ipk
echo.
goto :eof

:create_placeholder_icons
:: Create minimal valid 1×1 transparent PNG as placeholder
:: (users can replace with proper icons later)
where python >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    python -c "import base64,sys; d='iVBORw0KGgoAAAANSUhEUgAAAFAAAACQCAYAAAC/tRS0AAAABmJLR0QA/wD/AP+gvaeTAAAAsElEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBuAABHgAAAABJRU5ErkJggg=='; open('icon.png','wb').write(base64.b64decode(d)); open('largeIcon.png','wb').write(base64.b64decode(d))"
    echo       Placeholder icons created (80x80).
)
goto :eof

:create_hls_stub
:: Create a loader that pulls HLS.js from CDN at runtime
echo /* HLS.js CDN fallback loader */ > hls.min.js
echo (function(){ >> hls.min.js
echo   var s = document.createElement('script'); >> hls.min.js
echo   s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js'; >> hls.min.js
echo   document.head.appendChild(s); >> hls.min.js
echo })(); >> hls.min.js
goto :eof
