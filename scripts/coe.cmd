@echo off
rem coe - launch CodeEater on Windows (created by scripts/install.ps1)
rem Usage: coe.cmd [project-dir]   (opens CodeEater with the given folder)
setlocal
set "ROOT=%~dp0.."
if not exist "%ROOT%\node_modules\.bin\electron.cmd" (
  echo CodeEater dependencies are not installed.
  echo Run: cd "%ROOT%" ^&^& npm install ^&^& npm run build
  exit /b 1
)
if not exist "%ROOT%\out\main\index.js" (
  echo Building CodeEater... first run might take a moment.
  pushd "%ROOT%"
  call npm run build >nul 2>&1
  popd
  if errorlevel 1 (
    echo Build failed - run: cd "%ROOT%" ^&^& npm run build
    exit /b 1
  )
)
"%ROOT%\node_modules\.bin\electron.cmd" "%ROOT%" %*
endlocal