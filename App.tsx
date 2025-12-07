import React, { useState, useEffect, useRef } from 'react';
import { generateImage, optimizePrompt, upscaler } from './services/hfService';
import { GeneratedImage, AspectRatioOption, ModelOption } from './types';
import { HistoryGallery } from './components/HistoryGallery';
import { CustomSelect } from './components/CustomSelect';
import { SettingsModal } from './components/SettingsModal';
import { Logo, Icon4x } from './components/Icons'
import { ImageComparison } from './components/ImageComparison';
import { Tooltip } from './components/Tooltip';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { translations, Language } from './translations';
import { 
  Sparkles, 
  Dices, 
  Loader2, 
  Download, 
  AlertCircle, 
  Paintbrush,
  Cpu,
  Minus,
  Plus,
  Wand2,
  Info,
  Settings,
  Trash2,
  Copy,
  Check,
  Timer,
  Eye,
  EyeOff,
  Github,
  X,
  Check as CheckIcon,
  RotateCcw,
  History,
} from 'lucide-react';

const MODEL_OPTIONS = [
  { value: 'z-image-turbo', label: 'Z-Image Turbo' },
  { value: 'qwen-image-fast', label: 'Qwen Image Fast' },
  { value: 'ovis-image', label: 'Ovis Image' }
];

export default function App() {
  // Language Initialization
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem('app_language');
    if (saved === 'en' || saved === 'zh') return saved;
    const browserLang = navigator.language.toLowerCase();
    return browserLang.startsWith('zh') ? 'zh' : 'en';
  });
  
  const t = translations[lang];

  // Dynamic Aspect Ratio Options based on language
  const aspectRatioOptions = [
    { value: '1:1', label: t.ar_square },
    { value: '9:16', label: t.ar_photo_9_16 },
    { value: '16:9', label: t.ar_movie },
    { value: '3:4', label: t.ar_portrait_3_4 },
    { value: '4:3', label: t.ar_landscape_4_3 },
    { value: '3:2', label: t.ar_portrait_3_2 },
    { value: '2:3', label: t.ar_landscape_2_3 },
  ];

  const [prompt, setPrompt] = useState<string>('');
  const [model, setModel] = useState<ModelOption>('z-image-turbo');
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>('1:1');
  const [seed, setSeed] = useState<string>(''); 
  const [enableHD, setEnableHD] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isOptimizing, setIsOptimizing] = useState<boolean>(false);
  const [isUpscaling, setIsUpscaling] = useState<boolean>(false);
  const [currentImage, setCurrentImage] = useState<GeneratedImage | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Prompt History State
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    try {
      const saved = sessionStorage.getItem('prompt_history');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [showPromptHistory, setShowPromptHistory] = useState<boolean>(false);
  const promptHistoryRef = useRef<HTMLDivElement>(null);

  // Transition state for upscaling
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const [tempUpscaledImage, setTempUpscaledImage] = useState<string | null>(null);
  
  // Initialize history from localStorage with expiration check (delete older than 1 day)
  const [history, setHistory] = useState<GeneratedImage[]>(() => {
    try {
      const saved = localStorage.getItem('ai_image_gen_history');
      if (!saved) return [];
      
      const parsedHistory: GeneratedImage[] = JSON.parse(saved);
      const now = Date.now();
      const oneDayInMs = 24 * 60 * 60 * 1000;
      
      // Filter out images older than 1 day
      return parsedHistory.filter(img => (now - img.timestamp) < oneDayInMs);
    } catch (e) {
      console.error("Failed to load history", e);
      return [];
    }
  });

  const [error, setError] = useState<string | null>(null);
  
  // New state for Info Popover
  const [showInfo, setShowInfo] = useState<boolean>(false);
  const [imageDimensions, setImageDimensions] = useState<{ width: number, height: number } | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState<boolean>(false);

  // Settings State
  const [showSettings, setShowSettings] = useState<boolean>(false);

  // Language Persistence
  useEffect(() => {
    localStorage.setItem('app_language', lang);
  }, [lang]);

  // Image History Persistence
  useEffect(() => {
    localStorage.setItem('ai_image_gen_history', JSON.stringify(history));
  }, [history]);

  // Prompt History Persistence
  useEffect(() => {
    sessionStorage.setItem('prompt_history', JSON.stringify(promptHistory));
  }, [promptHistory]);

  // Close prompt history on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (promptHistoryRef.current && !promptHistoryRef.current.contains(event.target as Node)) {
        setShowPromptHistory(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Initial Selection Effect
  useEffect(() => {
    if (!currentImage && history.length > 0) {
      setCurrentImage(history[0]);
    }
  }, [history.length]); 

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
        if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startTimer = () => {
    setElapsedTime(0);
    const startTime = Date.now();
    timerRef.current = setInterval(() => {
        setElapsedTime((Date.now() - startTime) / 1000);
    }, 100);
    return startTime;
  };

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const addToPromptHistory = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPromptHistory(prev => {
        // Remove duplicate if exists to move to top
        const filtered = prev.filter(p => p !== trimmed);
        return [trimmed, ...filtered].slice(0, 50); // Keep last 50
    });
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    addToPromptHistory(prompt);

    setIsLoading(true);
    setError(null);
    setShowInfo(false); 
    setImageDimensions(null);
    setIsComparing(false);
    setTempUpscaledImage(null);
    
    const startTime = startTimer();

    try {
      const seedNumber = seed.trim() === '' ? undefined : parseInt(seed, 10);
      const result = await generateImage(model, prompt, aspectRatio, seedNumber, enableHD);
      
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;
      
      const newImage = { ...result, duration };
      
      setCurrentImage(newImage);
      setHistory(prev => [newImage, ...prev]);
    } catch (err: any) {
      setError(err.message || "Failed to generate image. Please try again.");
    } finally {
      stopTimer();
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setPrompt('');
    setModel('z-image-turbo');
    setAspectRatio('1:1');
    setSeed('');
    setEnableHD(false);
    setCurrentImage(null);
    setIsComparing(false);
    setTempUpscaledImage(null);
    setError(null);
  };

  const handleUpscale = async () => {
    if (!currentImage || isUpscaling) return;

    setIsUpscaling(true);
    setError(null);
    
    try {
        const { url: newUrl } = await upscaler(currentImage.url);
        
        // Don't save yet, just enter comparison mode
        setTempUpscaledImage(newUrl);
        setIsComparing(true);

    } catch (err: any) {
        setTempUpscaledImage(null);
        setError(err.message || "Failed to upscale image.");
    } finally {
        setIsUpscaling(false);
    }
  };

  const handleApplyUpscale = () => {
    if (!currentImage || !tempUpscaledImage) return;

    const updatedImage = { 
        ...currentImage, 
        url: tempUpscaledImage, 
        isUpscaled: true 
    };

    setCurrentImage(updatedImage);
    setHistory(prev => prev.map(img => 
        img.id === updatedImage.id ? updatedImage : img
    ));
    
    // Exit comparison mode
    setIsComparing(false);
    setTempUpscaledImage(null);
  };

  const handleCancelUpscale = () => {
    setIsComparing(false);
    setTempUpscaledImage(null);
  };

  const handleOptimizePrompt = async () => {
    if (!prompt.trim()) return;
    
    addToPromptHistory(prompt); // Save original prompt before optimizing

    setIsOptimizing(true);
    setError(null);
    try {
        const optimized = await optimizePrompt(prompt);
        setPrompt(optimized);
    } catch (err: any) {
        console.error("Optimization failed", err);
        setError("Failed to optimize prompt. Please try again.");
    } finally {
        setIsOptimizing(false);
    }
  };

  const handleRandomizeSeed = () => {
    setSeed(Math.floor(Math.random() * 1000000).toString());
  };

  const handleAdjustSeed = (amount: number) => {
    const current = parseInt(seed || '0', 10);
    if (isNaN(current)) {
        setSeed((0 + amount).toString());
    } else {
        setSeed((current + amount).toString());
    }
  };

  const handleHistorySelect = (image: GeneratedImage) => {
    setCurrentImage(image);
    setShowInfo(false); 
    setImageDimensions(null); 
    setIsComparing(false);
    setTempUpscaledImage(null);
  };

  const handleDelete = () => {
    if (!currentImage) return;
    
    const newHistory = history.filter(img => img.id !== currentImage.id);
    setHistory(newHistory);
    
    if (newHistory.length > 0) {
      setCurrentImage(newHistory[0]);
    } else {
      setCurrentImage(null);
    }
    setShowInfo(false);
    setIsComparing(false);
    setTempUpscaledImage(null);
  };

  const handleToggleBlur = () => {
    if (!currentImage) return;
    
    const newStatus = !currentImage.isBlurred;
    const updatedImage = { ...currentImage, isBlurred: newStatus };
    
    setCurrentImage(updatedImage);
    setHistory(prev => prev.map(img => 
      img.id === currentImage.id ? updatedImage : img
    ));
  };

  const handleCopyPrompt = async () => {
    if (!currentImage?.prompt) return;
    try {
      await navigator.clipboard.writeText(currentImage.prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  const handleDownload = async (imageUrl: string, fileName: string) => {
    try {
      // 1. Handle Base64 Data URLs directly
      if (imageUrl.startsWith('data:')) {
        const link = document.createElement('a');
        link.href = imageUrl;
        link.download = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }

      // 2. Handle Remote URLs
      try {
        const response = await fetch(imageUrl, {
            mode: 'cors', // Try to request with CORS
        });
        
        if (!response.ok) throw new Error('Network response was not ok');
        
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        
        // Determine extension from content-type or fallback to png
        let extension = 'png';
        if (blob.type) {
             const typeParts = blob.type.split('/');
             if (typeParts.length > 1) extension = typeParts[1];
        }

        const finalFileName = fileName.includes('.') ? fileName : `${fileName}.${extension}`;
        
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = finalFileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up
        window.URL.revokeObjectURL(blobUrl);

      } catch (fetchError) {
        console.warn("Direct fetch failed, attempting canvas fallback...", fetchError);
        
        // 3. Fallback: Canvas (for images that load but fetch fails, e.g. strict CORS but allows display)
        // This is a "best effort" - if the image is tainted, toBlob will fail.
        await new Promise((resolve, reject) => {
             const img = new Image();
             img.crossOrigin = "Anonymous";
             img.src = imageUrl;
             img.onload = () => {
                 const canvas = document.createElement('canvas');
                 canvas.width = img.naturalWidth;
                 canvas.height = img.naturalHeight;
                 const ctx = canvas.getContext('2d');
                 if (!ctx) {
                     reject(new Error('Canvas context not found'));
                     return;
                 }
                 ctx.drawImage(img, 0, 0);
                 canvas.toBlob((blob) => {
                     if (!blob) {
                         reject(new Error('Canvas serialization failed (likely tainted)'));
                         return;
                     }
                     const url = window.URL.createObjectURL(blob);
                     const link = document.createElement('a');
                     link.href = url;
                     link.download = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
                     document.body.appendChild(link);
                     link.click();
                     document.body.removeChild(link);
                     window.URL.revokeObjectURL(url);
                     resolve(true);
                 });
             };
             img.onerror = (e) => reject(e);
        });
      }
    } catch (e) {
      console.error("All download methods failed:", e);
      // 4. Last Resort: Open in new tab
      window.open(imageUrl, '_blank');
    }
  };

  const getModelLabel = (modelValue: string) => {
      const option = MODEL_OPTIONS.find(o => o.value === modelValue);
      return option ? option.label : modelValue;
  };

  const isWorking = isLoading;

  return (
    <div className="relative flex h-auto min-h-screen w-full flex-col overflow-x-hidden bg-gradient-brilliant">
      <div className="flex h-full grow flex-col">
        {/* Header */}
        <header className="w-full backdrop-blur-md sticky top-0 z-50 bg-background-dark/30 border-b border-white/5">
          <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-2 md:px-8 md:py-4">
            <div className="flex items-center gap-2 text-white">
              <Logo />
              <h1 className="text-white text-xl font-bold leading-tight tracking-[-0.015em]">{t.appTitle}</h1>
            </div>
            
            <div className="flex gap-1">
              <Tooltip content={t.sourceCode} position="bottom">
                  <a
                    href="https://github.com/Amery2010/peinture"
                    className="flex items-center justify-center p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-all active:scale-95"
                    target="_blank"
                  >
                    <Github className="w-5 h-5" />
                  </a>
              </Tooltip>

              <Tooltip content={t.settings} position="bottom">
                  <button
                    onClick={() => setShowSettings(true)}
                    className="flex items-center justify-center p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-all active:scale-95"
                  >
                    <Settings className="w-5 h-5" />
                  </button>
              </Tooltip>
            </div>
          </div>
        </header>

        <main className="w-full max-w-7xl flex-1 flex flex-col-reverse md:items-stretch md:mx-auto md:flex-row gap-6 px-6 md:px-6 pb-8 pt-6">
          
          {/* Left Column: Controls */}
          <aside className="w-full md:max-w-sm flex-shrink-0 flex flex-col gap-6">
            <div className="flex-grow space-y-6">
              <div className="relative z-10 bg-black/20 p-6 rounded-xl backdrop-blur-xl border border-white/10 flex flex-col gap-6 shadow-2xl shadow-black/20">
                
                {/* Prompt Input */}
                <div className="group flex flex-col flex-1">
                    <div className="flex items-center justify-between pb-3">
                        <div className="flex items-center gap-2">
                          <label htmlFor="prompt-input" className="text-white text-lg font-medium leading-normal group-focus-within:text-purple-400 transition-colors cursor-pointer">{t.prompt}</label>

                          {/* History Prompt Button */}
                          <div className="relative" ref={promptHistoryRef}>
                              <Tooltip content={t.promptHistory}>
                                  <button
                                      onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          setShowPromptHistory(!showPromptHistory);
                                      }}
                                      className={`flex items-center justify-center h-7 w-7 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-all border border-transparent hover:border-white/10 animate-in fade-in zoom-in-0 duration-300 ${showPromptHistory ? 'text-purple-400 bg-white/10 border-white/10' : ''}`}
                                      type="button"
                                  >
                                      <History className="w-4 h-4" />
                                  </button>
                              </Tooltip>
                              
                              {/* History Dropdown */}
                              {showPromptHistory && (
                                  <div className="absolute left-0 top-full mt-2 w-72 max-h-[300px] overflow-y-auto custom-scrollbar rounded-xl bg-[#1A1625] border border-white/10 shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-100 flex flex-col">
                                      <div className="p-1">
                                          {promptHistory.length === 0 ? (
                                              <div className="p-4 text-center text-white/40 text-sm italic">
                                                  {t.historyEmpty}
                                              </div>
                                          ) : (
                                              promptHistory.map((historyPrompt, index) => (
                                                  <button
                                                      key={index}
                                                      onClick={(e) => {
                                                          e.preventDefault();
                                                          setPrompt(historyPrompt);
                                                          setShowPromptHistory(false);
                                                      }}
                                                      className="w-full text-left p-3 text-sm text-white/80 hover:bg-white/10 rounded-lg transition-colors group border-b border-white/5 last:border-0 last:border-b-0"
                                                      type="button"
                                                  >
                                                      <p className="line-clamp-4 text-xs leading-relaxed opacity-80 group-hover:opacity-100 break-words">{historyPrompt}</p>
                                                  </button>
                                              ))
                                          )}
                                      </div>
                                  </div>
                              )}
                          </div>
                        </div>

                        <Tooltip content={t.optimizeTitle}>
                            <button
                                onClick={handleOptimizePrompt}
                                disabled={isOptimizing || !prompt.trim()}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white/60 bg-white/5 hover:bg-white/10 hover:text-purple-300 rounded-lg transition-all border border-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
                                type="button"
                            >
                                {isOptimizing ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Wand2 className="w-3.5 h-3.5" />
                                )}
                                {isOptimizing ? t.optimizing : t.optimize}
                            </button>
                        </Tooltip>
                    </div>
                    <textarea 
                      id="prompt-input"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      disabled={isOptimizing}
                      className="form-input flex w-full min-w-0 flex-1 resize-none rounded-lg text-white/90 focus:outline-0 focus:ring-2 focus:ring-purple-500/50 border border-white/10 bg-white/5 focus:border-purple-500 min-h-36 placeholder:text-white/30 p-4 text-base font-normal leading-normal transition-all disabled:opacity-50 disabled:cursor-not-allowed" 
                      placeholder={t.promptPlaceholder}
                    />
                </div>

                {/* Parameters */}
                <div className="space-y-6">
                  {/* Model Selection */}
                  <CustomSelect
                    label={t.model}
                    value={model}
                    onChange={(val) => setModel(val as ModelOption)}
                    options={MODEL_OPTIONS}
                    icon={<Cpu className="w-5 h-5" />}
                    headerContent={
                        model === 'z-image-turbo' && (
                            <div className="flex items-center gap-2 animate-in fade-in duration-300">
                                <span className="text-xs font-medium text-white/50">{t.hd}</span>
                                <Tooltip content={enableHD ? t.hdEnabled : t.hdDisabled}>
                                    <button
                                        onClick={() => setEnableHD(!enableHD)}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500/50 ${enableHD ? 'bg-purple-600' : 'bg-white/10'}`}
                                    >
                                        <span
                                            className={`${enableHD ? 'translate-x-4' : 'translate-x-1'} inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform`}
                                        />
                                    </button>
                                </Tooltip>
                            </div>
                        )
                    }
                  />

                  {/* Aspect Ratio */}
                  <CustomSelect
                    label={t.aspectRatio}
                    value={aspectRatio}
                    onChange={(val) => setAspectRatio(val as AspectRatioOption)}
                    options={aspectRatioOptions}
                  />

                  {/* Seed */}
                  <div className="group">
                    <div className="flex items-center justify-between pb-3">
                      <p className="text-white text-lg font-medium leading-normal group-focus-within:text-purple-400 transition-colors">{t.seed}</p>
                      <span className="text-white/50 text-sm">{t.seedOptional}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex flex-1 items-center rounded-lg border border-white/10 bg-white/5 focus-within:ring-2 focus-within:ring-purple-500/50 focus-within:border-purple-500 transition-all h-12 overflow-hidden">
                        <button 
                            onClick={() => handleAdjustSeed(-1)}
                            className="h-full px-3 text-white/40 hover:text-white hover:bg-white/5 transition-colors border-r border-white/5"
                        >
                            <Minus className="w-4 h-4" />
                        </button>
                        <input 
                            type="number"
                            value={seed}
                            onChange={(e) => setSeed(e.target.value)}
                            className="form-input flex-1 h-full bg-transparent border-none text-white/90 focus:ring-0 placeholder:text-white/30 px-2 text-sm font-medium text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" 
                            placeholder={t.seedPlaceholder}
                        />
                        <button 
                            onClick={() => handleAdjustSeed(1)}
                            className="h-full px-3 text-white/40 hover:text-white hover:bg-white/5 transition-colors border-l border-white/5"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                      </div>
                      
                      <Tooltip content={t.seedPlaceholder}>
                          <button 
                            onClick={handleRandomizeSeed}
                            className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-colors active:scale-95"
                          >
                            <Dices className="w-5 h-5" />
                          </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              </div>

              {/* Generate Button & Reset Button */}
              <div className="flex items-center gap-3">
                <button 
                    onClick={handleGenerate}
                    disabled={isWorking || !prompt.trim()}
                    className="group relative flex-1 flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-xl h-12 px-4 text-white text-lg font-bold leading-normal tracking-[0.015em] transition-all shadow-lg shadow-purple-900/40 generate-button-gradient hover:shadow-purple-700/50 disabled:opacity-70 disabled:cursor-not-allowed disabled:grayscale"
                >
                    {isLoading ? (
                    <div className="flex items-center gap-2">
                        <Loader2 className="animate-spin w-5 h-5" />
                        <span>{t.dreaming}</span>
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
          <div className="flex-1 flex flex-col overflow-x-hidden">
            
            {/* Main Preview Area */}
            <section className="flex-1 flex flex-col w-full min-h-[360px] md:max-h-[450px]">
              <div className="relative w-full flex-grow flex flex-col items-center justify-center bg-black/20 rounded-xl backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/20 overflow-hidden relative group">
                
                {isWorking ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-black/40 backdrop-blur-sm animate-in fade-in duration-500">
                         <div className="relative">
                            <div className="h-24 w-24 rounded-full border-4 border-white/10 border-t-purple-500 animate-spin"></div>
                            <div className="absolute inset-0 flex items-center justify-center">
                                <Paintbrush className="text-purple-400 animate-pulse w-8 h-8" />
                            </div>
                         </div>
                         <p className="mt-8 text-white/80 font-medium animate-pulse text-lg">
                            {t.dreaming}
                         </p>
                         <p className="mt-2 font-mono text-purple-300 text-lg">{elapsedTime.toFixed(1)}s</p>
                    </div>
                ) : null}

                {error ? (
                    <div className="text-center text-red-400 p-8 max-w-md animate-in zoom-in-95 duration-300">
                        <AlertCircle className="w-16 h-16 mx-auto mb-4 text-red-500/50" />
                        <h3 className="text-xl font-bold text-white mb-2">{t.generationFailed}</h3>
                        <p className="text-white/60">{error}</p>
                    </div>
                ) : currentImage ? (
                  <div className="w-full h-full flex items-center justify-center bg-black/40 animate-in zoom-in-95 duration-500 relative">
                     
                     {/* Image View or Comparison View */}
                     {isComparing && tempUpscaledImage ? (
                        <div className="w-full h-full">
                            <ImageComparison 
                                beforeImage={currentImage.url}
                                afterImage={tempUpscaledImage}
                                alt={currentImage.prompt}
                            />
                        </div>
                     ) : (
                        <TransformWrapper
                            initialScale={1}
                            minScale={1}
                            maxScale={8}
                            centerOnInit={true}
                            key={currentImage.id} // Forces component reset on new image
                            wheel={{ step: 0.5 }}
                        >
                        <TransformComponent 
                            wrapperStyle={{ width: "100%", height: "100%" }}
                            contentStyle={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
                        >
                            <img 
                                src={currentImage.url} 
                                alt={currentImage.prompt} 
                                className={`max-w-full max-h-full object-contain shadow-2xl cursor-grab active:cursor-grabbing transition-all duration-300 ${currentImage.isBlurred ? 'blur-lg scale-105' : ''}`}
                                onContextMenu={(e) => e.preventDefault()}
                                onLoad={(e) => {
                                    setImageDimensions({
                                        width: e.currentTarget.naturalWidth,
                                        height: e.currentTarget.naturalHeight
                                    });
                                }}
                            />
                        </TransformComponent>
                        </TransformWrapper>
                     )}
                     
                     {/* Info Popover */}
                     {showInfo && !isComparing && (
                       <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 w-[90%] md:w-[400px] bg-[#1A1625]/95 backdrop-blur-md border border-white/10 rounded-xl p-5 shadow-2xl text-sm text-white/80 animate-in slide-in-from-bottom-2 fade-in duration-200">
                          <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-2">
                             <h4 className="font-medium text-white">{t.imageDetails}</h4>
                             <button onClick={() => setShowInfo(false)} className="text-white/40 hover:text-white">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                             </button>
                          </div>
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <span className="block text-white/40 text-[10px] uppercase tracking-wider font-semibold mb-0.5">{t.model}</span>
                                    <p className="text-white/90">{getModelLabel(currentImage.model)}</p>
                                </div>
                                <div>
                                    <span className="block text-white/40 text-[10px] uppercase tracking-wider font-semibold mb-0.5">{t.dimensions}</span>
                                    <p className="text-white/90">
                                        {imageDimensions ? `${imageDimensions.width} x ${imageDimensions.height} (${currentImage.aspectRatio})` : currentImage.aspectRatio}
                                        {currentImage.isUpscaled && <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-300 font-bold">HD</span>}
                                    </p>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                {currentImage.seed !== undefined && (
                                    <div>
                                    <span className="block text-white/40 text-[10px] uppercase tracking-wider font-semibold mb-0.5">{t.seed}</span>
                                    <p className="font-mono text-white/90">{currentImage.seed}</p>
                                    </div>
                                )}
                                {currentImage.duration !== undefined && (
                                    <div>
                                    <span className="block text-white/40 text-[10px] uppercase tracking-wider font-semibold mb-0.5">{t.duration}</span>
                                    <p className="font-mono text-white/90 flex items-center gap-1">
                                        <Timer className="w-3 h-3 text-purple-400" />
                                        {currentImage.duration.toFixed(1)}s
                                    </p>
                                    </div>
                                )}
                            </div>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <span className="block text-white/40 text-[10px] uppercase tracking-wider font-semibold">{t.prompt}</span>
                                    <button 
                                        onClick={handleCopyPrompt}
                                        className="flex items-center gap-1.5 text-[10px] font-medium text-purple-400 hover:text-purple-300 transition-colors"
                                    >
                                        {copiedPrompt ? (
                                            <>
                                                <Check className="w-3 h-3" />
                                                {t.copied}
                                            </>
                                        ) : (
                                            <>
                                                <Copy className="w-3 h-3" />
                                                {t.copy}
                                            </>
                                        )}
                                    </button>
                                </div>
                              <div className="max-h-24 overflow-y-auto custom-scrollbar p-2 bg-black/20 rounded-lg border border-white/5">
                                <p className="text-xs leading-relaxed text-white/70 italic select-text">{currentImage.prompt}</p>
                              </div>
                            </div>
                          </div>
                       </div>
                     )}

                     {/* Toolbar Area */}
                     <div className="absolute bottom-6 inset-x-0 flex justify-center pointer-events-none z-40">
                         {isComparing ? (
                            /* Comparison Controls */
                            <div className="pointer-events-auto flex items-center gap-3 animate-in slide-in-from-bottom-4 duration-300">
                                <button
                                    onClick={handleCancelUpscale}
                                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-black/60 backdrop-blur-md border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all shadow-xl hover:shadow-red-900/10 hover:border-red-500/30"
                                >
                                    <X className="w-5 h-5 text-red-400" />
                                    <span className="font-medium text-sm">{t.discard}</span>
                                </button>
                                <button
                                    onClick={handleApplyUpscale}
                                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-black/60 backdrop-blur-md border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all shadow-xl hover:shadow-purple-900/10 hover:border-purple-500/30"
                                >
                                    <CheckIcon className="w-5 h-5 text-purple-400" />
                                    <span className="font-medium text-sm">{t.apply}</span>
                                </button>
                            </div>
                         ) : (
                            /* Standard Toolbar */
                            <div className="pointer-events-auto flex items-center gap-1 p-1.5 rounded-2xl bg-black/60 backdrop-blur-md border border-white/10 shadow-2xl transition-opacity duration-300 opacity-100 md:opacity-0 md:group-hover:opacity-100">
                                
                                <Tooltip content={t.details}>
                                    <button
                                        onClick={() => setShowInfo(!showInfo)}
                                        className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${showInfo ? 'bg-purple-600 text-white shadow-lg' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
                                    >
                                        <Info className="w-5 h-5" />
                                    </button>
                                </Tooltip>

                                <div className="w-px h-5 bg-white/10 mx-1"></div>

                                <Tooltip content={isUpscaling ? t.upscaling : t.upscale}>
                                    <button
                                        onClick={handleUpscale}
                                        disabled={isUpscaling || currentImage.isUpscaled}
                                        className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${currentImage.isUpscaled ? 'text-purple-400 bg-purple-500/10' : 'text-white/70 hover:text-purple-400 hover:bg-white/10'} disabled:opacity-50 disabled:cursor-not-allowed`}
                                    >
                                        {isUpscaling ? (
                                            <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
                                        ) : (
                                            <Icon4x className="w-5 h-5 transition-colors duration-300" />
                                        )}
                                    </button>
                                </Tooltip>

                                <div className="w-px h-5 bg-white/10 mx-1"></div>

                                <Tooltip content={t.toggleBlur}>
                                    <button 
                                        onClick={handleToggleBlur}
                                        className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all ${currentImage.isBlurred ? 'text-purple-400 bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
                                    >
                                        {currentImage.isBlurred ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                    </button>
                                </Tooltip>

                                <div className="w-px h-5 bg-white/10 mx-1"></div>
                                
                                <Tooltip content={t.download}>
                                    <button 
                                        onClick={() => handleDownload(currentImage.url, `generated-${currentImage.id}`)}
                                        className="flex items-center justify-center w-10 h-10 rounded-xl text-white/70 hover:text-white hover:bg-white/10 transition-all"
                                    >
                                        <Download className="w-5 h-5" />
                                    </button>
                                </Tooltip>
                                
                                <Tooltip content={t.delete}>
                                    <button 
                                        onClick={handleDelete}
                                        className="flex items-center justify-center w-10 h-10 rounded-xl text-white/70 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                    >
                                        <Trash2 className="w-5 h-5" />
                                    </button>
                                </Tooltip>
                            </div>
                         )}
                     </div>
                  </div>
                ) : !isWorking && (
                  <div className="text-center text-white/60 p-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <div className="relative inline-block">
                        <Sparkles className="w-20 h-20 text-white/10" />
                        <Sparkles className="w-20 h-20 text-purple-500/40 absolute top-0 left-0 blur-lg animate-pulse" />
                    </div>
                    <h2 className="mt-6 text-2xl font-bold text-white/90">{t.galleryEmptyTitle}</h2>
                    <p className="mt-2 text-base text-white/40 max-w-xs mx-auto">{t.galleryEmptyDesc}</p>
                  </div>
                )}
              </div>
            </section>

            {/* Gallery Strip */}
            <HistoryGallery 
                images={history} 
                onSelect={handleHistorySelect} 
                selectedId={currentImage?.id}
            />

          </div>
        </main>
        
        {/* Settings Modal */}
        <SettingsModal 
            isOpen={showSettings} 
            onClose={() => setShowSettings(false)} 
            lang={lang}
            setLang={setLang}
            t={t}
        />
      </div>
    </div>
  );
}