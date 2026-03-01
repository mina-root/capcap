import { useState, useEffect, useRef } from 'react';
import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X, RefreshCw, Camera } from 'lucide-react';
import { getCurrentWindow, currentMonitor, getAllWindows } from '@tauri-apps/api/window';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { appDataDir } from '@tauri-apps/api/path';
import './index.css';

interface WindowInfo {
  hwnd: number;
  title: string;
}

// ─── MAIN DOCK ───────────────────────────────────────────────────────────────
function MainApp() {
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCapturePath, setLastCapturePath] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const feedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const followPosition = async () => {
    if (!isWindowMenuOpen) return;
    const popupWin = (await getAllWindows()).find(w => w.label === 'window-select');
    if (popupWin) {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const monitor = await currentMonitor();
      const sf = monitor ? monitor.scaleFactor : 1;
      const logicalY = pos.y / sf;
      const logicalX = pos.x / sf;

      let direction: 'up' | 'down' = 'up';
      if (monitor && pos.y < monitor.size.height / 2) direction = 'down';

      const popupWidth = 540;
      const mainWidth = 310;
      const offsetX = (mainWidth - popupWidth) / 2;

      if (direction === 'up') {
        await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 360));
      } else {
        await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
      }
    }
  };

  useEffect(() => {
    // コンポーネントマウント時に一度だけリスナーを登録
    const setupListeners = async () => {
      const unlistenSelected = await listen<WindowInfo>('window-selected', (event) => {
        console.log('MainApp: Received window-selected event', event.payload);
        setSelectedWindow(event.payload);
        setIsWindowMenuOpen(false);
      });

      const unlistenClose = await listen('window-select-closed', () => {
        setIsWindowMenuOpen(false);
      });

      const unlistenMove = await getCurrentWindow().onMoved(followPosition);

      return () => {
        unlistenSelected();
        unlistenClose();
        unlistenMove();
      };
    };

    const cleanupPromise = setupListeners();
    return () => {
      cleanupPromise.then(cleanup => cleanup());
    };
  }, []); // 依存関係なしで一度だけ実行

  // ─ Keyboard shortcut: Ctrl+Shift+S ─
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
        e.preventDefault();
        handleCapture();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedWindow]);

  const handleClose = async () => {
    try {
      const allWindows = await getAllWindows();
      const currentLabel = getCurrentWindow().label;
      for (const w of allWindows) {
        if (w.label !== currentLabel) await w.close();
      }
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
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('window-select-direction', direction);

        const popupWidth = 540;
        const mainWidth = 310;
        const offsetX = (mainWidth - popupWidth) / 2;

        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 360));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
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

  const handleCapture = async () => {
    if (isCapturing) return;
    setIsCapturing(true);
    setCaptureError(null);
    setLastCapturePath(null);

    try {
      // Save into <appDataDir>/captures/ so the path is always valid
      const dataDir = await appDataDir();
      const saveDir = `${dataDir}captures`;

      const hwnd = selectedWindow && selectedWindow.hwnd !== 0 ? selectedWindow.hwnd : 0;
      console.log('Initiating capture:', {
        target: selectedWindow ? selectedWindow.title : 'Auto (Foreground)',
        hwnd: hwnd
      });

      const savedPath: string = await invoke('capture_window', { hwnd, saveDir });

      setLastCapturePath(savedPath);
      console.log('Captured:', savedPath);

      // Auto-clear feedback after 3 s
      if (feedbackTimeout.current) clearTimeout(feedbackTimeout.current);
      feedbackTimeout.current = setTimeout(() => setLastCapturePath(null), 3000);
    } catch (err) {
      console.error('Capture failed:', err);
      setCaptureError(String(err));
      if (feedbackTimeout.current) clearTimeout(feedbackTimeout.current);
      feedbackTimeout.current = setTimeout(() => setCaptureError(null), 4000);
    } finally {
      setIsCapturing(false);
    }
  };

  // Determine capture button appearance
  const captureTitle = lastCapturePath
    ? `Saved: ${lastCapturePath}`
    : captureError
      ? `Error: ${captureError}`
      : 'Capture Screenshot (Ctrl+Shift+S)';

  const captureColor = captureError ? '#f87171' : lastCapturePath ? '#4ade80' : '#4ade80';

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
          </div>

          <div className="dock-item" title="Projects">
            <FolderKanban />
          </div>

          <div className="dock-item" title="Select Target Window" onClick={toggleWindowMenu} style={{
            background: isWindowMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            color: selectedWindow && selectedWindow.hwnd !== 0 ? '#60a5fa' : 'inherit'
          }}>
            <Maximize />
          </div>

          {/* ─ Capture button ─ */}
          <div
            className="dock-item"
            title={captureTitle}
            onClick={handleCapture}
            style={{
              opacity: isCapturing ? 0.5 : 1,
              cursor: isCapturing ? 'wait' : 'pointer',
              transition: 'opacity 0.2s',
            }}
          >
            {isCapturing
              ? <Camera size={20} color="#facc15" style={{ animation: 'spin 1s linear infinite' }} />
              : <ImageIcon color={captureColor} />
            }
          </div>

          <div className="dock-item" title="Settings">
            <Settings />
          </div>

          <div className="dock-item" title="Close App" onClick={handleClose}>
            <X color="#f87171" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── POPUP WINDOW ────────────────────────────────────────────────────────────
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
    await emitTo('main', 'window-selected', w);
    const win = getCurrentWindow();
    await win.hide();
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: '10px' }}>
      <div className={`liquidGlass-wrapper window-popup ${direction}`}>
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text" style={{ display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 3, position: 'relative', width: '100%', height: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 8px 4px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600, opacity: 0.9 }}>Capture Target</span>
            <div
              style={{ cursor: 'pointer', padding: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', transition: 'transform 0.2s' }}
              onClick={() => fetchWindows()}
              onMouseEnter={(e) => e.currentTarget.style.transform = 'rotate(180deg)'}
              onMouseLeave={(e) => e.currentTarget.style.transform = 'rotate(0deg)'}
            >
              <RefreshCw size={14} />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '6px' }} className="window-list-scroll">
            <div
              className={`window-item ${selectedWindow === null || selectedWindow?.hwnd === 0 ? 'selected' : ''}`}
              onClick={() => handleSelectWindow({ hwnd: 0, title: 'Auto (Active Window)' })}
            >
              <span className="window-item-title">
                Auto (Current Active Window)
              </span>
            </div>

            {windows.map(w => (
              <div
                key={w.hwnd}
                className={`window-item ${selectedWindow?.hwnd === w.hwnd ? 'selected' : ''}`}
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

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
function App() {
  const currentWin = getCurrentWindow();

  if (currentWin.label === 'window-select') {
    return <WindowSelectPopup />;
  }

  return <MainApp />;
}

export default App;
