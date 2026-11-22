@echo off
rem Runs every CUS Audit agent one after another. Each opens its own browser: sign in when prompted.
rem Exit code 1 from an agent (some repos not accessible) is normal and the next agent still runs.
rem Exit code 2 (GitHub restriction / session lost) stops the whole sequence so GitHub is not hit again.
cd /d "%~dp0"
call :runone "Branch Specific Write Access" || goto :stop
call :runone "Access To Deploy Changes to Production" || goto :stop
call :runone "Github Administrator Listing" || goto :stop
echo.
echo ===== All agents finished =====
exit /b 0

:runone
echo.
echo ===== %~1 =====
pushd "%~1"
node agent.mjs
set RC=%ERRORLEVEL%
popd
if "%RC%"=="2" exit /b 1
exit /b 0

:stop
echo.
echo ===== Sequence stopped: an agent aborted (restriction or session lost) =====
exit /b 2
