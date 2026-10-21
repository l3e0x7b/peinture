import React, { useState, useRef, useEffect, useCallback } from "react";
import { ChevronsLeftRight, Columns2 } from "lucide-react";

export type ComparisonLayout = "slider" | "side-by-side";

interface ImageComparisonProps {
  beforeImage: string;
  afterImage: string;
  alt: string;
  labelBefore?: string;
  labelAfter?: string;
  /** Controlled layout. Omit to let the component manage it internally. */
  layout?: ComparisonLayout;
  /** Initial layout when uncontrolled. Defaults to the original slider. */
  defaultLayout?: ComparisonLayout;
  onLayoutChange?: (layout: ComparisonLayout) => void;
  /** Hide the built-in toggle when the host renders its own control. */
  hideLayoutToggle?: boolean;
  /** Labels for the built-in toggle button. */
  sliderLabel?: string;
  sideBySideLabel?: string;
}

export const ImageComparison: React.FC<ImageComparisonProps> = ({
  beforeImage,
  afterImage,
  alt,
  labelBefore = "Original",
  labelAfter = "After",
  layout,
  defaultLayout = "slider",
  onLayoutChange,
  hideLayoutToggle = false,
  sliderLabel = "Slider",
  sideBySideLabel = "Side by side",
}) => {
  // ---- Layout mode (controlled / uncontrolled) ----
  const [internalLayout, setInternalLayout] =
    useState<ComparisonLayout>(defaultLayout);
  const activeLayout = layout ?? internalLayout;

  const setLayout = useCallback(
    (next: ComparisonLayout) => {
      if (layout === undefined) setInternalLayout(next);
      onLayoutChange?.(next);
    },
    [layout, onLayoutChange],
  );

  // ---- Slider interaction (only active in slider mode) ----
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMove = useCallback((clientX: number) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const newPos = Math.min(Math.max((x / rect.width) * 100, 0), 100);
      setPosition(newPos);
    }
  }, []);

  const onMouseDown = () => (isDragging.current = true);
  const onMouseUp = () => (isDragging.current = false);
  const onMouseMove = (e: React.MouseEvent) => {
    if (isDragging.current) handleMove(e.clientX);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    handleMove(e.touches[0].clientX);
  };

  useEffect(() => {
    // Only wire up the global listeners while the slider is actually rendered.
    if (activeLayout !== "slider") return;

    const handleGlobalMouseUp = () => (isDragging.current = false);
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isDragging.current) handleMove(e.clientX);
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    window.addEventListener("mousemove", handleGlobalMouseMove);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, [handleMove, activeLayout]);

  // Keyboard support for the slider handle: arrows nudge, Home/End jump to an edge.
  const onSliderKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPosition((p) => Math.max(p - step, 0));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPosition((p) => Math.min(p + step, 100));
    } else if (e.key === "Home") {
      e.preventDefault();
      setPosition(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPosition(100);
    }
  };

  const toggleButton = hideLayoutToggle ? null : (
    <button
      type="button"
      onClick={() =>
        setLayout(activeLayout === "slider" ? "side-by-side" : "slider")
      }
      aria-label={activeLayout === "slider" ? sideBySideLabel : sliderLabel}
      className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/15 text-white/80 hover:text-white hover:bg-white/10 text-[10px] uppercase tracking-wider font-bold transition-all active:scale-95"
    >
      {activeLayout === "slider" ? (
        <>
          <Columns2 className="w-3.5 h-3.5" />
          <span>{sideBySideLabel}</span>
        </>
      ) : (
        <>
          <ChevronsLeftRight className="w-3.5 h-3.5" />
          <span>{sliderLabel}</span>
        </>
      )}
    </button>
  );

  const labelChip = (text: string, accent: boolean) => (
    <div
      className={`absolute top-3 ${
        accent
          ? "right-3 bg-purple-600/90 text-white"
          : "left-3 bg-black/60 text-white/90"
      } backdrop-blur-md text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded border border-white/10 z-20 pointer-events-none`}
    >
      {text}
    </div>
  );

  // ---- Side-by-side layout ----
  // Stacks into one column below the md breakpoint, where two panes side by
  // side would be too narrow to compare.
  if (activeLayout === "side-by-side") {
    return (
      <div
        className="w-full h-full flex items-center justify-center select-none"
        // Keep clicks/drags from leaking through to the editor canvas underneath.
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="relative w-full h-full grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-3 p-2 md:p-3">
          {toggleButton}
          <figure className="relative min-h-0 flex items-center justify-center rounded-lg overflow-hidden bg-black/30 border border-white/10">
            {labelChip(labelBefore, false)}
            <img
              src={beforeImage}
              alt={`${alt} Before`}
              className="max-w-full max-h-full w-auto h-auto object-contain pointer-events-none"
              draggable={false}
            />
          </figure>
          <figure className="relative min-h-0 flex items-center justify-center rounded-lg overflow-hidden bg-black/30 border border-white/10">
            {labelChip(labelAfter, true)}
            <img
              src={afterImage}
              alt={`${alt} After`}
              className="max-w-full max-h-full w-auto h-auto object-contain pointer-events-none"
              draggable={false}
            />
          </figure>
        </div>
      </div>
    );
  }

  // ---- Slider layout (original behaviour) ----
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div
        className="relative inline-flex max-w-full max-h-full select-none overflow-hidden"
        style={{ touchAction: "none" }} // Prevents scrolling on mobile while sliding
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onTouchStart={onMouseDown}
        onTouchEnd={onMouseUp}
        onTouchMove={onTouchMove}
      >
        {/* 
           Layout Strategy:
           1. 'After' image (Upscaled) is the Base. It sets the dimensions of the container 
              naturally because it is relative/static. We constrain it with max-w/max-h.
           2. 'Before' image (Original) is Absolute Overlay. It sits on top.
           3. We clip the 'Before' image from the right side.
        */}

        {/* Base Layer: Upscaled Image (Visible on the Right) */}
        <img
          src={afterImage}
          alt={`${alt} After`}
          className="block max-w-full max-h-full w-auto h-auto object-contain pointer-events-none"
          draggable={false}
        />

        {/* Overlay Layer: Original Image (Visible on the Left) */}
        <div
          className="absolute inset-0 w-full h-full overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          <img
            src={beforeImage}
            alt={`${alt} Before`}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            draggable={false}
          />
        </div>

        {/* Slider Handle */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Comparison position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(position)}
          onKeyDown={onSliderKeyDown}
          className="absolute top-0 bottom-0 w-0.5 bg-white/60 cursor-ew-resize z-20 group outline-none focus-visible:bg-purple-400"
          style={{ left: `${position}%` }}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-black/50 backdrop-blur-md border border-white/50 rounded-full flex items-center justify-center text-white shadow-[0_0_15px_rgba(0,0,0,0.5)] transition-transform group-hover:scale-110">
            <ChevronsLeftRight className="w-4 h-4" />
          </div>
        </div>

        {/* Labels */}
        {toggleButton}
        <div
          className={`absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white/90 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded border border-white/10 z-10 pointer-events-none transition-opacity duration-300 ${position < 15 ? "opacity-0" : "opacity-100"}`}
        >
          {labelBefore}
        </div>
        <div
          className={`absolute top-3 right-3 bg-purple-600/90 backdrop-blur-md text-white text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded border border-white/10 z-10 pointer-events-none transition-opacity duration-300 ${position > 85 ? "opacity-0" : "opacity-100"}`}
        >
          {labelAfter}
        </div>
      </div>
    </div>
  );
};
