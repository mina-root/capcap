export const STORAGE_KEYS = {
    PROJECTS_ROOT: 'projectsRoot',
    LANGUAGE: 'language',
};

export const POPUP_SIZES = {
    WINDOW_SELECT: { width: 360, height: 400 },
    PROJECT_MENU: { width: 420, height: 400 },
    HISTORY_MENU: { width: 520, height: 400 },
    SETTINGS_MENU: { width: 320, height: 400 },
    CAPTURE_PREVIEW: { width: 400, height: 550 },
    TEXT_ONLY: { width: 400, height: 300 },
};

export const MENU_OFFSETS = {
    WINDOW_SELECT: { up: 360, down: 70 },
    PROJECT_MENU: { up: 420, down: 70 },
    HISTORY_MENU: { up: 520, down: 70 },
    SETTINGS_MENU: { up: 320, down: 70 },
};

export const EVENT_NAMES = {
    WINDOW_SELECTED: 'window-selected',
    WINDOW_SELECT_CLOSED: 'window-select-closed',
    WINDOW_SELECT_DIRECTION: 'window-select-direction',

    PROJECT_SELECTED: 'project-selected',
    PROJECT_MENU_CLOSED: 'project-menu-closed',
    PROJECT_MENU_DIRECTION: 'project-menu-direction',

    HISTORY_MENU_CLOSED: 'history-menu-closed',
    HISTORY_MENU_DIRECTION: 'history-menu-direction',

    SETTINGS_MENU_CLOSED: 'settings-menu-closed',
    SETTINGS_MENU_DIRECTION: 'settings-menu-direction',

    SHOW_CAPTURE_PREVIEW: 'show-capture-preview',
    CAPTURE_PREVIEW_BLINK: 'capture-preview-blink',
};
