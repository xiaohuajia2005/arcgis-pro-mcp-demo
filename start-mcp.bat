@echo off
setlocal enabledelayedexpansion
title ArcGIS Pro MCP Server

rem ==========================================================================
rem  ArcGIS Pro MCP Server - launcher
rem
rem  Starts the MCP server over stdio, mainly for manual verification.
rem
rem  Normally you do NOT need to run this by hand. AI clients (DeepSeek
rem  Harness, Claude Desktop, Cline ...) launch server.mjs themselves based
rem  on their config file. Use this script to:
rem    - verify the install works before wiring it into a client
rem    - watch the server / arcpy worker logs when something fails
rem
rem  NOTE: this file is intentionally ASCII-only.
rem  Combining UTF-8 Chinese text with "chcp 65001" is known to break cmd
rem  line parsing on some Windows builds, so all messages are in English.
rem  Chinese documentation lives in README.md and docs/TROUBLESHOOTING.md.
rem ==========================================================================

cd /d "%~dp0"

rem --------------------------------------------------------------------------
rem  Step 1 - check Node.js (MCP protocol layer runs on Node, requires 18+)
rem --------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node 18 or newer:
    echo         https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [INFO] Node %%v

rem --------------------------------------------------------------------------
rem  Step 2 - check dependencies, install on first run
rem --------------------------------------------------------------------------
if not exist "node_modules\@modelcontextprotocol\sdk" (
    echo [INFO] First run, installing dependencies ...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your network or npm registry.
        pause
        exit /b 1
    )
)

rem --------------------------------------------------------------------------
rem  Step 3 - locate the Python interpreter shipped with ArcGIS Pro
rem
rem  Only the bundled arcgispro-py3 environment has arcpy and a working
rem  license binding. A system Python will NOT work.
rem  An explicitly set ARCGIS_PRO_PYTHON always wins.
rem --------------------------------------------------------------------------
if not defined ARCGIS_PRO_PYTHON (
    set "CAND=C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe"
    if exist "!CAND!" set "ARCGIS_PRO_PYTHON=!CAND!"
)
if not defined ARCGIS_PRO_PYTHON (
    set "CAND=D:\ArcGIS\bin\Python\envs\arcgispro-py3\python.exe"
    if exist "!CAND!" set "ARCGIS_PRO_PYTHON=!CAND!"
)
if not defined ARCGIS_PRO_PYTHON (
    set "CAND=D:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe"
    if exist "!CAND!" set "ARCGIS_PRO_PYTHON=!CAND!"
)
if not defined ARCGIS_PRO_PYTHON (
    echo [ERROR] ArcGIS Pro Python interpreter not found.
    echo         Make sure ArcGIS Pro is installed, or set the variable:
    echo         set ARCGIS_PRO_PYTHON=C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe
    pause
    exit /b 1
)
echo [INFO] ArcGIS Pro Python: %ARCGIS_PRO_PYTHON%

rem --------------------------------------------------------------------------
rem  Step 4 - start the MCP server
rem
rem  This is a stdio service: after launch it waits on stdin, which looks
rem  like it is "hanging". That is expected. It exits when the client
rem  disconnects or you press Ctrl+C.
rem --------------------------------------------------------------------------
echo.
echo [INFO] Starting MCP server, waiting for a client over stdio ...
echo [INFO] Press Ctrl+C to stop
echo.
node "%~dp0server.mjs"

rem Ctrl+C also lands here with a non-zero code, so do not call it an error.
if errorlevel 1 (
    echo.
    echo [INFO] Server stopped. If you did not press Ctrl+C, run: node doctor.mjs
    pause
)

endlocal
