@echo off
echo ==================================================
echo   RaceReviewPWA (GitHub Pages) Push Script
echo ==================================================
echo.

cd /d "%~dp0"

echo [1/3] Staging PWA changes...
git add app.js bias_logic.js index.html style.css

echo.
echo [2/3] Creating / Amending commit...
git commit --amend --no-edit 2>nul
if %errorlevel% neq 0 (
    git commit -m "feat: add 10-year track bias and class filter"
)

echo.
echo [3/3] Pushing to GitHub (RaceReviewPWA)...
git push -f -u origin main

echo.
echo ==================================================
echo   Push Completed! GitHub Pages will update shortly.
echo ==================================================
pause
