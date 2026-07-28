import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { GraphCanvasHandle } from "./GraphCanvas";

interface CardCanvasProps {
  ariaLabel: string;
  children: ReactNode;
  height: number;
  width: number;
}

export const CardCanvas = forwardRef<GraphCanvasHandle, CardCanvasProps>(
function CardCanvas({ ariaLabel, children, height, width }, ref) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const autoFitRef = useRef(true);
  const [scale, setScale] = useState(1);

  const applyScale = useCallback((nextScale: number) => {
    const shell = shellRef.current;
    if (!shell) return;
    setScale(nextScale);
    shell.scrollLeft = 0;
    shell.scrollTop = 0;
  }, []);

  const fit = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    applyScale(Math.min(1, Math.max(
      0.36,
      Math.min(
        (shell.clientWidth - 32) / width,
        (shell.clientHeight - 32) / height,
      ),
    )));
  }, [applyScale, height, width]);

  const fitWidth = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    applyScale(Math.min(1, Math.max(
      0.36,
      (shell.clientWidth - 32) / width,
    )));
  }, [applyScale, width]);

  useImperativeHandle(ref, () => ({
    fit: () => {
      autoFitRef.current = false;
      fit();
    },
    zoomIn: () => {
      autoFitRef.current = false;
      setScale((current) => Math.min(1.35, current * 1.15));
    },
    zoomOut: () => {
      autoFitRef.current = false;
      setScale((current) => Math.max(0.3, current / 1.15));
    },
  }), [fit]);

  useEffect(() => {
    autoFitRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      if (autoFitRef.current) fitWidth();
    });
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(() => {
      if (autoFitRef.current) fitWidth();
    });
    observer.observe(shell);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitWidth]);

  return (
    <div className="card-canvas-shell" ref={shellRef} aria-label={ariaLabel}>
      <div
        className="card-canvas-scaled"
        style={{ width: width * scale, height: height * scale }}
      >
        <div
          className="card-canvas-world"
          style={{
            width,
            height,
            transform: `scale(${scale})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
});
