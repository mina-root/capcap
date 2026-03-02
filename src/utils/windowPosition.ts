import { currentMonitor, Window } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';

export async function setPopupPosition(
    winOrigin: Window,
    popupWin: Window,
    direction: 'up' | 'down',
    upOffsetBase: number,
    downOffsetBase: number,
    fixedPopupWidthLocal?: number
) {
    const monitor = await currentMonitor();
    const sf = monitor ? monitor.scaleFactor : 1;
    const pos = await winOrigin.outerPosition();
    const outerSize = await winOrigin.outerSize();

    let pWidthPhysical: number;
    if (fixedPopupWidthLocal) {
        pWidthPhysical = Math.round(fixedPopupWidthLocal * sf);
    } else {
        const pSize = await popupWin.outerSize();
        pWidthPhysical = pSize.width;
    }

    const offsetXPhysical = Math.round((outerSize.width - pWidthPhysical) / 2);

    if (direction === 'up') {
        await popupWin.setPosition(
            new PhysicalPosition(pos.x + offsetXPhysical, pos.y - Math.round(upOffsetBase * sf))
        );
    } else {
        await popupWin.setPosition(
            new PhysicalPosition(pos.x + offsetXPhysical, pos.y + Math.round(downOffsetBase * sf))
        );
    }
}

export async function getDirectionRelativeToMonitor(winOrigin: Window): Promise<'up' | 'down'> {
    const monitor = await currentMonitor();
    if (!monitor) return 'up';
    const pos = await winOrigin.outerPosition();
    // Assume if dock is in top half of screen, popups go down
    if (pos.y < monitor.size.height / 2) return 'down';
    return 'up';
}
