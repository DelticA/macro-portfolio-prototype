import sys
import threading
import time
import webbrowser
import uvicorn
from macro_portfolio.api.app import app

def open_browser():
    """Wait for the server to start, then open the browser."""
    time.sleep(2)
    webbrowser.open("http://127.0.0.1:8010")

def main():
    # Start the browser thread
    threading.Thread(target=open_browser, daemon=True).start()
    
    # Run the FastAPI app using uvicorn
    # Important: passing the actual 'app' object avoids string import issues in PyInstaller
    uvicorn.run(app, host="127.0.0.1", port=8010, log_level="info", reload=False)

if __name__ == "__main__":
    main()
