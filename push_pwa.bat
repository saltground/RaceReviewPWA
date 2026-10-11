@echo off
echo ==================================================
echo   RaceReviewPWA (GitHub Pages) Push Script
echo ==================================================
echo.

cd /d "%~dp0"

echo [1/3] Staging PWA changes...
git add app.js bias_logic.js index.html style.css results_logic.js race_results_data.js track_bias_data.json

echo.
echo [2/3] Creating commit...
git commit -m "fix: update today track auto-fill and measurement time display with JST fallback" 2>nul
if %errorlevel% neq 0 (
    git commit --amend --no-edit 2>nul
)

echo.
echo [3/3] Pushing to GitHub (RaceReviewPWA)...
git push -u origin main

echo.
echo ==================================================
echo   Push Completed! GitHub Pages will update shortly.
echo ==================================================
