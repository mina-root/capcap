import { useState, useEffect } from 'react';
import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X, RefreshCw } from 'lucide-react';
import { getCurrentWindow, currentMonitor, getAllWindows } from '@tauri-apps/api/window';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import './index.css';

interface WindowInfo {
  hwnd: number;
  title: string;
}

// --- MAIN DOCK ---
function MainApp() {
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);

  useEffect(() => {
    const unlisten = listen<WindowInfo>('window-selected', (event) => {
      setSelectedWindow(event.payload);
      setIsWindowMenuOpen(false);
    });

    const unlistenClose = listen('window-select-closed', () => {
      setIsWindowMenuOpen(false);
    });

    // Follow main window position
    const unlistenMove = getCurrentWindow().onMoved(async () => {
      if (!isWindowMenuOpen) return;
      const popupWin = (await getAllWindows()).find(w => w.label === 'window-select');
      if (popupWin) {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        const monitor = await currentMonitor();
        const sf = monitor ? monitor.scaleFactor : 1;
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        // Get current direction (could be kept in state, but simpler to recalculate)
        let direction: 'up' | 'down' = 'up';
        if (monitor && pos.y < monitor.size.height / 2) direction = 'down';

        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + 30, logicalY - 360));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + 30, logicalY + 140));
        }
      }
    });

    return () => {
      unlisten.then(f => f());
      unlistenClose.then(f => f());
      unlistenMove.then(f => f());
    };
  }, [isWindowMenuOpen]);

  const handleClose = async () => {
    try {
      const allWindows = await getAllWindows();
      const currentLabel = getCurrentWindow().label;

      // Close all other windows first
      for (const w of allWindows) {
        if (w.label !== currentLabel) {
          await w.close();
        }
      }
      // Finally close this main window
      await getCurrentWindow().close();
    } catch (error) {
      console.error("Failed to close window:", error);
    }
  };

  const toggleWindowMenu = async () => {
    try {
      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'window-select');
      if (!popupWin) return;

      if (!isWindowMenuOpen) {
        // Compute position to show popup
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;

        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        // Send direction event so popup knows to animate from top or bottom
        await emit('window-select-direction', direction);

        // Position popup window relative to main window
        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + 30, logicalY - 360));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + 30, logicalY + 140));
        }

        await popupWin.show();
        await popupWin.setFocus();
        setIsWindowMenuOpen(true);
      } else {
        await popupWin.hide();
        setIsWindowMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle window menu:", error);
      alert(`Menu Toggle Error: ${error}`);
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="liquidGlass-wrapper dock">
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text dock">
          <div className="dock-item" title="Drag to Move" style={{ cursor: 'grab' }} onPointerDown={(e) => {
            if (e.button === 0) getCurrentWindow().startDragging();
          }}>
            <GripHorizontal />
            <span>Move</span>
          </div>

          <div className="dock-item" title="Projects">
            <FolderKanban />
            <span>Projects</span>
          </div>

          <div className="dock-item" title="Select Target Window" onClick={toggleWindowMenu} style={{
            background: isWindowMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            color: selectedWindow && selectedWindow.hwnd !== 0 ? '#60a5fa' : 'inherit'
          }}>
            <Maximize />
            <span>{selectedWindow && selectedWindow.hwnd !== 0 ? 'FIXED' : 'Window'}</span>
          </div>

          <div className="dock-item" title="Capture Screenshot (Ctrl+Shift+S)">
            <ImageIcon color="#4ade80" />
            <span>Capture</span>
          </div>

          <div className="dock-item" title="Settings">
            <Settings />
            <span>Settings</span>
          </div>

          <div className="dock-item" title="Close App" onClick={handleClose}>
            <X color="#f87171" />
            <span>Close</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- POPUP WINDOW ---
function WindowSelectPopup() {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('up');

  const fetchWindows = async () => {
    try {
      const wins: WindowInfo[] = await invoke('list_windows');
      setWindows(wins);
    } catch (err) {
      console.error("Failed to fetch windows:", err);
    }
  };

  useEffect(() => {
    fetchWindows();

    // Auto-fetch when window gets focused/shown
    const unlistenAuth = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) fetchWindows();
    });

    const unlistenDir = listen<'up' | 'down'>('window-select-direction', (e) => {
      setDirection(e.payload);
    });

    return () => {
      unlistenAuth.then(f => f());
      unlistenDir.then(f => f());
    }
  }, []);

  const handleSelectWindow = async (w: WindowInfo) => {
    setSelectedWindow(w);
    await emit('window-selected', w);
    const win = getCurrentWindow();
    await win.hide();
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: '10px' }}>
      <div className={`liquidGlass-wrapper window-popup ${direction}`}>
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint" style={{ background: 'rgba(20, 20, 20, 0.4)' }}></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text" style={{ display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 3, position: 'relative', width: '100%', height: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', padding: '0 4px' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 500, opacity: 0.8 }}>Select Target Window</span>
            <div
              style={{ cursor: 'pointer', padding: '4px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }}
              onClick={() => fetchWindows()}
            >
              <RefreshCw size={14} />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '4px' }}>
            <div
              className="window-item"
              style={{ borderColor: selectedWindow === null ? '#4ade80' : 'rgba(255,255,255,0.1)' }}
              onClick={() => handleSelectWindow({ hwnd: 0, title: 'Auto (Active Window)' })}
            >
              <span className="window-item-title" style={{ fontWeight: selectedWindow === null || selectedWindow?.hwnd === 0 ? 'bold' : 'normal' }}>
                Auto (Current Active Window)
              </span>
            </div>

            {windows.map(w => (
              <div
                key={w.hwnd}
                className="window-item"
                style={{ borderColor: selectedWindow?.hwnd === w.hwnd ? '#3b82f6' : 'rgba(255,255,255,0.1)' }}
                onClick={() => handleSelectWindow(w)}
              >
                <span className="window-item-title" title={w.title}>{w.title}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- ENTRY POINT ---
function App() {
  const currentWin = getCurrentWindow();

  if (currentWin.label === 'window-select') {
    return <WindowSelectPopup />;
  }

  return <MainApp />;
}

export default App;
