import { useState, useEffect, useRef } from 'react';
import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X, RefreshCw, Camera, Plus, Check, FileText, ScrollText, FileEdit, Trash2, Edit2, Save } from 'lucide-react';
import { getCurrentWindow, currentMonitor, getAllWindows } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { appDataDir } from '@tauri-apps/api/path';
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
}

// ─── MAIN DOCK ───────────────────────────────────────────────────────────────
function MainApp() {
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isHistoryMenuOpen, setIsHistoryMenuOpen] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);

  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCapturePath, setLastCapturePath] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const feedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWindowMenuOpenRef = useRef(false);
  const isProjectMenuOpenRef = useRef(false);
  const isHistoryMenuOpenRef = useRef(false);

  useEffect(() => { isWindowMenuOpenRef.current = isWindowMenuOpen; }, [isWindowMenuOpen]);
  useEffect(() => { isProjectMenuOpenRef.current = isProjectMenuOpen; }, [isProjectMenuOpen]);
  useEffect(() => { isHistoryMenuOpenRef.current = isHistoryMenuOpen; }, [isHistoryMenuOpen]);

  const followPosition = async () => {
    const isWOpen = isWindowMenuOpenRef.current;
    const isPOpen = isProjectMenuOpenRef.current;
    const isHOpen = isHistoryMenuOpenRef.current;
    if (!isWOpen && !isPOpen && !isHOpen) return;

    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const monitor = await currentMonitor();
    if (!monitor) return;
    const sf = monitor.scaleFactor;
    const logicalY = pos.y / sf;
    const logicalX = pos.x / sf;

    let direction: 'up' | 'down' = 'up';
    if (pos.y < monitor.size.height / 2) direction = 'down';

    const mainWidth = 310;

    if (isWOpen) {
      const popupWin = (await getAllWindows()).find(w => w.label === 'window-select');
      if (popupWin) {
        const popupWidth = 540;
        const offsetX = (mainWidth - popupWidth) / 2;
        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 360));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
        }
      }
    }

    if (isPOpen) {
      const popupWin = (await getAllWindows()).find(w => w.label === 'project-menu');
      if (popupWin) {
        const popupWidth = 600;
        const offsetX = (mainWidth - popupWidth) / 2;
        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 420));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
        }
      }
    }

    if (isHOpen) {
      const popupWin = (await getAllWindows()).find(w => w.label === 'history-menu');
      if (popupWin) {
        const popupWidth = 600;
        const offsetX = (mainWidth - popupWidth) / 2;
        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 520));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
        }
      }
    }
  };

  const loadProjects = async () => {
    try {
      const dataDir = await appDataDir();
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
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('window-select-direction', direction);

        const popupWidth = 540;
        const mainWidth = 410;
        const offsetX = (mainWidth - popupWidth) / 2;

        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 360));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
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
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('project-menu-direction', direction);

        const popupWidth = 600;
        const mainWidth = 410;
        const offsetX = (mainWidth - popupWidth) / 2;

        // Same vertical logic as window select:
        // Height of project popup will be ~400
        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 420));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
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
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        await emit('history-menu-direction', { direction, project: activeProject });

        const popupWidth = 600;
        const mainWidth = 410;
        const offsetX = (mainWidth - popupWidth) / 2;

        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - 520));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
        }

        await popupWin.show();
        await popupWin.setFocus();
        setIsHistoryMenuOpen(true);

        // Close others concurrently without blocking
        if (isWindowMenuOpen) toggleWindowMenu();
        if (isProjectMenuOpen) toggleProjectMenu();
      } else {
        await popupWin.hide();
        setIsHistoryMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle history menu", error);
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
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        // パスを空にして「テキストのみ」モードとして開かせる
        await emit('show-capture-preview', { path: '', direction, project: activeProject });

        const popupWidth = 400;
        const popupHeight = 300;
        await popupWin.setSize(new LogicalSize(popupWidth, popupHeight));

        const mainWidth = 410;
        const offsetX = (mainWidth - popupWidth) / 2;

        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - popupHeight - 20));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
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

    return () => {
      unlistenProj.then(f => f());
      unlistenCloseProj.then(f => f());
      unlistenCloseHist.then(f => f());
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
        const dataDir = await appDataDir();
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
        const logicalY = pos.y / sf;
        const logicalX = pos.x / sf;

        let direction: 'up' | 'down' = 'up';
        if (monitor) {
          if (pos.y < monitor.size.height / 2) direction = 'down';
        }

        const popupWidth = 400;
        const popupHeight = 550;
        await popupWin.setSize(new LogicalSize(popupWidth, popupHeight));

        const mainWidth = 410;
        const offsetX = (mainWidth - popupWidth) / 2;

        if (direction === 'up') {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY - popupHeight - 20));
        } else {
          await popupWin.setPosition(new LogicalPosition(logicalX + offsetX, logicalY + 70));
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

// ─── PROJECT MENU POPUP ──────────────────────────────────────────────────────
function ProjectMenuPopup() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [newProjectName, setNewProjectName] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectText, setProjectText] = useState('');
  const [isSavingText, setIsSavingText] = useState(false);

  const fetchProjects = async () => {
    try {
      const dataDir = await appDataDir();
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
  };

  const activateProject = async (p: ProjectInfo) => {
    await emitTo('main', 'project-selected', p);
    const win = getCurrentWindow();
    await win.hide();
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const dataDir = await appDataDir();
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
      await invoke('update_project_text', {
        projectDir: selectedProject.dir_path,
        text: projectText
      });
      fetchProjects();

      // Update local state without losing focus ideally
      setSelectedProject(prev => prev ? { ...prev, text: projectText } : null);

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
      if (isTextOnly) {
        await invoke('save_text_only', {
          projectDir: project.dir_path,
          text: text
        });
      } else {
        await invoke('save_capture_text', {
          projectDir: project.dir_path,
          imagePath: imagePath,
          text: text
        });
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

    return () => {
      unlistenDir.then(f => f());
      // Cleanup ObjectURLs
      Object.values(images).forEach(url => URL.revokeObjectURL(url));
    }
  }, []); // Note: leaving images out of deps to avoid retrigger on image load

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
            <X size={16} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={() => {
              emitTo('main', 'history-menu-closed');
              getCurrentWindow().hide();
            }} />
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
                  <div style={{ position: 'absolute', top: '8px', right: '8px', display: 'flex', gap: '6px' }}>
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

  return <MainApp />;
}

export default App;
