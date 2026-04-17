import React, { useEffect } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { X } from "lucide-react";
import { GeneratedImage } from "../types";

interface MediaViewerModalProps {
  image: GeneratedImage;
  isLiveMode: boolean;
  onClose: () => void;
}

export const MediaViewerModal: React.FC<MediaViewerModalProps> = ({
  image,
  isLiveMode,
  onClose,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const isVideo = isLiveMode && Boolean(image.videoUrl);

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/90 backdrop-blur-xl animate-in fade-in duration-200"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-[130] flex items-center justify-center w-11 h-11 rounded-full bg-white/10 border border-white/10 text-white/80 hover:text-white hover:bg-white/15 transition-all"
        aria-label="Close viewer"
      >
        <X className="w-5 h-5" />
      </button>

      <div
        className="w-full h-full p-4 md:p-6"
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
        )}
      </div>
    </div>
  );
};
