@echo off
title API Model Benchmarking Platform
start http://localhost:28080/
wsl --cd "/home/skloxo/aho/openclaw/project/nim_tester" sh -c "if [ ! -d node_modules ]; then npm install; fi && ~/.bun/bin/bun run src/server.ts"
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Process exited with code %errorlevel%
    pause
)
