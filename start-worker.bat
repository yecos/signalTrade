@echo off
cd /d "%~dp0"
npx tsx scripts/worker.ts --auto
