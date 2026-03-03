import { useState, useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { STORAGE_KEYS } from './constants';

export type Language = 'en' | 'ja';

export const translations = {
    en: {
        // Main App
        dragToMove: "Drag to Move",
        projectsTooltip: "Projects",
        selectWindowTooltip: "Select Target Window",
        captureTooltip: "Capture Screenshot",
        textNoteTooltip: "Text Note",
        historyTooltip: "Project History",
        settingsTooltip: "Settings",
        closeAppTooltip: "Close App",

        // Window Select
        captureTarget: "Capture Target",
        autoActiveWindow: "Auto (Active Window)",
        autoActiveWindowFull: "Auto (Current Active Window)",
        refreshTooltip: "Refresh Window List",

        // Project Menu
        projectsTitle: "Projects",
        newProjectNamePlaceholder: "New Project Name",
        apply: "Apply",
        save: "Save",
        cancel: "Cancel",
        delete: "Delete",
        projectDetails: "Project Details",
        notes: "Notes",
        discordThreadId: "Discord Thread ID",
        notionPageId: "Notion Page ID",
        saving: "Saving...",

        // Capture Preview
        previewAndPost: "Preview & Post",
        title: "Title",
        textNoteLabel: "Text/Note",
        discard: "Discard",
        saveAndPost: "Save & Post",
        posting: "Posting...",
        textNote: "Text Note",
        capturePreview: "Capture Preview",
        addTextNote: "Add Text Note",
        addContext: "Add Context or Notes",
        notePlaceholder: "Enter your note here...",
        contextPlaceholder: "What's happening in this capture...",
        saveAndClose: "Save & Close",

        // History Menu
        historyTitle: "Project History",
        noHistory: "No history for this project yet.",
        batchPost: "Batch Post to Discord",
        batchPostDesc: "Post all unposted captures to Discord",
        deleteTooltip: "Delete",
        editTooltip: "Edit",
        saveTooltip: "Save",
        cancelTooltip: "Cancel",
        postToDiscordTooltip: "Post to Discord",
        postToNotionTooltip: "Post to Notion",
        batchPostNotion: "Batch Post to Notion",
        batchPostNotionDesc: "Post all unposted captures to Notion",
        postedStatus: "Posted",

        // Settings
        settingsTitle: "Settings",
        projectFilesFolder: "Project Files Folder",
        selectFolderPlaceholder: "Select folder...",
        browse: "Browse",
        projectFilesFolderDesc: "Select the base directory where projects and captures will be stored.",
        discordWebhookUrl: "Discord Webhook URL",
        discordWebhookUrlDesc: "Enter the webhook URL where captures should be posted. Include thread_id query parameters if you want to post to a specific thread.",
        notionApiToken: "Notion API Token",
        notionApiTokenDesc: "Enter your Notion API Integration Token.",
        enableAutoPost: "Enable Automatic Posting",
        saveSettings: "Save Settings",
        globalShortcut: "Capture Hotkey",
        globalShortcutDesc: "Global hotkey shortcut to capture screen (e.g. CommandOrControl+Shift+S)",
        recordingShortcut: "Press keys to record...",
        uiLanguage: "UI Language",
        langJa: "日本語",
        langEn: "English",
    },
    ja: {
        // Main App
        dragToMove: "ドラッグして移動",
        projectsTooltip: "プロジェクト",
        selectWindowTooltip: "ターゲットウィンドウ選択",
        captureTooltip: "スクリーンショット撮影",
        textNoteTooltip: "テキストノート",
        historyTooltip: "プロジェクト履歴",
        settingsTooltip: "設定",
        closeAppTooltip: "アプリを終了",

        // Window Select
        captureTarget: "キャプチャ対象",
        autoActiveWindow: "自動 (アクティブウィンドウ)",
        autoActiveWindowFull: "自動 (現在のアクティブウィンドウ)",
        refreshTooltip: "ウィンドウリストを更新",

        // Project Menu
        projectsTitle: "プロジェクト",
        newProjectNamePlaceholder: "新しいプロジェクト名",
        apply: "適用",
        save: "保存",
        cancel: "キャンセル",
        delete: "削除",
        projectDetails: "プロジェクト詳細",
        notes: "ノート",
        discordThreadId: "Discord スレッド ID",
        notionPageId: "Notion ページ ID",
        saving: "保存中...",

        // Capture Preview
        previewAndPost: "プレビュー & 投稿",
        title: "タイトル",
        textNoteLabel: "テキスト/ノート",
        discard: "破棄",
        saveAndPost: "保存 & 投稿",
        posting: "投稿中...",
        textNote: "テキストノート",
        capturePreview: "キャプチャプレビュー",
        addTextNote: "テキストノートを追加",
        addContext: "コンテキストまたはメモを追加",
        notePlaceholder: "ここにノートを入力してください...",
        contextPlaceholder: "このキャプチャで何が起きているか...",
        saveAndClose: "保存して閉じる",

        // History Menu
        historyTitle: "プロジェクト履歴",
        noHistory: "このプロジェクトの履歴はまだありません。",
        batchPost: "Discordに一括投稿",
        batchPostDesc: "未投稿のキャプチャをすべてDiscordに投稿します",
        deleteTooltip: "削除",
        editTooltip: "編集",
        saveTooltip: "保存",
        cancelTooltip: "キャンセル",
        postToDiscordTooltip: "Discordに投稿",
        postToNotionTooltip: "Notionに投稿",
        batchPostNotion: "Notionに一括投稿",
        batchPostNotionDesc: "未投稿のキャプチャをすべてNotionに投稿します",
        postedStatus: "投稿済み",

        // Settings
        settingsTitle: "設定",
        projectFilesFolder: "プロジェクト保存先フォルダー",
        selectFolderPlaceholder: "フォルダーを選択...",
        browse: "参照",
        projectFilesFolderDesc: "プロジェクトとキャプチャが保存されるベースディレクトリを選択してください。",
        discordWebhookUrl: "Discord Webhook URL",
        discordWebhookUrlDesc: "キャプチャを投稿するWebhook URLを入力してください。特定の形式のスレッドに投稿する場合はthread_idパラメータを含めてください。",
        notionApiToken: "Notion API トークン",
        notionApiTokenDesc: "Notion APIのインテグレーショントークンを入力してください。",
        enableAutoPost: "自動投稿を有効にする",
        saveSettings: "設定を保存",
        globalShortcut: "キャプチャショートカット",
        globalShortcutDesc: "画面キャプチャのグローバルショートカット (例: CommandOrControl+Shift+S)",
        recordingShortcut: "キーを入力してください...",
        uiLanguage: "UI言語",
        langJa: "日本語",
        langEn: "English",
    }
};

export const getLanguage = (): Language => {
    const saved = localStorage.getItem(STORAGE_KEYS.LANGUAGE) as Language;
    if (saved === 'en' || saved === 'ja') return saved;
    return 'ja'; // Default to Japanese
};

export const useLanguage = () => {
    const [lang, setLang] = useState<Language>(getLanguage());

    useEffect(() => {
        const unlisten = listen<Language>('language-updated', (event) => {
            setLang(event.payload);
        });
        return () => {
            unlisten.then(f => f());
        };
    }, []);

    const changeLanguage = async (newLang: Language) => {
        localStorage.setItem(STORAGE_KEYS.LANGUAGE, newLang);
        setLang(newLang);
        await emit('language-updated', newLang);
    };

    const t = (key: keyof typeof translations.en) => {
        return translations[lang][key] || translations['en'][key];
    };

    return { lang, changeLanguage, t };
};
