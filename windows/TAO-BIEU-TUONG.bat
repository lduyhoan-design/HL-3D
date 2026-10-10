@echo off
rem Tao bieu tuong "HL 3D" ngoai Desktop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\HL 3D.lnk');" ^
  "$s.TargetPath='%~dp0MO-APP.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0chili3d.ico'; $s.WindowStyle=7; $s.Description='HL 3D - thiet ke hop in 3D'; $s.Save()"
echo Da tao bieu tuong "HL 3D" ngoai Desktop.
timeout /t 3 >nul
