@echo off
REM ══════════════════════════════════════════════════════════════
REM  DOMINO ARENA — one-click play with Cloudflare Tunnel
REM  Double-click this file, then share the URL it prints.
REM ══════════════════════════════════════════════════════════════
cd /d "%~dp0"

echo Starting game server on http://localhost:3000 ...
start "Domino Arena Server" cmd /k "node server\server.js"
timeout /t 2 /nobreak >nul

echo.
echo Opening Cloudflare Tunnel — SHARE THE https://*.trycloudflare.com URL BELOW WITH YOUR FRIENDS:
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
