import { useState, useEffect, useRef } from 'react';
import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X, RefreshCw, Camera, Plus, Check, FileText, ScrollText, FileEdit, Trash2, Edit2, Save } from 'lucide-react';
import { getCurrentWindow, currentMonitor, getAllWindows } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { documentDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import './index.css';

import discordIcon from './assets/Discord-Symbol-Blurple.svg';
import notionIcon from './assets/notion-logo.svg';

import {
  STORAGE_KEYS,
  POPUP_SIZES,
  MENU_OFFSETS,
  EVENT_NAMES
} from './constants';
import { setPopupPosition, getDirectionRelativeToMonitor } from './utils/windowPosition';
import { useLanguage } from './i18n';

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
  notion_page_id?: string;
}

// ─── MAIN DOCK ───────────────────────────────────────────────────────────────
function MainApp() {
  const { t } = useLanguage();
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
  const previewTextRef = useRef("");

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
    const docDir = await documentDir();
    return await join(docDir, 'CapCap');
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

      const unlistenPreviewText = await listen<string>('preview-text-changed', (event) => {
        previewTextRef.current = event.payload;
      });

      const unlistenPreviewClosed = await listen('preview-closed', () => {
        previewTextRef.current = "";
      });

      return () => {
        unlistenSelected();
        unlistenClose();
        unlistenMove();
        unlistenPreviewText();
        unlistenPreviewClosed();
      };
    };

    const cleanupPromise = setupListeners();
    return () => {
      cleanupPromise.then(cleanup => cleanup());
    };
  }, []); // 依存関係なしで一度だけ実行

  // ─ Prevent Default Browser Shortcuts (like Print for Ctrl+P) ─
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Prevent Print dialog that freezes Tauri app
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'p')) {
        e.preventDefault();
        // Option: toggleProjectMenu();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
        if (previewTextRef.current.trim() === "") {
          // If no text, close preview automatically and allow next action
          await emit('capture-preview-cancel');
          await popupWin.hide();
          previewTextRef.current = "";
          return false;
        }
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
        const direction = await getDirectionRelativeToMonitor(win);
        await emit(EVENT_NAMES.WINDOW_SELECT_DIRECTION, direction);

        await setPopupPosition(
          win,
          popupWin,
          direction,
          MENU_OFFSETS.WINDOW_SELECT.up,
          MENU_OFFSETS.WINDOW_SELECT.down
        );

        await popupWin.show();
        await popupWin.setFocus();
        setIsWindowMenuOpen(true);

        // Close others concurrently without blocking
        if (isProjectMenuOpen) toggleProjectMenu();
        if (isHistoryMenuOpen) toggleHistoryMenu();
        if (isSettingsMenuOpen) toggleSettingsMenu();
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
        const direction = await getDirectionRelativeToMonitor(win);
        await emit(EVENT_NAMES.PROJECT_MENU_DIRECTION, direction);

        await setPopupPosition(
          win,
          popupWin,
          direction,
          MENU_OFFSETS.PROJECT_MENU.up,
          MENU_OFFSETS.PROJECT_MENU.down
        );

        await popupWin.show();
        await popupWin.setFocus();
        setIsProjectMenuOpen(true);

        // Close others concurrently without blocking
        if (isWindowMenuOpen) toggleWindowMenu();
        if (isHistoryMenuOpen) toggleHistoryMenu();
        if (isSettingsMenuOpen) toggleSettingsMenu();
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
        const direction = await getDirectionRelativeToMonitor(win);
        await emit(EVENT_NAMES.HISTORY_MENU_DIRECTION, { direction, project: activeProject });

        await setPopupPosition(
          win,
          popupWin,
          direction,
          MENU_OFFSETS.HISTORY_MENU.up,
          MENU_OFFSETS.HISTORY_MENU.down
        );

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
        const direction = await getDirectionRelativeToMonitor(win);
        await emit(EVENT_NAMES.SETTINGS_MENU_DIRECTION, direction);

        await setPopupPosition(
          win,
          popupWin,
          direction,
          MENU_OFFSETS.SETTINGS_MENU.up,
          MENU_OFFSETS.SETTINGS_MENU.down
        );

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
      if (await checkCapturePreviewOpen()) return;

      // Close all other menu popups
      if (isWindowMenuOpen) toggleWindowMenu();
      if (isProjectMenuOpen) toggleProjectMenu();
      if (isHistoryMenuOpen) toggleHistoryMenu();
      if (isSettingsMenuOpen) toggleSettingsMenu();

      const win = getCurrentWindow();
      const popupWin = (await getAllWindows()).find(w => w.label === 'capture-preview');
      if (popupWin) {
        const direction = await getDirectionRelativeToMonitor(win);

        // パスを空にして「テキストのみ」モードとして開かせる
        await emit(EVENT_NAMES.SHOW_CAPTURE_PREVIEW, { path: '', direction, project: activeProject });

        await popupWin.setSize(new LogicalSize(POPUP_SIZES.TEXT_ONLY.width, POPUP_SIZES.TEXT_ONLY.height));

        await setPopupPosition(
          win,
          popupWin,
          direction,
          POPUP_SIZES.TEXT_ONLY.height + 20,
          MENU_OFFSETS.WINDOW_SELECT.down,
          POPUP_SIZES.TEXT_ONLY.width
        );

        await popupWin.show();
        await popupWin.setFocus();
        setIsWindowMenuOpen(false);
        setIsProjectMenuOpen(false);
        setIsHistoryMenuOpen(false);
        setIsSettingsMenuOpen(false);
      }
    } catch (err) {
      console.error("Failed to open text-only capture preview", err);
    }
  };

  const handleActiveProjectEvent = async (p: ProjectInfo) => {
    setActiveProject(p);
  };

  useEffect(() => {
    const unlistenProj = listen<ProjectInfo>(EVENT_NAMES.PROJECT_SELECTED, (e) => {
      handleActiveProjectEvent(e.payload);
      setIsProjectMenuOpen(false);
    });

    const unlistenCloseProj = listen(EVENT_NAMES.PROJECT_MENU_CLOSED, () => {
      setIsProjectMenuOpen(false);
    });

    const unlistenCloseHist = listen(EVENT_NAMES.HISTORY_MENU_CLOSED, () => {
      setIsHistoryMenuOpen(false);
    });

    const unlistenCloseSet = listen(EVENT_NAMES.SETTINGS_MENU_CLOSED, () => {
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
    if (await checkCapturePreviewOpen()) return;

    // Close all other menu popups
    if (isWindowMenuOpen) toggleWindowMenu();
    if (isProjectMenuOpen) toggleProjectMenu();
    if (isHistoryMenuOpen) toggleHistoryMenu();
    if (isSettingsMenuOpen) toggleSettingsMenu();

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
        const direction = await getDirectionRelativeToMonitor(win);

        await popupWin.setSize(new LogicalSize(POPUP_SIZES.CAPTURE_PREVIEW.width, POPUP_SIZES.CAPTURE_PREVIEW.height));

        await setPopupPosition(
          win,
          popupWin,
          direction,
          POPUP_SIZES.CAPTURE_PREVIEW.height + 20,
          MENU_OFFSETS.WINDOW_SELECT.down,
          POPUP_SIZES.CAPTURE_PREVIEW.width
        );

        setIsWindowMenuOpen(false);
        setIsProjectMenuOpen(false);
        setIsHistoryMenuOpen(false);
        setIsSettingsMenuOpen(false);

        await popupWin.show();
        await popupWin.setFocus();
        await emit(EVENT_NAMES.SHOW_CAPTURE_PREVIEW, { path: savedPath, direction, project: activeProject });
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
    ? `${t('save')}: ${lastCapturePath}`
    : captureError
      ? `Error: ${captureError}`
      : t('captureTooltip');

  const captureColor = captureError ? '#f87171' : lastCapturePath ? '#4ade80' : '#4ade80';

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="liquidGlass-wrapper dock">
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text dock">
          <div className="dock-item" title={t('dragToMove')} style={{ cursor: 'grab' }} onPointerDown={(e) => {
            if (e.button === 0) getCurrentWindow().startDragging();
          }}>
            <GripHorizontal />
          </div>

          <div className="dock-item" title={activeProject ? `${t('projectsTooltip')}: ${activeProject.name}` : t('projectsTooltip')} onClick={toggleProjectMenu} style={{
            background: isProjectMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            color: activeProject ? '#a78bfa' : 'inherit'
          }}>
            <FolderKanban />
          </div>

          <div className="dock-item" title={selectedWindow ? `${t('selectWindowTooltip')}: ${selectedWindow.title}` : t('selectWindowTooltip')} onClick={toggleWindowMenu} style={{
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

          <div className="dock-item" title={t('textNoteTooltip')} onClick={handleTextOnly} style={{
            opacity: activeProject ? 1 : 0.3,
            cursor: activeProject ? 'pointer' : 'not-allowed'
          }}>
            <FileEdit />
          </div>

          <div className="dock-item" title={t('historyTooltip')} onClick={toggleHistoryMenu} style={{
            background: isHistoryMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
            opacity: activeProject ? 1 : 0.3,
            cursor: activeProject ? 'pointer' : 'not-allowed'
          }}>
            <ScrollText />
          </div>

          <div className="dock-item" title={t('settingsTooltip')} onClick={toggleSettingsMenu} style={{
            background: isSettingsMenuOpen ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
          }}>
            <Settings />
          </div>

          <div className="dock-item" title={t('closeAppTooltip')} onClick={handleClose}>
            <X color="#f87171" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── POPUP WINDOW ────────────────────────────────────────────────────────────
function WindowSelectPopup() {
  const { t } = useLanguage();
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
            <span style={{ fontSize: '0.9rem', fontWeight: 600, opacity: 0.9 }}>{t('captureTarget')}</span>
            <div
              style={{ cursor: 'pointer', padding: '6px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', transition: 'transform 0.2s' }}
              title={t('refreshTooltip')}
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
              onClick={() => handleSelectWindow({ hwnd: 0, title: t('autoActiveWindow') })}
            >
              <span className="window-item-title">
                {t('autoActiveWindowFull')}
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
  const { t } = useLanguage();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [newProjectName, setNewProjectName] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectText, setProjectText] = useState('');
  const [discordThreadId, setDiscordThreadId] = useState('');
  const [notionPageId, setNotionPageId] = useState('');
  const [isSavingText, setIsSavingText] = useState(false);

  const getProjectsRoot = async () => {
    const saved = localStorage.getItem('projectsRoot');
    if (saved) return saved;
    const docDir = await documentDir();
    return await join(docDir, 'CapCap');
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
    setNotionPageId(p.notion_page_id || '');
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
      const updatedInfo = { ...selectedProject, text: projectText, discord_thread_id: discordThreadId, notion_page_id: notionPageId };
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
              <span style={{ fontSize: '0.9rem', fontWeight: 600, opacity: 0.9 }}>{t('projectsTitle')}</span>
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
                  placeholder={t('newProjectNamePlaceholder')}
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
                    {t('apply')}
                  </button>
                </div>

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.8 }}>
                    <FileText size={14} />
                    <span style={{ fontSize: '0.8rem' }}>{t('notes')}</span>
                    {isSavingText && <span style={{ fontSize: '0.7rem', color: '#4ade80' }}>{t('saving')}</span>}
                  </div>
                  <textarea
                    className="project-textarea window-list-scroll"
                    value={projectText}
                    onChange={(e) => setProjectText(e.target.value)}
                    onBlur={handleUpdateText}
                    placeholder="Add texts, links, and context here. They will be saved to your project folder."
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                    <span style={{ fontSize: '0.8rem', opacity: 0.8, whiteSpace: 'nowrap' }}>{t('discordThreadId')}:</span>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                    <span style={{ fontSize: '0.8rem', opacity: 0.8, whiteSpace: 'nowrap' }}>{t('notionPageId')}:</span>
                    <input
                      type="text"
                      className="project-input"
                      value={notionPageId}
                      onChange={(e) => setNotionPageId(e.target.value)}
                      onBlur={handleUpdateText}
                      placeholder="Optional"
                      style={{ flex: 1, height: '30px', fontSize: '0.85rem' }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.5, fontSize: '0.9rem' }}>
                {t('projectsTitle')}
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
  const { t } = useLanguage();
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [isBlinking, setIsBlinking] = useState(false);
  const maxChars = 2000;

  useEffect(() => {
    emit('preview-text-changed', text);
  }, [text]);

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

    const unlistenCancel = listen('capture-preview-cancel', () => {
      handleSkip();
    });

    return () => {
      unlisten.then(f => f());
      unlistenBlink.then(f => f());
      unlistenCancel.then(f => f());
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
      const discordAutoPost = localStorage.getItem('discordAutoPost') === 'true';
      const notionAutoPost = localStorage.getItem('notionAutoPost') === 'true';

      const webhookUrl = localStorage.getItem('discordWebhookUrl');
      const notionToken = localStorage.getItem('notionApiToken');

      if (discordAutoPost) {
        if (webhookUrl) {
          try {
            const messageId: string = await invoke('post_to_discord', {
              webhookUrl,
              text: text,
              imagePath: imagePath || '',
              threadId: project.discord_thread_id || null
            });

            if (savedJsonPath) {
              await invoke('mark_discord_posted', {
                jsonPath: savedJsonPath,
                messageId: messageId || null
              });
            }
          } catch (postErr) {
            console.error("Failed to auto-post to Discord:", postErr);
          }
        }
      }

      if (notionAutoPost) {
        if (notionToken && project.notion_page_id) {
          try {
            const blockId: string = await invoke('post_to_notion', {
              notionApiToken: notionToken,
              pageId: project.notion_page_id,
              text: text,
              imagePath: imagePath || ''
            });

            if (savedJsonPath) {
              await invoke('mark_notion_posted', {
                jsonPath: savedJsonPath,
                blockId: blockId || null
              });
            }
            console.log("Notion auto-post successful:", blockId);
          } catch (notionErr) {
            console.error("Failed to auto-post to Notion:", notionErr);
            alert(`Notion Auto-post Error: ${notionErr}`);
          }
        } else {
          console.log("Notion auto-post skipped: Missing token or pageId", { hasToken: !!notionToken, pageId: project.notion_page_id });
        }
      }

      setText('');
      await emit('preview-closed');
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
    setText('');
    await emit('preview-closed');
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
              <span style={{ fontSize: '1rem', fontWeight: 600 }}>{isTextOnly ? t('textNote') : t('capturePreview')}</span>
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
                <span style={{ fontSize: '0.85rem' }}>{isTextOnly ? t('addTextNote') : t('addContext')}</span>
              </div>
              <textarea
                autoFocus
                className="project-textarea window-list-scroll"
                style={{ flex: 1, resize: 'none', fontSize: '0.9rem' }}
                placeholder={isTextOnly ? t('notePlaceholder') : t('contextPlaceholder')}
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
                    {isSaving ? t('saving') : t('saveAndClose')}
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
  discord_message_id?: string;
  notion_posted?: boolean;
  notion_block_id?: string;
}

// ─── HISTORY ITEM ROW (Lazy Image Loading) ───────────────────────────────────
interface HistoryItemRowProps {
  item: HistoryItem;
  isEditing: boolean;
  editingText: string;
  isSavingEdit: boolean;
  onStartEdit: (item: HistoryItem) => void;
  onSaveEdit: (item: HistoryItem) => void;
  onCancelEdit: () => void;
  onDelete: (item: HistoryItem) => void;
  onEditingTextChange: (text: string) => void;
  postedStatusLabel: string;
  editTooltip: string;
  deleteTooltip: string;
}

function HistoryItemRow({
  item, isEditing, editingText, isSavingEdit,
  onStartEdit, onSaveEdit, onCancelEdit, onDelete, onEditingTextChange,
  postedStatusLabel, editTooltip, deleteTooltip
}: HistoryItemRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const loadedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!item.image_path) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadedUrlRef.current && !isLoading) {
          setIsLoading(true);
          invoke<number[]>('read_file_bytes', { path: item.image_path })
            .then(bytes => {
              const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
              const url = URL.createObjectURL(blob);
              loadedUrlRef.current = url;
              setImgSrc(url);
              setIsLoading(false);
            })
            .catch(e => {
              console.error('Failed to lazy-load history image:', e);
              setIsLoading(false);
            });
          // Once triggered, no need to observe further
          observer.disconnect();
        }
      },
      { threshold: 0.05 }
    );

    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      // Release ObjectURL when the row is unmounted (e.g. after delete / refresh)
      if (loadedUrlRef.current) {
        URL.revokeObjectURL(loadedUrlRef.current);
        loadedUrlRef.current = null;
      }
    };
  }, [item.image_path]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex', flexWrap: 'wrap', gap: '12px', padding: '15px',
        background: 'rgba(20, 20, 20, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '10px', position: 'relative',
        boxShadow: '0 4px 6px rgba(0,0,0,0.3)'
      }}
    >
      {/* Action buttons */}
      <div style={{ position: 'absolute', top: '8px', right: '8px', display: 'flex', gap: '6px', alignItems: 'center' }}>
        {item.notion_posted && !isEditing && (
          <div title={postedStatusLabel} style={{ display: 'flex', alignItems: 'center' }}>
            <img src={notionIcon} style={{ width: '16px', height: '16px' }} alt="Notion" />
          </div>
        )}
        {item.discord_posted && !isEditing && (
          <div title={postedStatusLabel} style={{ display: 'flex', alignItems: 'center', marginRight: '4px' }}>
            <img src={discordIcon} style={{ width: '16px', height: '16px' }} alt="Discord" />
          </div>
        )}
        {isEditing ? null : (
          <>
            <button
              style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: '4px' }}
              title={editTooltip}
              onClick={() => onStartEdit(item)}
            >
              <Edit2 size={14} />
            </button>
            <button
              style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', padding: '4px' }}
              title={deleteTooltip}
              onClick={() => onDelete(item)}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>

      {/* Lazy-loaded image */}
      {item.image_path && (
        <div style={{
          width: '200px', minHeight: '80px', background: 'rgba(0,0,0,0.3)',
          borderRadius: '4px', overflow: 'hidden',
          display: 'flex', justifyContent: 'center', alignItems: 'center'
        }}>
          {imgSrc ? (
            <img src={imgSrc} style={{ width: '100%', objectFit: 'contain' }} />
          ) : (
            <span style={{ opacity: 0.5, padding: '20px', fontSize: '0.8rem' }}>
              {isLoading ? 'Loading...' : '...'}
            </span>
          )}
        </div>
      )}

      {/* Text / edit area */}
      <div style={{ flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '4px', marginRight: '40px' }}>
        <div style={{ fontSize: '0.75rem', opacity: 0.5 }}>
          {new Date(item.timestamp).toLocaleString()}{!item.image_path ? ' (Text Only)' : ''}
        </div>
        {isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
            <textarea
              className="project-textarea"
              autoFocus
              style={{ minHeight: '80px', fontSize: '0.85rem' }}
              value={editingText}
              onChange={e => onEditingTextChange(e.target.value)}
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="project-btn apply" onClick={() => onSaveEdit(item)} disabled={isSavingEdit}>
                <Save size={14} style={{ marginRight: '4px' }} /> Save
              </button>
              <button className="project-btn add" onClick={onCancelEdit} disabled={isSavingEdit}>
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
}

// ─── HISTORY MENU POPUP ──────────────────────────────────────────────────────
function HistoryMenuPopup() {
  const { t } = useLanguage();
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [project, setProject] = useState<ProjectInfo | null>(null);
  // Removed: images state (was causing all images to be Eager Loaded into memory)

  // Edit / Delete State
  const [editingItemPath, setEditingItemPath] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isBatchPosting, setIsBatchPosting] = useState(false);

  // Keep a stable ref to project for use inside event handlers
  const projectRef = useRef<ProjectInfo | null>(null);
  projectRef.current = project;

  const loadHistory = async (proj: ProjectInfo) => {
    try {
      // Only fetch metadata (JSON). Images are loaded on-demand per row.
      const items: HistoryItem[] = await invoke('get_project_captures', { projectDir: proj.dir_path });
      setHistoryItems(items);
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
      const proj = projectRef.current;
      if (proj) loadHistory(proj);
    });

    return () => {
      unlistenDir.then(f => f());
      unlistenRefresh.then(f => f());
      // Note: individual ObjectURLs are released by each HistoryItemRow on unmount
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once; project access via projectRef to avoid stale closure

  const handleDelete = async (item: HistoryItem) => {
    if (!projectRef.current) return;
    try {
      if (item.discord_posted && item.discord_message_id) {
        const webhookUrl = localStorage.getItem('discordWebhookUrl');
        if (webhookUrl) {
          try {
            await invoke('delete_discord_message', {
              webhookUrl,
              messageId: item.discord_message_id,
              threadId: projectRef.current.discord_thread_id || null
            });
          } catch (discordErr) {
            console.error("Failed to delete Discord message", discordErr);
          }
        }
      }
      if (item.notion_posted && item.notion_block_id) {
        const notionToken = localStorage.getItem('notionApiToken');
        if (notionToken) {
          try {
            await invoke('delete_notion_block', {
              notionApiToken: notionToken,
              blockId: item.notion_block_id
            });
          } catch (notionErr) {
            console.error("Failed to delete Notion block", notionErr);
          }
        }
      }
      await invoke('delete_capture_item', { imagePath: item.image_path, jsonPath: item.json_path });
      loadHistory(projectRef.current);
    } catch (e) {
      console.error("Failed to delete", e);
    }
  };

  const handleStartEdit = (item: HistoryItem) => {
    setEditingItemPath(item.json_path);
    setEditingText(item.text);
  };

  const handleSaveEdit = async (item: HistoryItem) => {
    if (!projectRef.current) return;
    setIsSavingEdit(true);
    try {
      if (item.discord_posted && item.discord_message_id) {
        const webhookUrl = localStorage.getItem('discordWebhookUrl');
        if (webhookUrl) {
          try {
            await invoke('edit_discord_message', {
              webhookUrl,
              messageId: item.discord_message_id,
              text: editingText,
              threadId: projectRef.current.discord_thread_id || null
            });
          } catch (discordErr) {
            console.error("Failed to sync edit with Discord", discordErr);
          }
        }
      }

      if (item.notion_posted && item.notion_block_id) {
        const notionToken = localStorage.getItem('notionApiToken');
        if (notionToken) {
          try {
            await invoke('edit_notion_block', {
              notionApiToken: notionToken,
              blockId: item.notion_block_id,
              text: editingText
            });
          } catch (notionErr) {
            console.error("Failed to sync edit with Notion", notionErr);
          }
        }
      }
      await invoke('update_capture_text', { jsonPath: item.json_path, newText: editingText });
      setEditingItemPath(null);
      loadHistory(projectRef.current);
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
    if (!projectRef.current) return;
    const proj = projectRef.current;
    const webhookUrl = localStorage.getItem('discordWebhookUrl');
    if (!webhookUrl) {
      alert(t('discordWebhookUrl'));
      return;
    }

    const unpostedItems = historyItems.filter(i => !i.discord_posted);
    if (unpostedItems.length === 0) return;

    setIsBatchPosting(true);
    try {
      // Items are sorted newest first, so we loop backwards to send oldest first
      for (let i = unpostedItems.length - 1; i >= 0; i--) {
        const item = unpostedItems[i];
        const messageId: string = await invoke('post_to_discord', {
          webhookUrl,
          text: item.text || '',
          imagePath: item.image_path || '',
          threadId: proj.discord_thread_id || null
        });
        await invoke('mark_discord_posted', {
          jsonPath: item.json_path,
          messageId: messageId || null
        });

        if (i !== 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      await loadHistory(proj);
    } catch (e) {
      console.error("Batch post failed:", e);
      alert(`Batch post error: ${e}`);
    } finally {
      setIsBatchPosting(false);
    }
  };

  const handleBatchPostNotion = async () => {
    console.log("handleBatchPostNotion started");
    if (!projectRef.current) {
      console.log("No active project");
      return;
    }
    const proj = projectRef.current;
    const notionToken = localStorage.getItem('notionApiToken');
    if (!notionToken || !proj.notion_page_id) {
      const msg = `Notion Configuration Missing: Token=${!!notionToken}, PageID=${proj.notion_page_id}`;
      console.error(msg);
      alert(msg);
      return;
    }

    const unpostedItems = historyItems.filter(i => !i.notion_posted);
    console.log(`Unposted Notion items count: ${unpostedItems.length}`);
    if (unpostedItems.length === 0) {
      alert("No new items to post to Notion.");
      return;
    }

    setIsBatchPosting(true);
    try {
      for (let i = unpostedItems.length - 1; i >= 0; i--) {
        const item = unpostedItems[i];
        console.log(`Posting item to Notion: ${item.image_name || 'text-only'}`);
        const blockId: string = await invoke('post_to_notion', {
          notionApiToken: notionToken,
          pageId: proj.notion_page_id,
          text: item.text || '',
          imagePath: item.image_path || ''
        });
        console.log(`Post success, blockId: ${blockId}. Marking as posted...`);
        await invoke('mark_notion_posted', {
          jsonPath: item.json_path,
          blockId: blockId || null
        });

        if (i !== 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      await loadHistory(proj);
    } catch (e) {
      console.error("Batch post to Notion failed:", e);
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
              {project ? `${t('historyTitle')}: ${project.name}` : t('historyTitle')}
            </span>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {project && historyItems.some(i => !i.notion_posted) && (
                <button
                  className="project-btn apply"
                  onClick={handleBatchPostNotion}
                  disabled={isBatchPosting}
                  style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(255,255,255,0.08)', color: '#fff', display: 'flex', alignItems: 'center', border: '1px solid rgba(255,255,255,0.1)' }}
                  title={t('batchPostNotionDesc')}
                >
                  <img src={notionIcon} style={{ width: '14px', height: '14px', marginRight: '6px' }} alt="Notion" />
                  {isBatchPosting ? t('posting') : t('batchPostNotion')}
                </button>
              )}
              {project && historyItems.some(i => !i.discord_posted) && (
                <button
                  className="project-btn apply"
                  onClick={handleBatchPost}
                  disabled={isBatchPosting}
                  style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center' }}
                >
                  <img src={discordIcon} style={{ width: '14px', height: '14px', marginRight: '6px', filter: 'brightness(10)' }} alt="Discord" />
                  {isBatchPosting ? t('posting') : t('batchPost')}
                </button>
              )}
              <X size={16} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={() => {
                emitTo('main', 'history-menu-closed');
                getCurrentWindow().hide();
              }} />
            </div>
          </div>

          <div
            style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px', paddingRight: '4px' }}
            className="window-list-scroll"
          >
            {!project && (
              <div style={{ opacity: 0.5, textAlign: 'center', marginTop: '20px' }}>{t('projectsTitle')}</div>
            )}
            {project && historyItems.length === 0 && (
              <div style={{ opacity: 0.5, textAlign: 'center', marginTop: '20px' }}>{t('noHistory')}</div>
            )}
            {historyItems.map((item) => (
              <HistoryItemRow
                key={item.json_path}
                item={item}
                isEditing={editingItemPath === item.json_path}
                editingText={editingText}
                isSavingEdit={isSavingEdit}
                onStartEdit={handleStartEdit}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
                onDelete={handleDelete}
                onEditingTextChange={setEditingText}
                postedStatusLabel={t('postedStatus')}
                editTooltip={t('editTooltip')}
                deleteTooltip={t('deleteTooltip')}
              />
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
  const { lang, changeLanguage, t } = useLanguage();
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [discordAutoPost, setDiscordAutoPost] = useState(false);
  const [notionAutoPost, setNotionAutoPost] = useState(false);
  const [notionApiToken, setNotionApiToken] = useState('');
  const [projectsRoot, setProjectsRoot] = useState('');

  useEffect(() => {
    const unlistenDir = listen<'up' | 'down'>('settings-menu-direction', (e) => {
      setDirection(e.payload);
    });

    // Load from localStorage
    const savedUrl = localStorage.getItem('discordWebhookUrl');
    if (savedUrl) setWebhookUrl(savedUrl);

    const savedToken = localStorage.getItem('notionApiToken');
    if (savedToken) setNotionApiToken(savedToken);

    const savedDiscordAuto = localStorage.getItem('discordAutoPost');
    if (savedDiscordAuto) setDiscordAutoPost(savedDiscordAuto === 'true');

    const savedNotionAuto = localStorage.getItem('notionAutoPost');
    if (savedNotionAuto) setNotionAutoPost(savedNotionAuto === 'true');

    const loadProjectsRoot = async () => {
      const savedRoot = localStorage.getItem(STORAGE_KEYS.PROJECTS_ROOT);
      if (savedRoot) {
        setProjectsRoot(savedRoot);
      } else {
        const docDir = await documentDir();
        setProjectsRoot(await join(docDir, 'CapCap'));
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
    localStorage.setItem('notionApiToken', notionApiToken);
    localStorage.setItem('discordAutoPost', discordAutoPost ? 'true' : 'false');
    localStorage.setItem('notionAutoPost', notionAutoPost ? 'true' : 'false');
    localStorage.setItem(STORAGE_KEYS.PROJECTS_ROOT, projectsRoot);
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
            <span style={{ fontSize: '1rem', fontWeight: 600 }}>{t('settingsTitle')}</span>
            <X size={16} style={{ cursor: 'pointer', opacity: 0.7 }} onClick={handleClose} />
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.9 }}>{t('projectFilesFolder')}</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  className="project-input"
                  placeholder={t('selectFolderPlaceholder')}
                  value={projectsRoot}
                  readOnly
                  style={{ flex: 1, fontSize: '0.8rem', opacity: 0.8 }}
                />
                <button
                  className="project-btn apply"
                  onClick={handlePickProjectsRoot}
                  style={{ whiteSpace: 'nowrap', padding: '0 12px' }}
                >
                  {t('browse')}
                </button>
              </div>
              <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                {t('projectFilesFolderDesc')}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.9 }}>{t('discordWebhookUrl')}</label>
              <input
                type="text"
                className="project-input"
                placeholder="https://discord.com/api/webhooks/..."
                value={webhookUrl}
                onChange={e => setWebhookUrl(e.target.value)}
              />
              <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                {t('discordWebhookUrlDesc')}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.9 }}>{t('notionApiToken')}</label>
              <input
                type="password"
                className="project-input"
                placeholder="secret_..."
                value={notionApiToken}
                onChange={e => setNotionApiToken(e.target.value)}
              />
              <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                {t('notionApiTokenDesc')}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  id="discordAutoPost"
                  checked={discordAutoPost}
                  onChange={e => setDiscordAutoPost(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <img src={discordIcon} style={{ width: '16px', height: '16px' }} alt="Discord" />
                <label htmlFor="discordAutoPost" style={{ fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer' }}>
                  {t('enableDiscordAutoPost')}
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  id="notionAutoPost"
                  checked={notionAutoPost}
                  onChange={e => setNotionAutoPost(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <img src={notionIcon} style={{ width: '16px', height: '16px' }} alt="Notion" />
                <label htmlFor="notionAutoPost" style={{ fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer' }}>
                  {t('enableNotionAutoPost')}
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, opacity: 0.9 }}>{t('uiLanguage')}</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className={`project-btn ${lang === 'ja' ? 'apply' : 'add'}`}
                  onClick={() => changeLanguage('ja')}
                  style={{ flex: 1 }}
                >
                  {t('langJa')}
                </button>
                <button
                  className={`project-btn ${lang === 'en' ? 'apply' : 'add'}`}
                  onClick={() => changeLanguage('en')}
                  style={{ flex: 1 }}
                >
                  {t('langEn')}
                </button>
              </div>
            </div>

            <div style={{ flex: 1 }} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: 'auto' }}>
              <button className="project-btn add" onClick={handleClose}>{t('cancel')}</button>
              <button className="project-btn apply" onClick={handleSave}>{t('saveSettings')}</button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
