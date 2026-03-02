import { useState, useEffect, useRef } from 'react';
import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X, RefreshCw, Camera, Plus, Check, FileText, ScrollText, FileEdit, Trash2, Edit2, Save, Send } from 'lucide-react';
import { getCurrentWindow, currentMonitor, getAllWindows } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { appDataDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import './index.css';

interface WindowInfo {
  hwnd: number;
  title: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  text: string;
  created_at: number;
  dir_path: string;
  discord_thread_id?: string;
}

// ─── MAIN DOCK ───────────────────────────────────────────────────────────────
function MainApp() {
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isHistoryMenuOpen, setIsHistoryMenuOpen] = useState(false);
  const [isSettingsMenuOpen, setIsSettingsMenuOpen] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);

  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCapturePath, setLastCapturePath] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const feedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWindowMenuOpenRef = useRef(false);
  const isProjectMenuOpenRef = useRef(false);
  const isHistoryMenuOpenRef = useRef(false);
  const isSettingsMenuOpenRef = useRef(false);

  useEffect(() => { isWindowMenuOpenRef.current = isWindowMenuOpen; }, [isWindowMenuOpen]);
  useEffect(() => { isProjectMenuOpenRef.current = isProjectMenuOpen; }, [isProjectMenuOpen]);
  useEffect(() => { isHistoryMenuOpenRef.current = isHistoryMenuOpen; }, [isHistoryMenuOpen]);
  useEffect(() => { isSettingsMenuOpenRef.current = isSettingsMenuOpen; }, [isSettingsMenuOpen]);

  const lastMoveTime = useRef(0);
  const followPosition = async () => {
    const now = Date.now();
    if (now - lastMoveTime.current < 8) return; // Debounce to ~120fps
    lastMoveTime.current = now;

    const isWOpen = isWindowMenuOpenRef.current;
    const isPOpen = isProjectMenuOpenRef.current;
    const isHOpen = isHistoryMenuOpenRef.current;
    const isSOpen = isSettingsMenuOpenRef.current;
    if (!isWOpen && !isPOpen && !isHOpen && !isSOpen) return;

    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    const monitor = await currentMonitor();
    if (!monitor) return;

    const mainWidthPhysical = size.width;
    const mainXPhysical = pos.x;
    const mainYPhysical = pos.y;

    let direction: 'up' | 'down' = 'up';
    if (mainYPhysical < monitor.size.height / 2) direction = 'down';

    const popupsMapping = [
      { open: isWOpen, label: 'window-select', hOffset: 360, vOffset: 70 },
      { open: isPOpen, label: 'project-menu', hOffset: 420, vOffset: 70 },
      { open: isHOpen, label: 'history-menu', hOffset: 520, vOffset: 70 },
      { open: isSOpen, label: 'settings-menu', hOffset: 320, vOffset: 70 }
    ];

    const allWins = await getAllWindows();
    for (const p of popupsMapping) {
      if (p.open) {
        const popupWin = allWins.find(w => w.label === p.label);
        if (popupWin) {
          const pSize = await popupWin.outerSize();
          const offsetXPhysical = Math.round((mainWidthPhysical - pSize.width) / 2);
          const sf = monitor.scaleFactor;

          if (direction === 'up') {
            await popupWin.setPosition(new PhysicalPosition(
              mainXPhysical + offsetXPhysical,
              mainYPhysical - Math.round(p.hOffset * sf)
            ));
          } else {
            await popupWin.setPosition(new PhysicalPosition(
              mainXPhysical + offsetXPhysical,
              mainYPhysical + Math.round(p.vOffset * sf)
            ));
          }
        }
      }
    }
  };

  const getProjectsRoot = async () => {
    const saved = localStorage.getItem('projectsRoot');
    if (saved) return saved;
    return await appDataDir();
  };

  const loadProjects = async () => {
    try {
      const dataDir = await getProjectsRoot();
      const projList: ProjectInfo[] = await invoke('list_projects', { appDataDir: dataDir });
      if (projList.length > 0 && !activeProject) {
        setActiveProject(projList[0]);
      }
    } catch (e) {
      console.error("Failed to load projects", e);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

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

  const checkCapturePreviewOpen = async () => {
    try {
      const popupWin = (await getAllWindows()).find(w => w.label === 'capture-preview');
      if (popupWin && await popupWin.isVisible()) {
        await emit('capture-preview-blink');
        await popupWin.setFocus();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const toggleWindowMenu = async () => {
    try {
      if (await checkCapturePreviewOpen()) return;
      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'window-select');
      if (!popupWin) return;

      if (!isWindowMenuOpen) {
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('window-select-direction', direction);

        const outerSize = await win.outerSize();
        const pSize = await popupWin.outerSize();
        const offsetXPhysical = Math.round((outerSize.width - pSize.width) / 2);

        if (direction === 'up') {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round(360 * sf)));
        } else {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(70 * sf)));
        }

        await popupWin.show();
        await popupWin.setFocus();
        setIsWindowMenuOpen(true);

        // Close others concurrently without blocking
        if (isProjectMenuOpen) toggleProjectMenu();
        if (isHistoryMenuOpen) toggleHistoryMenu();
      } else {
        await popupWin.hide();
        setIsWindowMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle window menu:", error);
      alert(`Menu Toggle Error: ${error}`);
    }
  };

  const toggleProjectMenu = async () => {
    try {
      if (await checkCapturePreviewOpen()) return;
      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'project-menu');
      if (!popupWin) return;

      if (!isProjectMenuOpen) {
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('project-menu-direction', direction);

        const outerSize = await win.outerSize();
        const pSize = await popupWin.outerSize();
        const offsetXPhysical = Math.round((outerSize.width - pSize.width) / 2);

        // Same vertical logic as window select:
        // Height of project popup will be ~400
        if (direction === 'up') {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round(420 * sf)));
        } else {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(70 * sf)));
        }

        await popupWin.show();
        await popupWin.setFocus();
        setIsProjectMenuOpen(true);

        // Close others concurrently without blocking
        if (isWindowMenuOpen) toggleWindowMenu();
        if (isHistoryMenuOpen) toggleHistoryMenu();
      } else {
        await popupWin.hide();
        setIsProjectMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle project menu", error);
    }
  };

  const toggleHistoryMenu = async () => {
    try {
      if (await checkCapturePreviewOpen()) return;
      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'history-menu');
      if (!popupWin) return;

      if (!isHistoryMenuOpen) {
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('history-menu-direction', { direction, project: activeProject });

        const outerSize = await win.outerSize();
        const pSize = await popupWin.outerSize();
        const offsetXPhysical = Math.round((outerSize.width - pSize.width) / 2);

        if (direction === 'up') {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round(520 * sf)));
        } else {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(70 * sf)));
        }

        await popupWin.show();
        await popupWin.setFocus();
        setIsHistoryMenuOpen(true);

        // Close others concurrently without blocking
        if (isWindowMenuOpen) toggleWindowMenu();
        if (isProjectMenuOpen) toggleProjectMenu();
        if (isSettingsMenuOpen) toggleSettingsMenu();
      } else {
        await popupWin.hide();
        setIsHistoryMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle history menu", error);
    }
  };

  const toggleSettingsMenu = async () => {
    try {
      if (await checkCapturePreviewOpen()) return;
      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'settings-menu');
      if (!popupWin) return;

      if (!isSettingsMenuOpen) {
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('settings-menu-direction', direction);

        const outerSize = await win.outerSize();
        const pSize = await popupWin.outerSize();
        const offsetXPhysical = Math.round((outerSize.width - pSize.width) / 2);

        if (direction === 'up') {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round(320 * sf)));
        } else {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(70 * sf)));
        }

        await popupWin.show();
        await popupWin.setFocus();
        setIsSettingsMenuOpen(true);

        if (isWindowMenuOpen) toggleWindowMenu();
        if (isProjectMenuOpen) toggleProjectMenu();
        if (isHistoryMenuOpen) toggleHistoryMenu();
      } else {
        await popupWin.hide();
        setIsSettingsMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle settings menu", error);
    }
  };

  const handleTextOnly = async () => {
    if (!activeProject) return;
    try {
      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'capture-preview');
      if (popupWin) {
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;
        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        // パスを空にして「テキストのみ」モードとして開かせる
        await emit('show-capture-preview', { path: '', direction, project: activeProject });

        const targetPopupWidth = 400;
        const targetPopupHeight = 300;
        await popupWin.setSize(new LogicalSize(targetPopupWidth, targetPopupHeight));

        const outerSize = await win.outerSize();
        const offsetXPhysical = Math.round((outerSize.width - targetPopupWidth * sf) / 2);

        if (direction === 'up') {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round((targetPopupHeight + 20) * sf)));
        } else {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(70 * sf)));
        }

        await popupWin.show();
        await popupWin.setFocus();
        const allWins = await getAllWindows();
        const winSelect = allWins.find(w => w.label === 'window-select');
        const projMenu = allWins.find(w => w.label === 'project-menu');
        const histMenu = allWins.find(w => w.label === 'history-menu');
        if (winSelect) await winSelect.hide();
        if (projMenu) await projMenu.hide();
        if (histMenu) await histMenu.hide();

        setIsWindowMenuOpen(false);
        setIsProjectMenuOpen(false);
        setIsHistoryMenuOpen(false);
      }
    } catch (err) {
      console.error("Failed to open text-only capture preview", err);
    }
  };

  const handleActiveProjectEvent = async (p: ProjectInfo) => {
    setActiveProject(p);
  };

  useEffect(() => {
    const unlistenProj = listen<ProjectInfo>('project-selected', (e) => {
      handleActiveProjectEvent(e.payload);
      setIsProjectMenuOpen(false);
    });

    const unlistenCloseProj = listen('project-menu-closed', () => {
      setIsProjectMenuOpen(false);
    });

    const unlistenCloseHist = listen('history-menu-closed', () => {
      setIsHistoryMenuOpen(false);
    });

    const unlistenCloseSet = listen('settings-menu-closed', () => {
      setIsSettingsMenuOpen(false);
    });

    return () => {
      unlistenProj.then(f => f());
      unlistenCloseProj.then(f => f());
      unlistenCloseHist.then(f => f());
      unlistenCloseSet.then(f => f());
    };
  }, []);

  const handleCapture = async () => {
    if (isCapturing) return;
    setIsCapturing(true);
    setCaptureError(null);
    setLastCapturePath(null);

    try {
      // Save into active project or fallback to root captures
      let saveDir;
      if (activeProject) {
        saveDir = `${activeProject.dir_path}/captures`;
      } else {
        const dataDir = await getProjectsRoot();
        saveDir = `${dataDir}captures`;
      }

      const hwnd = selectedWindow && selectedWindow.hwnd !== 0 ? selectedWindow.hwnd : 0;
      console.log('Initiating capture:', {
        target: selectedWindow ? selectedWindow.title : 'Auto (Foreground)',
        hwnd: hwnd
      });

      const savedPath: string = await invoke('capture_window', { hwnd, saveDir });

      setLastCapturePath(savedPath);
      console.log('Captured:', savedPath);

      // Open preview window
      const popupWin = (await getAllWindows()).find(w => w.label === 'capture-preview');
      if (popupWin) {
        const win = getCurrentWindow();
        const monitor = await currentMonitor();
        const pos = await win.outerPosition();
        const sf = monitor ? monitor.scaleFactor : 1;
        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        const targetPopupWidth = 400;
        const targetPopupHeight = 550;
        await popupWin.setSize(new LogicalSize(targetPopupWidth, targetPopupHeight));

        const outerSize = await win.outerSize();
        const offsetXPhysical = Math.round((outerSize.width - targetPopupWidth * sf) / 2);

        if (direction === 'up') {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round((targetPopupHeight + 20) * sf)));
        } else {
          await popupWin.setPosition(new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(70 * sf)));
        }

        const allWins = await getAllWindows();
        const winSelect = allWins.find(w => w.label === 'window-select');
        const projMenu = allWins.find(w => w.label === 'project-menu');
        const histMenu = allWins.find(w => w.label === 'history-menu');
        if (winSelect) await winSelect.hide();
        if (projMenu) await projMenu.hide();
        if (histMenu) await histMenu.hide();

        setIsWindowMenuOpen(false);
        setIsProjectMenuOpen(false);
        setIsHistoryMenuOpen(false);

        await popupWin.show();
        await popupWin.setFocus();
        await emit('show-capture-preview', { path: savedPath, direction, project: activeProject });
      }

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

          <div className="dock-item" title="Projects (Ctrl+P)" onClick={toggleProjectMenu} style={{
            background: isProjectMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            color: activeProject ? '#a78bfa' : 'inherit'
          }}>
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

          <div className="dock-item" title="Text Note" onClick={handleTextOnly} style={{
            opacity: activeProject ? 1 : 0.3,
            cursor: activeProject ? 'pointer' : 'not-allowed'
          }}>
            <FileEdit />
          </div>

          <div className="dock-item" title="Project History" onClick={toggleHistoryMenu} style={{
            background: isHistoryMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            opacity: activeProject ? 1 : 0.3,
            cursor: activeProject ? 'pointer' : 'not-allowed'
          }}>
            <ScrollText />
          </div>

          <div className="dock-item" title="Settings" onClick={toggleSettingsMenu} style={{
            background: isSettingsMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
          }}>
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

// ─── PROJECT MENU POPUP ──────────────────────────────────────────────────────
function ProjectMenuPopup() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [newProjectName, setNewProjectName] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectText, setProjectText] = useState('');
  const [discordThreadId, setDiscordThreadId] = useState('');
  const [isSavingText, setIsSavingText] = useState(false);

  const getProjectsRoot = async () => {
    const saved = localStorage.getItem('projectsRoot');
    if (saved) return saved;
    return await appDataDir();
  };

  const fetchProjects = async () => {
    try {
      const dataDir = await getProjectsRoot();
      const wins: ProjectInfo[] = await invoke('list_projects', { appDataDir: dataDir });
      setProjects(wins);
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    }
  };

  useEffect(() => {
    fetchProjects();

    const unlistenAuth = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) fetchProjects();
    });

    const unlistenDir = listen<'up' | 'down'>('project-menu-direction', (e) => {
      setDirection(e.payload);
    });

    return () => {
      unlistenAuth.then(f => f());
      unlistenDir.then(f => f());
    }
  }, []);

  // Set first project as selected by default if none
  useEffect(() => {
    if (projects.length > 0 && !selectedProject) {
      handleSelectProject(projects[0]);
    }
  }, [projects]);


  const handleSelectProject = (p: ProjectInfo) => {
    setSelectedProject(p);
    setProjectText(p.text);
    setDiscordThreadId(p.discord_thread_id || '');
  };

  const activateProject = async (p: ProjectInfo) => {
    await emitTo('main', 'project-selected', p);
    const win = getCurrentWindow();
    await win.hide();
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const dataDir = await getProjectsRoot();
      const newProj: ProjectInfo = await invoke('create_project', {
        appDataDir: dataDir,
        name: newProjectName.trim(),
        text: ''
      });
      await fetchProjects();
      handleSelectProject(newProj);
      activateProject(newProj);
      setNewProjectName('');
      setIsCreatingProject(false);
    } catch (e) {
      console.error("Failed to create project:", e);
    }
  };

  const handleUpdateText = async () => {
    if (!selectedProject) return;
    setIsSavingText(true);
    try {
      const updatedInfo = { ...selectedProject, text: projectText, discord_thread_id: discordThreadId };
      await invoke('update_project', {
        project: updatedInfo
      });
      fetchProjects();

      // Update local state without losing focus ideally
      setSelectedProject(updatedInfo);

    } catch (e) {
      console.error("Failed to update text:", e);
    } finally {
      setIsSavingText(false);
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: '10px' }}>
      <div className={`liquidGlass-wrapper window-popup ${direction}`}>
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text project-menu-container" style={{ display: 'flex', gap: '16px', zIndex: 3, position: 'relative', width: '100%', height: '100%' }}>

          {/* Left Panel: Project List */}
          <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '8px', borderRight: '1px solid rgba(255,255,255,0.1)', paddingRight: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 8px 4px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 600, opacity: 0.9 }}>Projects</span>
              <div
                style={{ cursor: 'pointer', padding: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }}
                onClick={() => setIsCreatingProject(!isCreatingProject)}
              >
                {isCreatingProject ? <X size={14} /> : <Plus size={14} />}
              </div>
            </div>

            {isCreatingProject && (
              <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                <input
                  autoFocus
                  type="text"
                  className="project-input"
                  placeholder="New Project Name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject(); }}
                />
                <button className="project-btn primary" onClick={handleCreateProject}>
                  <Check size={14} />
                </button>
              </div>
            )}

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }} className="window-list-scroll">
              {projects.length === 0 && !isCreatingProject ? (
                <div style={{ opacity: 0.5, fontSize: '0.8rem', textAlign: 'center', marginTop: '20px' }}>No projects yet</div>
              ) : null}

              {projects.map(p => (
                <div
                  key={p.id}
                  className={`window-item ${selectedProject?.id === p.id ? 'selected' : ''}`}
                  onClick={() => handleSelectProject(p)}
                  onDoubleClick={() => activateProject(p)}
                >
                  <span className="window-item-title" title={p.name}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right Panel: Project Details */}
          <div style={{ flex: '2', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {selectedProject ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '1rem', fontWeight: 600 }}>{selectedProject.name}</span>
                    <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>{new Date(selectedProject.created_at).toLocaleDateString()}</span>
                  </div>
                  <button
                    className="project-btn apply"
                    onClick={() => activateProject(selectedProject)}
                  >
                    Select Active
                  </button>
                </div>

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.8 }}>
                    <FileText size={14} />
                    <span style={{ fontSize: '0.8rem' }}>Project Notes</span>
                    {isSavingText && <span style={{ fontSize: '0.7rem', color: '#4ade80' }}>Saved</span>}
                  </div>
                  <textarea
                    className="project-textarea window-list-scroll"
                    value={projectText}
                    onChange={(e) => setProjectText(e.target.value)}
                    onBlur={handleUpdateText}
                    placeholder="Add texts, links, and context here. They will be saved to your project folder."
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                    <span style={{ fontSize: '0.8rem', opacity: 0.8, whiteSpace: 'nowrap' }}>Discord Thread ID:</span>
                    <input
                      type="text"
                      className="project-input"
                      value={discordThreadId}
                      onChange={(e) => setDiscordThreadId(e.target.value)}
                      onBlur={handleUpdateText}
                      placeholder="Optional"
                      style={{ flex: 1, height: '30px', fontSize: '0.85rem' }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.5, fontSize: '0.9rem' }}>
                Select or Create a project
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── CAPTURE PREVIEW POPUP ───────────────────────────────────────────────────
function CapturePreviewPopup() {
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [isBlinking, setIsBlinking] = useState(false);
  const maxChars = 2000;

  useEffect(() => {
    const unlisten = listen<{ path: string, direction: string, project: ProjectInfo | null }>('show-capture-preview', async (e) => {
      const { path, project } = e.payload;
      setImagePath(path || null);
      setProject(project);
      setText('');
      try {
        if (path) {
          const bytes: number[] = await invoke('read_file_bytes', { path });
          const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
          setImageSrc(URL.createObjectURL(blob));
        } else {
          setImageSrc(null);
        }
      } catch (err) {
        console.error("Failed to load image preview:", err);
      }
    });

    const unlistenBlink = listen('capture-preview-blink', () => {
      setIsBlinking(false);
      setTimeout(() => setIsBlinking(true), 10);
      setTimeout(() => setIsBlinking(false), 500);
    });

    return () => {
      unlisten.then(f => f());
      unlistenBlink.then(f => f());
    };
  }, []);

  const isTextOnly = !imagePath;

  const handleSave = async () => {
    if (!project) return;
    setIsSaving(true);
    try {
      let savedJsonPath = "";
      if (isTextOnly) {
        savedJsonPath = await invoke('save_text_only', {
          projectDir: project.dir_path,
          text: text
        });
      } else {
        savedJsonPath = await invoke('save_capture_text', {
          imagePath: imagePath,
          text: text
        });
      }

      // Auto-post if enabled
      const autoPostEnabled = localStorage.getItem('discordAutoPost') === 'true';
      const webhookUrl = localStorage.getItem('discordWebhookUrl');
      if (autoPostEnabled && webhookUrl) {
        try {
          await invoke('post_to_discord', {
            webhookUrl,
            text: text,
            imagePath: imagePath || '',
            threadId: project.discord_thread_id || null
          });

          if (savedJsonPath) {
            await invoke('mark_discord_posted', { jsonPath: savedJsonPath });
          }
        } catch (postErr) {
          console.error("Failed to auto-post after save", postErr);
        }
      }

      setText('');
      await getCurrentWindow().hide();
    } catch (err) {
      console.error("Failed to save capture", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSkip = async () => {
    if (imagePath) {
      try {
        await invoke('delete_capture_item', { imagePath: imagePath, jsonPath: "" });
      } catch (err) {
        console.error("Failed to delete skipped capture", err);
      }
    }
    const win = getCurrentWindow();
    await win.hide();
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: '10px' }}>
      <div className={`liquidGlass-wrapper window-popup up ${isBlinking ? 'blink-warn' : ''}`} style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text" style={{ display: 'flex', flexDirection: 'column', gap: '12px', zIndex: 3, position: 'relative', width: '100%', height: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'grab' }} onPointerDown={(e) => {
              if (e.button === 0) getCurrentWindow().startDragging();
            }}>
              <GripHorizontal size={14} style={{ opacity: 0.5 }} />
              <span style={{ fontSize: '1rem', fontWeight: 600 }}>{isTextOnly ? "Text Note" : "Capture Preview"}</span>
            </div>
            <X size={16} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={handleSkip} />
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflow: 'hidden' }}>
            {/* Top: Image Preview - 隠すか表示するか判定 */}
            {!isTextOnly && (
              <div style={{ height: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', overflow: 'hidden', flexShrink: 0 }}>
                {imageSrc ? (
                  <img src={imageSrc} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                ) : (
                  <span style={{ opacity: 0.5 }}>Loading preview...</span>
                )}
              </div>
            )}

            {/* Bottom: Text Input */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '150px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.8 }}>
                {isTextOnly ? <FileEdit size={14} /> : <FileText size={14} />}
                <span style={{ fontSize: '0.85rem' }}>{isTextOnly ? "Add Text Note" : "Add Context or Notes"}</span>
              </div>
              <textarea
                autoFocus
                className="project-textarea window-list-scroll"
                style={{ flex: 1, resize: 'none', fontSize: '0.9rem' }}
                placeholder={isTextOnly ? "Enter your note here..." : "What's happening in this capture..."}
                value={text}
                onChange={(e) => {
                  if (e.target.value.length <= maxChars) setText(e.target.value);
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', opacity: text.length > maxChars * 0.9 ? 1 : 0.5, color: text.length >= maxChars ? '#f87171' : 'inherit' }}>
                  {text.length} / {maxChars}
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="project-btn apply" onClick={handleSave} disabled={isSaving || (!isTextOnly && !imagePath) || (isTextOnly && text.trim() === '')}>
                    {isSaving ? 'Saving...' : 'Save & Close'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── HISTORY MENU POPUP ──────────────────────────────────────────────────────
interface HistoryItem {
  image_path: string;
  json_path: string;
  image_name: string;
  text: string;
  timestamp: number;
  discord_posted?: boolean;
}

function HistoryMenuPopup() {
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [images, setImages] = useState<Record<string, string>>({}); // path -> objectURL

  // Edit / Delete State
  const [editingItemPath, setEditingItemPath] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isBatchPosting, setIsBatchPosting] = useState(false);

  const loadHistory = async (proj: ProjectInfo) => {
    try {
      const items: HistoryItem[] = await invoke('get_project_captures', { projectDir: proj.dir_path });
      setHistoryItems(items);

      // Eager load images where applicable
      for (const item of items) {
        if (item.image_path) {
          invoke<number[]>('read_file_bytes', { path: item.image_path }).then(bytes => {
            const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
            const url = URL.createObjectURL(blob);
            setImages(prev => ({ ...prev, [item.image_path]: url }));
          }).catch(e => console.error("Failed to load history image preview:", e));
        }
      }
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  };

  useEffect(() => {
    const unlistenDir = listen<{ direction: 'up' | 'down', project: ProjectInfo | null }>('history-menu-direction', async (e) => {
      setDirection(e.payload.direction);
      const proj = e.payload.project;
      setProject(proj);
      if (proj) {
        loadHistory(proj);
      } else {
        setHistoryItems([]);
      }
    });

    const unlistenRefresh = listen('history-menu-refresh', () => {
      if (project) loadHistory(project);
    });

    return () => {
      unlistenDir.then(f => f());
      unlistenRefresh.then(f => f());
      // Cleanup ObjectURLs
      Object.values(images).forEach(url => URL.revokeObjectURL(url));
    }
  }, [project, images]);

  const handleDelete = async (item: HistoryItem) => {
    if (!project) return;
    try {
      await invoke('delete_capture_item', { imagePath: item.image_path, jsonPath: item.json_path });
      // Refresh list
      loadHistory(project);
    } catch (e) {
      console.error("Failed to delete", e);
    }
  };

  const handleStartEdit = (item: HistoryItem) => {
    setEditingItemPath(item.json_path);
    setEditingText(item.text);
  };

  const handleSaveEdit = async (item: HistoryItem) => {
    if (!project) return;
    setIsSavingEdit(true);
    try {
      await invoke('update_capture_text', { jsonPath: item.json_path, newText: editingText });
      setEditingItemPath(null);
      loadHistory(project);
    } catch (e) {
      console.error("Failed to save edit", e);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingItemPath(null);
    setEditingText("");
  };

  const handleBatchPost = async () => {
    if (!project) return;
    const webhookUrl = localStorage.getItem('discordWebhookUrl');
    if (!webhookUrl) {
      alert("Please configure a Discord Webhook URL in Settings first.");
      return;
    }

    const unpostedItems = historyItems.filter(i => !i.discord_posted);
    if (unpostedItems.length === 0) return;

    setIsBatchPosting(true);
    try {
      // Items are sorted newest first, so we loop backwards to send oldest first
      for (let i = unpostedItems.length - 1; i >= 0; i--) {
        const item = unpostedItems[i];
        await invoke('post_to_discord', {
          webhookUrl,
          text: item.text || '',
          imagePath: item.image_path || '',
          threadId: project.discord_thread_id || null
        });
        await invoke('mark_discord_posted', { jsonPath: item.json_path });

        // Wait 2 seconds between posts to avoid rate limit unless it's the last item
        if (i !== 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Refresh list
      await loadHistory(project);
    } catch (e) {
      console.error("Batch post failed:", e);
      alert(`Batch post error: ${e}`);
    } finally {
      setIsBatchPosting(false);
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: '10px' }}>
      <div className={`liquidGlass-wrapper window-popup ${direction}`} style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text" style={{ zIndex: 3, position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '1rem', fontWeight: 600 }}>
              {project ? `Project History: ${project.name}` : `Project History`}
            </span>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {project && historyItems.some(i => !i.discord_posted) && (
                <button
                  className="project-btn apply"
                  onClick={handleBatchPost}
                  disabled={isBatchPosting}
                  style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                >
                  <Send size={14} style={{ marginRight: '6px' }} />
                  {isBatchPosting ? 'Sending...' : 'Batch Post Unsent'}
                </button>
              )}
              <X size={16} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={() => {
                emitTo('main', 'history-menu-closed');
                getCurrentWindow().hide();
              }} />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px', paddingRight: '4px' }} className="window-list-scroll">
            {!project && (
              <div style={{ opacity: 0.5, textAlign: 'center', marginTop: '20px' }}>No project selected.</div>
            )}
            {project && historyItems.length === 0 && (
              <div style={{ opacity: 0.5, textAlign: 'center', marginTop: '20px' }}>No captures found for this project.</div>
            )}
            {historyItems.map((item, idx) => {
              const isEditing = editingItemPath === item.json_path;
              return (
                <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', padding: '15px', background: 'rgba(20, 20, 20, 0.85)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '10px', position: 'relative', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}>
                  <div style={{ position: 'absolute', top: '8px', right: '8px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {item.discord_posted && !isEditing && (
                      <div title="Posted to Discord" style={{ color: '#5865F2', display: 'flex', alignItems: 'center', marginRight: '4px' }}>
                        <Check size={16} />
                      </div>
                    )}
                    {isEditing ? null : (
                      <>
                        <button style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: '4px' }} title="Edit Text" onClick={() => handleStartEdit(item)}>
                          <Edit2 size={14} />
                        </button>
                        <button style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', padding: '4px' }} title="Delete History" onClick={() => handleDelete(item)}>
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>

                  {item.image_path && (
                    <div style={{ width: '200px', height: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      {images[item.image_path] ? (
                        <img src={images[item.image_path]} style={{ width: '100%', objectFit: 'contain' }} />
                      ) : (
                        <span style={{ opacity: 0.5, padding: '20px' }}>Loading...</span>
                      )}
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '4px', marginRight: '40px' }}>
                    <div style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                      {new Date(item.timestamp).toLocaleString()} {item.image_path ? '' : '(Text Only)'}
                    </div>
                    {isEditing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                        <textarea
                          className="project-textarea"
                          autoFocus
                          style={{ minHeight: '80px', fontSize: '0.85rem' }}
                          value={editingText}
                          onChange={e => setEditingText(e.target.value)}
                        />
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                          <button className="project-btn apply" onClick={() => handleSaveEdit(item)} disabled={isSavingEdit}>
                            <Save size={14} style={{ marginRight: '4px' }} /> Save
                          </button>
                          <button className="project-btn add" onClick={handleCancelEdit} disabled={isSavingEdit}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.9, marginTop: '4px' }}>
                        {item.text || <span style={{ fontStyle: 'italic', opacity: 0.5 }}>No text provided.</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
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

  if (currentWin.label === 'project-menu') {
    return <ProjectMenuPopup />;
  }

  if (currentWin.label === 'capture-preview') {
    return <CapturePreviewPopup />;
  }

  if (currentWin.label === 'history-menu') {
    return <HistoryMenuPopup />;
  }

  if (currentWin.label === 'settings-menu') {
    return <SettingsMenuPopup />;
  }

  return <MainApp />;
}

// ─── SETTINGS MENU POPUP ─────────────────────────────────────────────────────
function SettingsMenuPopup() {
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [autoPost, setAutoPost] = useState(false);
  const [projectsRoot, setProjectsRoot] = useState('');

  useEffect(() => {
    const unlistenDir = listen<'up' | 'down'>('settings-menu-direction', (e) => {
      setDirection(e.payload);
    });

    // Load from localStorage
    const savedUrl = localStorage.getItem('discordWebhookUrl');
    if (savedUrl) setWebhookUrl(savedUrl);

    const savedAuto = localStorage.getItem('discordAutoPost');
    if (savedAuto) setAutoPost(savedAuto === 'true');

    const loadProjectsRoot = async () => {
      const savedRoot = localStorage.getItem('projectsRoot');
      if (savedRoot) {
        setProjectsRoot(savedRoot);
      } else {
        setProjectsRoot(await appDataDir());
      }
    };
    loadProjectsRoot();

    return () => {
      unlistenDir.then(f => f());
    };
  }, []);

  const handlePickProjectsRoot = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: projectsRoot
      });
      if (selected && typeof selected === 'string') {
        setProjectsRoot(selected);
      }
    } catch (e) {
      console.error("Failed to open directory picker", e);
    }
  };

  const handleSave = () => {
    localStorage.setItem('discordWebhookUrl', webhookUrl);
    localStorage.setItem('discordAutoPost', autoPost ? 'true' : 'false');
    localStorage.setItem('projectsRoot', projectsRoot);
    // Notify MainApp of settings change so interval runs with latest
    emitTo('main', 'settings-updated');
    handleClose();
  };

  const handleClose = async () => {
    await emitTo('main', 'settings-menu-closed');
    const win = getCurrentWindow();
    await win.hide();
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: '10px' }}>
      <div className={`liquidGlass-wrapper window-popup ${direction}`} style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text object-fit" style={{ zIndex: 3, position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px', marginBottom: '16px' }}>
            <span style={{ fontSize: '1rem', fontWeight: 600 }}>Settings</span>
            <X size={16} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={handleClose} />
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.9 }}>Project Files Folder</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  className="project-input"
                  placeholder="Select folder..."
                  value={projectsRoot}
                  readOnly
                  style={{ flex: 1, fontSize: '0.8rem', opacity: 0.8 }}
                />
                <button
                  className="project-btn apply"
                  onClick={handlePickProjectsRoot}
                  style={{ whiteSpace: 'nowrap', padding: '0 12px' }}
                >
                  Browse
                </button>
              </div>
              <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                Select the base directory where projects and captures will be stored.
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.9 }}>Discord Webhook URL</label>
              <input
                type="text"
                className="project-input"
                placeholder="https://discord.com/api/webhooks/..."
                value={webhookUrl}
                onChange={e => setWebhookUrl(e.target.value)}
              />
              <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                Enter the webhook URL where captures should be posted. Include thread_id query parameters if you want to post to a specific thread.
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                id="autoPost"
                checked={autoPost}
                onChange={e => setAutoPost(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="autoPost" style={{ fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer' }}>
                Enable Automatic Posting
              </label>
            </div>

            <div style={{ flex: 1 }} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: 'auto' }}>
              <button className="project-btn add" onClick={handleClose}>Cancel</button>
              <button className="project-btn apply" onClick={handleSave}>Save Settings</button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
