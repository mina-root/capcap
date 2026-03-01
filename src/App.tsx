import { useState, useEffect, useRef } from 'react';
import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X, RefreshCw, Camera, Plus, Check, FileText } from 'lucide-react';
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
  const [selectedWindow, setSelectedWindow] = useState<WindowInfo | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);

  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCapturePath, setLastCapturePath] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const feedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWindowMenuOpenRef = useRef(false);
  const isProjectMenuOpenRef = useRef(false);

  useEffect(() => { isWindowMenuOpenRef.current = isWindowMenuOpen; }, [isWindowMenuOpen]);
  useEffect(() => { isProjectMenuOpenRef.current = isProjectMenuOpen; }, [isProjectMenuOpen]);

  const followPosition = async () => {
    const isWOpen = isWindowMenuOpenRef.current;
    const isPOpen = isProjectMenuOpenRef.current;
    if (!isWOpen && !isPOpen) return;

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
        if (isProjectMenuOpen) toggleProjectMenu();
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
        const mainWidth = 310;
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
        if (isWindowMenuOpen) toggleWindowMenu();
      } else {
        await popupWin.hide();
        setIsProjectMenuOpen(false);
      }
    } catch (error) {
      console.error("Failed to toggle project menu", error);
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

    const unlistenClose = listen('project-menu-closed', () => {
      setIsProjectMenuOpen(false);
    });

    return () => {
      unlistenProj.then(f => f());
      unlistenClose.then(f => f());
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

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────
function App() {
  const currentWin = getCurrentWindow();

  if (currentWin.label === 'window-select') {
    return <WindowSelectPopup />;
  }

  if (currentWin.label === 'project-menu') {
    return <ProjectMenuPopup />;
  }

  return <MainApp />;
}

export default App;
