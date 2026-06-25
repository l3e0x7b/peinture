import { GeneratedImage, AspectRatioOption, ModelOption } from "../types";
import { getDimensions } from "./dimensions";
import { generateUUID } from "./utils";
import { useConfigStore } from "../store/configStore";
import { runWithTokenRetry } from "./tokenRetry";

// Token retry delegates to the shared service.
const runWithAgnesTokenRetry = <T>(
  operation: (token: string) => Promise<T>,
): Promise<T> => {
  return runWithTokenRetry(
    "agnes",
    operation as (token: string | null) => Promise<T>,
  );
};

const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
const DEFAULT_TEXT_MODEL = "agnes-2.0-flash";
const DEFAULT_IMAGE_MODEL = "agnes-image-2.1-flash";
const DEFAULT_VIDEO_MODEL = "agnes-video-v2.0";

const cleanUrl = (url: string) => url.replace(/\/+$/, "");

const getBaseUrl = (): string =>
  cleanUrl(useConfigStore.getState().agnesConfig.apiUrl || DEFAULT_BASE_URL);

// Ensure a base64 string is a proper image Data URI.
const toImageDataUri = (image: string): string => {
  if (image.startsWith("data:")) {
    return image.replace(/^data:([^;]*);base64,/, (match, mimeType) =>
      mimeType && mimeType.startsWith("image/")
        ? match
        : "data:image/png;base64,",
    );
  }
  if (/^https?:\/\//.test(image)) return image;
  return `data:image/png;base64,${image}`;
};

const handleAgnesApiError = async (
  response: Response,
  operationType: string,
): Promise<never> => {
  const errData = await response.json().catch(() => ({}));
  throw new Error(
    errData.error?.message ||
      errData.message ||
      `Agnes ${operationType} API Error: ${response.status}`,
  );
};

// --- Text (prompt optimization) ---
export const optimizePromptAgnes = async (
  prompt: string,
  model: string,
): Promise<string> => {
  return runWithAgnesTokenRetry(async (token) => {
    const baseUrl = getBaseUrl();
    const actualModel = !model || model === "default" ? DEFAULT_TEXT_MODEL : model;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: actualModel,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      await handleAgnesApiError(response, "Text");
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text) {
      throw new Error("error_invalid_response");
    }
    return text;
  });
};

// --- Image (generation + editing) ---
export const generateAgnesImage = async (
  model: ModelOption,
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  steps?: number,
  enableHD: boolean = false,
  guidanceScale?: number,
  base64Image?: string | string[],
): Promise<GeneratedImage> => {
  return runWithAgnesTokenRetry(async (token) => {
    const baseUrl = getBaseUrl();
    const { agnesConfig } = useConfigStore.getState();
    const actualModel =
      !model || model === "default" ? agnesConfig.modelId || DEFAULT_IMAGE_MODEL : model;

    const { width, height } = getDimensions(aspectRatio, enableHD);
    const sizeString = `${width}x${height}`;

    const imageArray = Array.isArray(base64Image)
      ? base64Image
      : base64Image
        ? [base64Image]
        : [];

    const requestBody: Record<string, unknown> = {
      model: actualModel,
      prompt,
      size: sizeString,
    };
    if (seed !== undefined) requestBody.seed = seed;

    if (imageArray.length > 0) {
      const images = imageArray.map(toImageDataUri);
      // img2img passes a single image, compose passes the array.
      requestBody.extra_body = {
        image: images.length === 1 ? images[0] : images,
        response_format: "b64_json",
      };
      if (actualModel === "agnes-image-2.0-flash") {
        requestBody.tags = ["img2img"];
      }
    }

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      await handleAgnesApiError(response, "Image");
    }

    const data = await response.json();
    const entry = Array.isArray(data.data) ? data.data[0] : undefined;
    let imageUrl: string | undefined;
    if (entry && typeof entry === "object") {
      if (typeof entry.url === "string") {
        imageUrl = entry.url;
      } else if (typeof entry.b64_json === "string") {
        imageUrl = `data:image/png;base64,${entry.b64_json.replace(/^data:image\/\w+;base64,/, "")}`;
      }
    }
    if (!imageUrl && typeof data.url === "string") imageUrl = data.url;

    if (!imageUrl) {
      console.error("Unrecognized Agnes image response format", data);
      throw new Error("error_invalid_response");
    }

    return {
      id: generateUUID(),
      url: imageUrl,
      model: actualModel,
      prompt,
      aspectRatio,
      timestamp: Date.now(),
      seed,
      steps,
      guidanceScale,
      provider: "agnes",
    };
  });
};

// --- Video (image-to-video, asynchronous) ---

// Snap a desired frame count to the nearest valid Agnes value (8n + 1, capped at 441).
const normalizeNumFrames = (frames: number): number => {
  const clamped = Math.max(9, Math.min(441, Math.round(frames)));
  const n = Math.round((clamped - 1) / 8);
  return Math.max(9, Math.min(441, n * 8 + 1));
};

const toEvenDimension = (value: number, fallback: number): number => {
  const v = Math.round(value || fallback);
  return v % 2 === 0 ? v : v - 1;
};

export const generateAgnesVideo = async (
  model: string,
  imageDataUrl: string,
  prompt: string,
  duration: number,
  seed: number,
  frameRate: number = 24,
  width?: number,
  height?: number,
): Promise<{ taskId?: string; videoId?: string }> => {
  return runWithAgnesTokenRetry(async (token) => {
    const baseUrl = getBaseUrl();
    const actualModel =
      !model || model === "default" ? DEFAULT_VIDEO_MODEL : model;

    const fr = Math.max(1, Math.min(60, Math.round(frameRate)));
    const numFrames = normalizeNumFrames((duration || 3) * fr);

    const body: Record<string, unknown> = {
      model: actualModel,
      prompt,
      width: toEvenDimension(width ?? 1152, 1152),
      height: toEvenDimension(height ?? 768, 768),
      num_frames: numFrames,
      frame_rate: fr,
      seed,
      image: toImageDataUri(imageDataUrl),
    };

    const response = await fetch(`${baseUrl}/videos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      await handleAgnesApiError(response, "Video");
    }

    const data = await response.json();
    const taskId =
      typeof data.task_id === "string"
        ? data.task_id
        : typeof data.id === "string"
          ? data.id
          : undefined;
    const videoId =
      typeof data.video_id === "string"
        ? data.video_id
        : typeof data.id === "string" && data.id.startsWith("video_")
          ? data.id
          : undefined;

    if (!taskId && !videoId) {
      throw new Error("Agnes video response did not include a task or video id");
    }

    return { taskId, videoId };
  });
};

const buildVideoPollUrl = (baseUrl: string, id: string): string => {
  if (id.startsWith("task_")) {
    return `${baseUrl}/videos/${encodeURIComponent(id)}`;
  }
  const origin = new URL(baseUrl).origin;
  return `${origin}/agnesapi?video_id=${encodeURIComponent(id)}`;
};

const extractVideoUrl = (record: Record<string, any>): string | undefined => {
  const candidates = [
    record.video_url,
    record.url,
    record.output_url,
    record.result?.video_url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

export const getAgnesTaskStatus = async (
  id: string,
): Promise<{ status: string; videoUrl?: string; error?: string }> => {
  const baseUrl = getBaseUrl();
  const token =
    useConfigStore.getState().tokens.agnes?.find(Boolean) || undefined;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const response = await fetch(buildVideoPollUrl(baseUrl, id), {
      method: "GET",
      headers,
    });

    if (!response.ok) throw new Error("Failed to check task status");

    const data = await response.json();
    const rawStatus =
      typeof data.status === "string" ? data.status : "in_progress";

    if (rawStatus === "completed") {
      const videoUrl = extractVideoUrl(data);
      if (!videoUrl) {
        return { status: "failed", error: "Completed task missing video URL" };
      }
      return { status: "success", videoUrl };
    }
    if (rawStatus === "failed") {
      return { status: "failed", error: data.error || "Video generation failed" };
    }
    return { status: "processing" };
  } catch (error: any) {
    console.error("Check Agnes Task Status Error:", error);
    return { status: "error", error: error.message };
  }
};
