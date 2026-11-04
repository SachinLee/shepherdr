@echo off
rem The shepherdr command from cmd.exe or PowerShell. %~dp0 stays quoted; %* forwards the user's argv unchanged.
rem DisableDelayedExpansion keeps a literal bang in an argument from being eaten by an inherited cmd /v:on session.
setlocal DisableDelayedExpansion
bun "%~dp0..\helper\core-entry.ts" %*
exit /b %ERRORLEVEL%
