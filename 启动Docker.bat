@echo off
title API Model Benchmarking Platform (Docker)
wsl --cd "/home/skloxo/aho/openclaw/project/nim_tester" touch history.db profiles.json
wsl --cd "/home/skloxo/aho/openclaw/project/nim_tester" docker compose up -d
start http://localhost:28080/
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Docker startup failed with exit code %errorlevel%
    pause
)
