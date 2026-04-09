@echo off
echo ========================================================
echo Macro Portfolio Lab - Windows Portable EXE Builder
echo ========================================================
echo.
echo Make sure you are running this inside your Python virtual environment
echo and that all dependencies are installed.
echo.

:: Install PyInstaller if not present
echo Installing PyInstaller...
pip install pyinstaller

echo.
echo Building executable...
:: --onefile packages everything into a single .exe
:: --name sets the output file name
:: --add-data copies the static folder into the executable
:: --hidden-import ensures specific dependencies aren't missed by tree shaking
pyinstaller ^
    --onefile ^
    --name "MacroPortfolioLab" ^
    --add-data "src/macro_portfolio/api/static;static" ^
    --hidden-import "uvicorn.logging" ^
    --hidden-import "uvicorn.loops" ^
    --hidden-import "uvicorn.loops.auto" ^
    --hidden-import "uvicorn.protocols" ^
    --hidden-import "uvicorn.protocols.http" ^
    --hidden-import "uvicorn.protocols.http.auto" ^
    --hidden-import "uvicorn.protocols.websockets" ^
    --hidden-import "uvicorn.protocols.websockets.auto" ^
    --hidden-import "uvicorn.lifespan" ^
    --hidden-import "uvicorn.lifespan.on" ^
    scripts\run_portable.py

echo.
echo ========================================================
echo Build complete! 
echo Check the "dist" folder for MacroPortfolioLab.exe
echo ========================================================
pause
