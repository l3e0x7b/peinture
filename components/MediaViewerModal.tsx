import React, { useEffect } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { GeneratedImage } from "../types";

interface MediaViewerModalProps {
  image: GeneratedImage;
  isLiveMode: boolean;
  canNavigate: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export const MediaViewerModal: React.FC<MediaViewerModalProps> = ({
  image,
  isLiveMode,
  canNavigate,
  onPrev,
  onNext,
  onClose,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && canNavigate) {
        event.preventDefault();
        onPrev();
      } else if (event.key === "ArrowRight" && canNavigate) {
        event.preventDefault();
        onNext();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [canNavigate, onClose, onPrev, onNext]);

  const isVideo = isLiveMode && Boolean(image.videoUrl);

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/90 backdrop-blur-xl animate-in fade-in duration-200"
      style={{ height: "100dvh" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute top-4 right-4 z-[130] flex items-center justify-center w-11 h-11 rounded-full bg-black/60 backdrop-blur-md border border-white/30 shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-white hover:text-white hover:bg-black/75 hover:border-white/45 transition-all"
        aria-label="Close viewer"
      >
        <X className="w-5 h-5" />
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onPrev();
        }}
        disabled={!canNavigate}
        className="absolute left-4 top-1/2 -translate-y-1/2 z-[130] flex items-center justify-center w-11 h-11 rounded-full bg-black/60 backdrop-blur-md border border-white/30 shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-white hover:text-white hover:bg-black/75 hover:border-white/45 transition-all disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-black/60 disabled:hover:border-white/30"
        aria-label="Previous media"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNext();
        }}
        disabled={!canNavigate}
        className="absolute right-4 top-1/2 -translate-y-1/2 z-[130] flex items-center justify-center w-11 h-11 rounded-full bg-black/60 backdrop-blur-md border border-white/30 shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-white hover:text-white hover:bg-black/75 hover:border-white/45 transition-all disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-black/60 disabled:hover:border-white/30"
        aria-label="Next media"
      >
        <ChevronRight className="w-5 h-5" />
      </button>

      <div
        className="w-full h-full flex items-center justify-center px-4 md:px-6"
        style={{
          paddingTop: "max(1rem, calc(env(safe-area-inset-top) + 1rem))",
          paddingBottom: "max(1rem, calc(env(safe-area-inset-bottom) + 1rem))",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {isVideo ? (
          <div className="w-full h-full flex items-center justify-center">
            <video
              src={image.videoUrl}
              className={`max-w-full max-h-full object-contain shadow-2xl transition-all duration-300 ${image.isBlurred ? "blur-lg scale-105" : ""}`}
              autoPlay
              loop
              playsInline
            />
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <TransformWrapper
              initialScale={1}
              minScale={1}
              maxScale={8}
              centerOnInit={true}
              wheel={{ step: 0.5 }}
            >
              <TransformComponent
                wrapperStyle={{ width: "100%", height: "100%" }}
                contentStyle={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <img
                  src={image.url}
                  alt={image.prompt}
                  className={`max-w-full max-h-full object-contain shadow-2xl cursor-grab active:cursor-grabbing transition-all duration-300 ${image.isBlurred ? "blur-lg scale-105" : ""}`}
                  onContextMenu={(event) => event.preventDefault()}
                />
              </TransformComponent>
            </TransformWrapper>
          </div>
        )}
      </div>
    </div>
  );
};
