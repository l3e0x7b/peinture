import React, { useEffect, useMemo, useState } from "react";
import { Sparkles, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PromptInput } from "../components/PromptInput";
import { ControlPanel } from "../components/ControlPanel";
import { PreviewStage } from "../components/PreviewStage";
import { ImageToolbar } from "../components/ImageToolbar";
import { HistoryGallery } from "../components/HistoryGallery";
import { MediaViewerModal } from "../components/MediaViewerModal";
import { Tooltip } from "../components/Tooltip";
import { useSettingsStore } from "../store/settingsStore";
import { useUIStore, useCurrentImage } from "../store/uiStore";
import { useDataStore } from "../store/dataStore";
import { translations } from "../translations";
import { useCreationGeneration } from "../hooks/useCreationGeneration";
import { useImageActions } from "../hooks/useImageActions";

export const CreationView: React.FC = () => {
  const { language, provider } = useSettingsStore();
  const { cloudHistory } = useDataStore();
  const {
    prompt,
    isLoading,
    isTranslating,
    isUpscaling,
    isDownloading,
    isLiveMode,
    setIsLiveMode,
    imageDimensions,
    setImageDimensions,
  } = useUIStore();

  const currentImage = useCurrentImage();

  const t = translations[language];
  const [isViewerOpen, setIsViewerOpen] = useState(false);

  // Business logic hooks
  const {
    elapsedTime,
    handleGenerate,
    handleOptimizePrompt,
    handleLiveClick,
    handleReset,
  } = useCreationGeneration();

  const {
    isComparing,
    tempUpscaledImage,
    handleUpscale,
    handleApplyUpscale,
    handleCancelUpscale,
    showInfo,
    setShowInfo,
    copiedPrompt,
    handleCopyPrompt,
    handleHistorySelect,
    handleDelete,
    handleToggleBlur,
    handleDownload,
    uploadCurrentToCloud,
    isUploading,
    uploadError,
  } = useImageActions();

  // Sync upload error
  useEffect(() => {
    if (uploadError) toast.error(uploadError);
  }, [uploadError]);

  // Derived UI states
  const isWorking = isLoading;
  const isLiveGenerating = currentImage?.videoStatus === "generating";
  const shouldHideToolbar = isWorking;

  const isCurrentUploaded = useMemo(() => {
    if (!currentImage) return false;
    if (isLiveMode && currentImage.videoUrl) {
      return cloudHistory.some(
        (ci) => ci.fileName && ci.fileName.includes(`video-${currentImage.id}`),
      );
    } else {
      return cloudHistory.some(
        (ci) =>
          ci.fileName &&
          ci.fileName.includes(currentImage.id) &&
          !ci.fileName.includes("video-"),
      );
    }
  }, [currentImage, cloudHistory, isLiveMode]);

  return (
    <main className="w-full max-w-7xl flex-1 flex flex-col-reverse md:items-stretch md:mx-auto md:flex-row gap-4 md:gap-6 px-4 md:px-8 pb-4 md:pb-8 pt-4 md:pt-6">
      {/* Left Column: Controls */}
      <aside className="w-full md:max-w-sm flex-shrink-0 flex flex-col gap-4 md:gap-6">
        <div className="flex-grow space-y-4 md:space-y-6">
          <div className="relative z-10 bg-black/20 p-4 md:p-6 rounded-xl backdrop-blur-xl border border-white/10 flex flex-col gap-4 md:gap-6 shadow-2xl shadow-black/20">
            <PromptInput onOptimize={handleOptimizePrompt} />
            <ControlPanel />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleGenerate}
              disabled={isWorking || !prompt.trim() || isTranslating}
              className="group relative flex-1 flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-xl h-12 px-4 text-white text-lg font-bold leading-normal tracking-[0.015em] transition-all shadow-lg shadow-purple-900/40 generate-button-gradient hover:shadow-purple-700/50 disabled:opacity-70 disabled:cursor-not-allowed disabled:grayscale"
            >
              {isLoading || isTranslating ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="animate-spin w-5 h-5" />
                  <span>{isTranslating ? t.translating : t.dreaming}</span>
                </div>
              ) : (
                <span className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 group-hover:animate-pulse" />
                  <span className="truncate">{t.generate}</span>
                </span>
              )}
            </button>

            {currentImage && (
              <Tooltip content={t.reset}>
                <button
                  onClick={handleReset}
                  className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-xl bg-white/5 border border-white/10 text-white/70 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all shadow-lg active:scale-95"
                >
                  <RotateCcw className="w-5 h-5" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </aside>

      {/* Right Column: Preview & Gallery */}
      <div className="flex-1 flex flex-col flex-grow overflow-x-hidden">
        <div className="relative group w-full">
          <PreviewStage
            currentImage={currentImage}
            isWorking={isWorking}
            isTranslating={isTranslating}
            elapsedTime={elapsedTime}
            isComparing={isComparing}
            tempUpscaledImage={tempUpscaledImage}
            showInfo={showInfo}
            setShowInfo={setShowInfo}
            imageDimensions={imageDimensions}
            setImageDimensions={setImageDimensions}
            isLiveMode={isLiveMode}
            onToggleLiveMode={() => setIsLiveMode(!isLiveMode)}
          />

          {!shouldHideToolbar && (
            <ImageToolbar
              currentImage={currentImage}
              isComparing={isComparing}
              showInfo={showInfo}
              setShowInfo={setShowInfo}
              isUpscaling={isUpscaling}
              isDownloading={isDownloading}
              handleUpscale={handleUpscale}
              handleToggleBlur={handleToggleBlur}
              handleDownload={handleDownload}
              handleDelete={handleDelete}
              handleCancelUpscale={handleCancelUpscale}
              handleApplyUpscale={handleApplyUpscale}
              isLiveMode={isLiveMode}
              onLiveClick={handleLiveClick}
              isLiveGenerating={isLiveGenerating}
              provider={provider}
              handleUploadToS3={uploadCurrentToCloud}
              isUploading={isUploading}
              isUploaded={isCurrentUploaded}
              imageDimensions={imageDimensions}
              copiedPrompt={copiedPrompt}
              handleCopyPrompt={handleCopyPrompt}
              handleOpenViewer={() => setIsViewerOpen(true)}
            />
          )}
        </div>

        <HistoryGallery onSelect={handleHistorySelect} />
      </div>

      {currentImage && isViewerOpen && (
        <MediaViewerModal
          image={currentImage}
          isLiveMode={Boolean(isLiveMode && currentImage.videoUrl)}
          onClose={() => setIsViewerOpen(false)}
        />
      )}
    </main>
  );
};
