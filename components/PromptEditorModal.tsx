import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";
import { translations } from "../translations";

interface PromptEditorModalProps {
  initialPrompt: string;
  onClose: (prompt?: string) => void;
}

export const PromptEditorModal: React.FC<PromptEditorModalProps> = ({
  initialPrompt,
  onClose,
}) => {
  const { language } = useSettingsStore();
  const t = translations[language];
  const [localPrompt, setLocalPrompt] = useState(initialPrompt);
  const [isRendered, setIsRendered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setIsRendered(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setIsVisible(true));
    });
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(() => {
      onClose(localPrompt);
      setIsRendered(false);
    }, 300);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [localPrompt, onClose]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    if (isVisible && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isVisible]);

  if (!isRendered) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ease-out ${isVisible ? "opacity-100" : "opacity-0 delay-200"}`}
      />
      <div
        className={`relative w-full max-w-2xl bg-[#0D0B14]/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-[0_0_50px_-12px_rgba(124,58,237,0.15)] ring-1 ring-white/[0.05] overflow-hidden flex flex-col transition-all duration-300 cubic-bezier(0.16, 1, 0.3, 1) ${isVisible ? "scale-100 opacity-100 translate-y-0 delay-100" : "scale-95 opacity-0 translate-y-4"}`}
        style={{ minHeight: "75vh", maxHeight: "90vh" }}
      >
        <button
          onClick={handleClose}
          className="absolute top-3 right-3 group p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.08] transition-all duration-200 z-10"
        >
          <X className="w-5 h-5 transition-transform duration-500 ease-out group-hover:rotate-180" />
        </button>
        <textarea
          ref={textareaRef}
          value={localPrompt}
          onChange={(e) => setLocalPrompt(e.target.value)}
          className="flex-1 w-full min-h-0 resize-none bg-white/[0.03] border border-white/10 rounded-xl p-5 pt-12 text-base text-white/90 placeholder:text-white/30 focus:outline-0 focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 hover:border-white/20 custom-scrollbar leading-normal transition-all duration-300 ease-out"
          placeholder={t.promptPlaceholder}
        />
      </div>
    </div>,
    document.body
  );
};
