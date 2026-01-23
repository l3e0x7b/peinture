import { GeneratedImage, AspectRatioOption, ModelOption } from "../types";
import { generateUUID, getSystemPromptContent, FIXED_SYSTEM_PROMPT_SUFFIX } from "./utils";
import { uploadToGradio } from "./hfService";
import { API_MODEL_MAP } from "../constants";
import { useAppStore } from "../store/appStore";

const MS_BASE_URL = "https://api-inference.modelscope.cn/";
const MS_GENERATE_ENDPOINT = `${MS_BASE_URL}v1/images/generations`;
const MS_CHAT_API_URL = "https://api-inference.modelscope.cn/v1/chat/completions";

// Constants for image upload via HF Space
const QWEN_EDIT_HF_BASE = "https://linoyts-qwen-image-edit-2509-fast.hf.space";
const QWEN_EDIT_HF_FILE_PREFIX = "https://linoyts-qwen-image-edit-2509-fast.hf.space/gradio_api/file=";

// --- Token Management System ---

const getNextAvailableToken = (): string | null => {
  const store = useAppStore.getState();
  store.resetDailyStatus('modelscope');
  
  const tokens = store.tokens.modelscope || [];
  const status = store.tokenStatus.modelscope;
  
  return tokens.find(t => !status.exhausted[t]) || null;
};

const markTokenExhausted = (token: string) => {
  useAppStore.getState().markTokenExhausted('modelscope', token);
};

const runWithMsTokenRetry = async <T>(operation: (token: string) => Promise<T>): Promise<T> => {
  const tokens = useAppStore.getState().tokens.modelscope || [];
  
  if (tokens.length === 0) {
      throw new Error("error_ms_token_required");
  }

  let lastError: any;
  let attempts = 0;
  const maxAttempts = tokens.length + 1; 

  while (attempts < maxAttempts) {
    attempts++;
    const token = getNextAvailableToken();
    
    if (!token) {
       throw new Error("error_ms_token_exhausted");
    }

    try {
      return await operation(token);
    } catch (error: any) {
      lastError = error;
      
      if (error.name === 'AbortError') {
        throw error;
      }

      const isQuotaError = 
        error.message?.includes("429") ||
        error.status === 429 ||
        error.message?.includes("quota") ||
        error.message?.includes("credit") ||
        error.message?.includes("Arrearage") ||
        error.message?.includes("Bill");

      if (isQuotaError && token) {
        console.warn(`Model Scope Token ${token.substring(0, 8)}... exhausted/error. Switching to next token.`);
        markTokenExhausted(token);
        continue;
      }

      throw error;
    }
  }
  
  throw lastError || new Error("error_api_connection");
};

// --- Polling Helper for Async Tasks ---

const pollMsTask = async (taskId: string, token: string, signal?: AbortSignal): Promise<string[]> => {
    const statusUrl = `${MS_BASE_URL}v1/tasks/${taskId}`;
    
    while (true) {
        if (signal?.aborted) throw new Error("AbortError");

        const response = await fetch(statusUrl, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                "X-ModelScope-Task-Type": "image_generation"
            },
            signal
        });

        if (!response.ok) {
            throw new Error(`Failed to check task status: ${response.status}`);
        }

        const data = await response.json();
        const status = data.task_status;

        if (status === 'SUCCEED') {
            if (!data.output_images || data.output_images.length === 0) {
                throw new Error("error_invalid_response");
            }
            return data.output_images;
        } else if (status === 'FAILED') {
            throw new Error(data.message || "Model Scope generation task failed");
        }

        // Wait 5 seconds before next poll
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
};

// --- Dimensions Logic ---

const getBaseDimensions = (ratio: AspectRatioOption) => {
    switch(ratio) {
        case "16:9": return { width: 1024, height: 576 };
        case "4:3": return { width: 1024, height: 768 };
        case "3:2": return { width: 960, height: 640 };
        case "9:16": return { width: 576, height: 1024 };
        case "3:4": return { width: 768, height: 1024 };
        case "2:3": return { width: 640, height: 960 };
        case "1:1": default: return { width: 1024, height: 1024 };
    }
}

const getDimensions = (ratio: AspectRatioOption, enableHD: boolean): { width: number; height: number } => {
  const base = getBaseDimensions(ratio);

  if (enableHD) {
      return {
          width: Math.round(base.width * 2),
          height: Math.round(base.height * 2)
      };
  }
  
  return base;
};

// --- Service Logic ---

export const generateMSImage = async (
  model: ModelOption,
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  steps?: number,
  enableHD: boolean = false,
  guidanceScale?: number
): Promise<GeneratedImage> => {
  const { width, height } = getDimensions(aspectRatio, enableHD);
  const finalSeed = seed ?? Math.floor(Math.random() * 2147483647);
  const finalSteps = steps ?? 9; 
  const sizeString = `${width}x${height}`;

  const apiModel = API_MODEL_MAP.modelscope[model];
  if (!apiModel) {
      throw new Error(`Model ${model} not supported on Model Scope`);
  }

  return runWithMsTokenRetry(async (token) => {
    try {
      const requestBody: any = {
          prompt,
          model: apiModel,
          size: sizeString,
          seed: finalSeed,
          steps: finalSteps
      };

      if (guidanceScale !== undefined) {
          requestBody.guidance = guidanceScale;
      }

      const response = await fetch(MS_GENERATE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "X-ModelScope-Async-Mode": "true"
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `Model Scope API Error: ${response.status}`);
      }

      const initData = await response.json();
      if (!initData.task_id) {
          throw new Error("error_invalid_response");
      }

      // Start Polling
      const outputImages = await pollMsTask(initData.task_id, token);
      const imageUrl = outputImages[0];

      return {
        id: generateUUID(),
        url: imageUrl,
        model, 
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed: finalSeed,
        steps: finalSteps,
        guidanceScale,
        provider: 'modelscope'
      };

    } catch (error) {
      console.error("Model Scope Image Generation Error:", error);
      throw error;
    }
  });
};

export const editImageMS = async (
  imageBlobs: Blob[],
  prompt: string,
  width?: number,
  height?: number,
  steps: number = 16,
  guidanceScale: number = 4,
  signal?: AbortSignal
): Promise<GeneratedImage> => {
  // 1. Upload images to Gradio space to get public URLs. 
  const uploadedFilenames = await Promise.all(imageBlobs.map(blob => 
    uploadToGradio(QWEN_EDIT_HF_BASE, blob, null, signal)
  ));
  const imageUrls = uploadedFilenames.map(name => `${QWEN_EDIT_HF_FILE_PREFIX}${name}`);

  // 2. Perform generation on Model Scope
  return runWithMsTokenRetry(async (token) => {
    try {
      const apiModel = API_MODEL_MAP.modelscope['qwen-image-edit'];
      const requestBody: any = {
        prompt,
        model: apiModel,
        image_url: imageUrls,
        seed: Math.floor(Math.random() * 2147483647),
        steps: steps, 
        guidance: guidanceScale 
      };

      const response = await fetch(MS_GENERATE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "X-ModelScope-Async-Mode": "true"
        },
        body: JSON.stringify(requestBody),
        signal
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `Model Scope Image Edit Error: ${response.status}`);
      }

      const initData = await response.json();
      if (!initData.task_id) {
          throw new Error("error_invalid_response");
      }

      // Start Polling
      const outputImages = await pollMsTask(initData.task_id, token, signal);
      const imageUrl = outputImages[0];

      return {
        id: generateUUID(),
        url: imageUrl,
        model: 'qwen-image-edit', 
        prompt,
        aspectRatio: 'custom',
        timestamp: Date.now(),
        steps,
        guidanceScale,
        provider: 'modelscope'
      };
    } catch (error) {
      console.error("Model Scope Image Edit Error:", error);
      throw error;
    }
  });
};

export const optimizePromptMS = async (originalPrompt: string, model: string = 'deepseek-3_2'): Promise<string> => {
  return runWithMsTokenRetry(async (token) => {
    try {
      const systemInstruction = getSystemPromptContent() + FIXED_SYSTEM_PROMPT_SUFFIX;
      const apiModel = API_MODEL_MAP.modelscope[model] || model;
      
      const response = await fetch(MS_CHAT_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          model: apiModel,
          messages: [
            {
              role: 'system',
              content: systemInstruction
            },
            {
              role: 'user',
              content: originalPrompt
            }
          ],
          stream: false
        }),
      });

      if (!response.ok) {
          throw new Error("error_prompt_optimization_failed");
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      
      return content || originalPrompt;
    } catch (error) {
      console.error("Model Scope Prompt Optimization Error:", error);
      throw error;
    }
  });
};