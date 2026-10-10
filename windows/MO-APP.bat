@echo off
rem Mo HL 3D (cua so app rieng)
cd /d "%~dp0"
set "PYW="
for %%P in (pythonw.exe) do if not "%%~$PATH:P"=="" set "PYW=%%~$PATH:P"
if not defined PYW (
  echo Khong tim thay Python. Hay cai Python 3 tu python.org ^(tick "Add python.exe to PATH"^).
  pause
  exit /b 1
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'python%%'\" | Where-Object { $_.CommandLine -like '*hl3d*server.py*' -or $_.CommandLine -like '*chili3d*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "" "%PYW%" "%~dp0server.py" --khong-mo
timeout /t 2 /nobreak >nul
start "" msedge --app=http://127.0.0.1:8787/ 2>nul || start "" http://127.0.0.1:8787/
exit /b 0
