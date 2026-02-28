import { FolderKanban, GripHorizontal, Image as ImageIcon, Maximize, Settings, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './index.css';

function App() {
  const handleClose = async () => {
    try {
      const currentWindow = getCurrentWindow();
      await currentWindow.close();
    } catch (error) {
      console.error("Failed to close window:", error);
    }
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: '20px'
      }}
    >
      <div className="liquidGlass-wrapper dock">
        <div className="liquidGlass-effect"></div>
        <div className="liquidGlass-tint"></div>
        <div className="liquidGlass-shine"></div>

        <div className="liquidGlass-text dock">
          {/* Draggable handle for the dock */}
          <div
            className="dock-item"
            title="Drag to Move"
            onPointerDown={(e) => {
              if (e.button === 0) {
                getCurrentWindow().startDragging();
              }
            }}
            style={{ cursor: 'grab' }}
          >
            <GripHorizontal />
            <span>Move</span>
          </div>

          <div className="dock-item" title="Projects">
            <FolderKanban />
            <span>Projects</span>
          </div>

          <div className="dock-item" title="Select Target Window">
            <Maximize />
            <span>Window</span>
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

      <svg style={{ display: 'none' }}>
        <filter
          id="glass-distortion"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          filterUnits="objectBoundingBox"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.01 0.01"
            numOctaves="1"
            seed="5"
            result="turbulence"
          />

          <feComponentTransfer in="turbulence" result="mapped">
            <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
            <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
            <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
          </feComponentTransfer>

          <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />

          <feSpecularLighting
            in="softMap"
            surfaceScale="5"
            specularConstant="1"
            specularExponent="100"
            lightingColor="white"
            result="specLight"
          >
            <fePointLight x="-200" y="-200" z="300" />
          </feSpecularLighting>

          <feComposite
            in="specLight"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="1"
            k4="0"
            result="litImage"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="softMap"
            scale="150"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
    </div>
  );
}

export default App;
