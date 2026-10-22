import { GeneratedImage, AspectRatioOption, ModelOption } from "../types";
import { getDimensions } from "./dimensions";
import {
  generateUUID,
  getSystemPromptContent,
  FIXED_SYSTEM_PROMPT_SUFFIX,
  getVideoSettings,
  fetchBlob,
} from "./utils";
import { fetchCloudBlob } from "./storageService";
import { API_MODEL_MAP } from "../constants";

import { runWithTokenRetry } from "./tokenRetry";

const ZIMAGE_BASE_API_URL = "https://mrfakename-z-image-turbo.hf.space";
const ZIMAGE_MODEL_BASE_API_URL = "https://mrfakename-z-image.hf.space";
// Qwen Image 2.1 (unified text-to-image + editing) and Qwen Image 2.1 Turbo.
//
// Primary Space (mrfakename/qwen-image-2-1): community deployment of the
// same checkpoint, driven via the raw queue API. Its generate() signature is
// (prompt, reference_images, transparent, aspect_ratio, resolution, steps,
// true_cfg_scale, negative_prompt, seed, randomize_seed) — prompt FIRST,
// gallery second. The edit path historically sent those two swapped, which
// crashed the ZeroGPU worker at function entry ({"error": null}, no detail)
// and looked exactly like a Space outage; fixed 2026-10-16. Text-to-image
// through this Space was never affected.
const QWEN_IMAGE_21_BASE_API_URL = "https://mrfakename-qwen-image-2-1.hf.space";
// Fallback Space: HF's own hardened deployment of the same checkpoint —
// single-call /generate named API, AOTI-compiled kernels, and a fitted
// dynamic ZeroGPU booking (verified: 40-step 1K edit in ~23s, anonymous).
// Used automatically when the primary Space fails for non-quota reasons.
const HUGGING_APPS_QWEN21_BASE_API_URL =
  "https://hugging-apps-qwen-image-2-1.hf.space";
const QWEN_IMAGE_21_TURBO_BASE_API_URL =
  "https://lpkramit-qwen-image-2-1-turbo.hf.space";
// The Space was moved from aidc-ai/ovis-image-7b (its old domain now 404s on
// every route) to ATH-MaaS/Ovis-Image-7B; only the host changed — the API
// layout still matches: fn_index 2 = generate with
// (prompt, img_height, img_width, seed, steps, guidance_scale).
const OVIS_IMAGE_BASE_API_URL = "https://ath-maas-ovis-image-7b.hf.space";
const FLUX_SCHNELL_BASE_API_URL =
  "https://black-forest-labs-flux-1-schnell.hf.space";
// Upscaler Space (verified live 2026-10-21/22). Replaces tuan2308/upscaler,
// which was deleted/privatised (every route 404s). Real-ESRGAN-family 4x
// super-resolution on ZeroGPU: 744x704 -> 2976x2816 in ~4-9s for every model
// on its dropdown, usable with free/anonymous quota (unlike
// prithivMLmods/PiD-Image-Upscaler, whose xlarge 90s booking is refused for
// non-PRO accounts).
const UPSCALER_BASE_API_URL = "https://upsampler-media-upscaler.hf.space";
const POLLINATIONS_API_URL = "https://text.pollinations.ai/openai";
const WAN2_VIDEO_API_URL =
  "https://fradeck619-wan2-2-fp8da-aoti-faster.hf.space";

const Z_IMAGE_NEGATIVE_PROMPT =
  "worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, malformed limbs, fused fingers, cluttered background, three legs";

const QUOTA_ERROR_KEY = "error_quota_exhausted";

// Token retry delegates to shared service
const runWithHFTokenRetry = <T>(
  operation: (token: string | null) => Promise<T>,
): Promise<T> => {
  return runWithTokenRetry("huggingface", operation);
};

// --- Gradio File Upload Helper ---

export const uploadToGradio = async (
  baseUrl: string,
  image: string | Blob,
  token: string | null,
  signal?: AbortSignal,
): Promise<string> => {
  const formData = new FormData();
  formData.append("files", image);

  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}/gradio_api/upload`, {
    method: "POST",
    headers,
    body: formData,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload image to Gradio: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result || !result[0]) {
    throw new Error("Invalid upload response from Gradio");
  }

  return result[0]; // Returns the filename/path relative to the Gradio space
};

// --- Gradio Queue Helper (New Logic) ---

interface GradioPayload {
  data: any[];
  fn_index: number;
  trigger_id: number | null;
  session_hash: string;
  event_data: null;
}

const runGradioTask = async <T>(
  baseUrl: string,
  data: any[],
  fn_index: number,
  trigger_id: number | null,
  token: string | null,
  signal?: AbortSignal,
): Promise<T> => {
  // Unique per attempt: rapid retries within the same millisecond must not
  // attach to a previous job's session stream.
  const session_hash =
    Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);

  // 1. Join Queue
  const payload: GradioPayload = {
    data,
    fn_index,
    trigger_id,
    session_hash,
    event_data: null,
  };

  const joinResponse = await fetch(`${baseUrl}/gradio_api/queue/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!joinResponse.ok) {
    // Handle 429 or other errors as quota exhausted if applicable
    if (joinResponse.status === 429) throw new Error(QUOTA_ERROR_KEY);
    throw new Error(`Gradio Join Error: ${joinResponse.status}`);
  }

  // 2. Listen for Result via SSE
  // NOTE: no Authorization header here — the booking identity is established
  // by the join request above. An authenticated SSE connection has been
  // observed to coincide with ZeroGPU runs failing without any error detail.
  const sseResponse = await fetch(
    `${baseUrl}/gradio_api/queue/data?session_hash=${session_hash}`,
    {
      headers: {
        Accept: "text/event-stream",
      },
      signal,
    },
  );

  if (!sseResponse.ok) {
    if (sseResponse.status === 429) throw new Error(QUOTA_ERROR_KEY);
    throw new Error(`Gradio SSE Error: ${sseResponse.status}`);
  }

  const reader = sseResponse.body?.getReader();
  if (!reader) throw new Error("No response body from Gradio stream");

  const decoder = new TextDecoder();
  let buffer = "";
  const seenMessages: Record<string, number> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep partial line for next chunk

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        let msg: any;
        try {
          msg = JSON.parse(jsonStr);
        } catch {
          continue; // ignore non-JSON chunks
        }
        // The queue stream also emits bare `data: null` heartbeats; guard
        // before dereferencing so they cannot throw a TypeError here.
        if (msg === null || typeof msg !== "object") continue;
        seenMessages[msg.msg] = (seenMessages[msg.msg] || 0) + 1;

        // NOTE: failure handling must NOT live inside a try/catch that also
        // covers JSON parsing — a thrown error without ":"/"failed" in its
        // message used to be swallowed here and misreported as a closed
        // stream, hiding the real Space-side failure.
        if (msg.msg === "process_completed") {
          if (msg.success) {
            return msg.output as T;
          }
          // Enhanced Error Handling based on HF Data Structure
          const output = msg.output || {};
          // HF typical error detail key is " ", or "error"
          const detail = output[" "] || output.error || "";
          const title =
            msg.title || output.title || "Gradio task process failed";
          const fullMessage = detail ? `${title}: ${detail}` : title;
          // Keep the raw payload: ZeroGPU failures sometimes carry no detail
          console.warn(
            "[hfService] Gradio process_completed (failure):",
            jsonStr,
          );

          // Check if this is a quota error to trigger token rotation
          if (
            fullMessage.includes("exceeded your free") ||
            fullMessage.includes("quota") ||
            fullMessage.includes("limit")
          ) {
            throw new Error(QUOTA_ERROR_KEY);
          }

          // A failure with no detail means the Space's ZeroGPU worker died
          // without raising an exception: a startup crash (e.g. broken
          // deploy/dependency), an OOM kill, or a booked-time overrun. It is
          // a Space-side problem, not a client or payload bug.
          throw new Error(
            detail
              ? fullMessage
              : `${fullMessage} (no details returned by the Space — its worker died; the Space is likely broken right now. Retrying or switching models may help)`,
          );
        }

        // Gradio 6 can deliver hard failures as a distinct message type
        if (msg.msg === "process_error") {
          console.warn("[hfService] Gradio process_error:", jsonStr);
          const detail =
            msg.output?.error || msg.output?.message || "unknown error";
          throw new Error(`Gradio task error: ${detail}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error(
    `Gradio stream closed without result (messages seen: ${
      Object.keys(seenMessages).join(", ") || "none"
    })`,
  );
};

// --- Gradio Named-Call Helper ---
// Spaces that expose a named API ("api_name=...") also accept a positional
// form, which every Gradio generation we have met understands:
//   POST /gradio_api/call/<api_name>  body {"data": [v1, v2, ...]} -> {event_id}
//   GET  /gradio_api/call/<api_name>/<event_id>                    -> SSE
// The stream ends with either a bare `data: [...outputs]` array (success) or
// `data: {"error": ..., "title": ...}` (failure; `error` is null when the
// Space's worker was killed outright).
//
// Gradio 6 additionally serves a /call/v2/<api_name> route taking a flat
// {param: value, ...} object, but older deployments answer it with 405. We
// deliberately use the positional form for everything: probing v2 first would
// log a 405 in the browser console on every single request against an older
// Space (noisy, and it looks like a failure even though the retry succeeds).
//
// Verified live (2026-10-20): the positional form is accepted by the older
// Gradio on mrfakename/z-image (full generation) and by Gradio 6 on
// hugging-apps/qwen-image-2-1 and mrfakename/z-image-turbo (join accepted,
// same event_id/SSE contract). Consequently `params` properties MUST be
// written in the endpoint's signature order — Object.values sends them
// positionally.
const runGradioNamedTask = async <T>(
  baseUrl: string,
  apiName: string,
  params: Record<string, unknown>,
  token: string | null,
  signal?: AbortSignal,
): Promise<T> => {
  const joinResponse = await fetch(`${baseUrl}/gradio_api/call/${apiName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data: Object.values(params) }),
    signal,
  });

  if (!joinResponse.ok) {
    if (joinResponse.status === 429) throw new Error(QUOTA_ERROR_KEY);
    throw new Error(`Gradio Join Error: ${joinResponse.status}`);
  }

  const joinResult = await joinResponse.json();
  const eventId = joinResult?.event_id;
  if (!eventId) throw new Error("Gradio Join Error: no event id returned");

  // No Authorization header here — as with runGradioTask, the ZeroGPU booking
  // is established by the join request above; an authenticated SSE stream
  // has been observed to coincide with ZeroGPU runs failing without detail.
  const sseResponse = await fetch(
    `${baseUrl}/gradio_api/call/${apiName}/${eventId}`,
    {
      headers: {
        Accept: "text/event-stream",
      },
      signal,
    },
  );

  if (!sseResponse.ok) {
    if (sseResponse.status === 429) throw new Error(QUOTA_ERROR_KEY);
    throw new Error(`Gradio SSE Error: ${sseResponse.status}`);
  }

  const reader = sseResponse.body?.getReader();
  if (!reader) throw new Error("No response body from Gradio stream");

  const decoder = new TextDecoder();
  let buffer = "";
  const seenMessages: Record<string, number> = {};
  // Older Gradio reports a rejected run as `event: error` followed by a bare
  // `data: null`, carrying no message at all. Track it so the stream closing
  // can be reported as a failure rather than "no result".
  let sawErrorEvent = false;
  let lastEvent = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep partial line for next chunk

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          lastEvent = line.slice(7).trim();
          if (lastEvent === "error") sawErrorEvent = true;
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        let msg: any;
        try {
          msg = JSON.parse(jsonStr);
        } catch {
          continue; // ignore non-JSON chunks
        }
        if (msg === null || typeof msg !== "object") continue; // heartbeats

        // Failure envelope: {"error": "...", "title": "Error"}. `error` may be
        // null/absent of detail when the Space's worker was killed outright.
        if (msg.error !== undefined || msg.msg === "process_error") {
          console.warn(
            "[hfService] Gradio named-call failure:",
            jsonStr,
          );
          const detail =
            (typeof msg.error === "string" && msg.error) ||
            msg.output?.error ||
            "";
          const title = msg.title || "Gradio task failed";
          const fullMessage = detail ? `${title}: ${detail}` : title;

          if (
            fullMessage.includes("exceeded your free") ||
            fullMessage.includes("quota") ||
            fullMessage.includes("limit")
          ) {
            throw new Error(QUOTA_ERROR_KEY);
          }

          throw new Error(
            detail
              ? fullMessage
              : `${fullMessage} (no details returned by the Space — its worker died; the Space is likely broken right now. Retrying or switching models may help)`,
          );
        }

        // Queue-protocol messages (msg-based) — tolerated for compatibility
        // with Spaces that emit the queue event shapes on named endpoints.
        if (msg.msg) {
          seenMessages[msg.msg] = (seenMessages[msg.msg] || 0) + 1;
          if (msg.msg === "process_completed") {
            if (msg.success) return msg.output as T;
            throw new Error(
              msg.title || "Gradio task process failed",
            );
          }
          continue;
        }

        // Success envelope: the bare outputs array.
        if (Array.isArray(msg)) return { data: msg } as T;
      }
    }
  } finally {
    reader.releaseLock();
  }

  // A detail-less `event: error` is how the older Gradio reports a run it
  // refused to start; in practice the ZeroGPU quota of the current identity,
  // though a Space-side crash looks identical. Report it as a descriptive
  // failure (not QUOTA_ERROR_KEY) so a configured fallback Space still gets a
  // chance to serve the request — the fallback runs newer Gradio and reports
  // an explicit quota message, which then drives token rotation.
  if (sawErrorEvent) {
    console.warn(
      "[hfService] Gradio named-call rejected the run without details" +
        (lastEvent ? ` (last event: ${lastEvent})` : ""),
    );
    throw new Error(
      "Gradio task rejected without details (the Space may have exhausted this identity's GPU allowance, or its worker failed)",
    );
  }

  throw new Error(
    `Gradio stream closed without result (messages seen: ${
      Object.keys(seenMessages).join(", ") || "none"
    })`,
  );
};

// True when a failed request should be retried on the backup Space: any
// error except a user abort (nothing to retry) and a quota error (the backup
// would burn the same visitor's ZeroGPU quota — let token rotation decide).
const shouldFailOver = (error: any): boolean => {
  if (error?.name === "AbortError") return false;
  const message: string = error?.message || "";
  return !(
    message === QUOTA_ERROR_KEY ||
    message.includes("quota") ||
    message.includes("exceeded your free")
  );
};

// --- Service Logic ---

// Build a fetchable URL from a Gradio image output. Newer Spaces may omit
// the `url` field and return only the server-local `path` (the ImageData
// schema documents "For output, path is always provided"), so reconstruct
// the file URL from the path when needed.
const gradioFileUrl = (item: any, baseUrl: string): string | undefined => {
  if (typeof item === "string") return item;
  const file = item?.image ?? item;
  if (file?.url) return file.url;
  if (file?.path) return `${baseUrl}/gradio_api/file=${file.path}`;
  return undefined;
};

// Pull the image URL out of a Gradio output array. Tolerates both shapes seen
// in the wild: a flat FileData for image outputs and the nested gallery form
// ({image: FileData, caption}) that some Spaces return for the same slot.
const gradioOutputUrl = (data: any, baseUrl: string): string | undefined => {
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = Array.isArray(data[0]) ? data[0][0] : data[0];
  return gradioFileUrl(first, baseUrl);
};

const generateZImageModel = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed: number = Math.round(Math.random() * 2147483647),
  steps: number = 30,
  guidanceScale: number = 4,
  enableHD: boolean = false,
): Promise<GeneratedImage> => {
  const { width, height } = getDimensions(aspectRatio, enableHD);

  return runWithHFTokenRetry(async (token) => {
    try {
      // Named API (verified 2026-10-19). The space's UI rework shifted its
      // dependency numbering, so the old hard-coded fn_index 2 now points at
      // the _start_timer helper — the positional call returned timer values
      // instead of an image (surfaced as error_invalid_response). Named
      // endpoints are immune to that kind of drift.
      //
      // This space also runs an older Gradio: the v2 named-call route is
      // absent (405) and runGradioNamedTask transparently resends the args
      // positionally via /call/generate_image (verified live; property order
      // above must mirror the endpoint signature).
      const output: any = await runGradioNamedTask(
        ZIMAGE_MODEL_BASE_API_URL,
        "generate_image",
        {
          prompt,
          negative_prompt: Z_IMAGE_NEGATIVE_PROMPT,
          height,
          width,
          num_inference_steps: steps,
          guidance_scale: guidanceScale,
          seed,
          randomize_seed: false, // the client always resolves the seed itself
        },
        token,
      );

      const data = output.data;
      if (!data || !data[0]) throw new Error("error_invalid_response");

      // Output: [ImageData (path|url), seedUsed]
      const url = Array.isArray(data[0])
        ? gradioFileUrl(data[0][0], ZIMAGE_MODEL_BASE_API_URL)
        : gradioFileUrl(data[0], ZIMAGE_MODEL_BASE_API_URL);
      if (!url) throw new Error("error_invalid_response");

      return {
        id: generateUUID(),
        url,
        model: "z-image",
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed,
        steps,
        guidanceScale,
      };
    } catch (error) {
      console.error("Z-Image Generation Error:", error);
      throw error;
    }
  });
};

const generateZImage = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed: number = Math.round(Math.random() * 2147483647),
  enableHD: boolean = false,
  steps: number = 9,
): Promise<GeneratedImage> => {
  const { width, height } = getDimensions(aspectRatio, enableHD);

  return runWithHFTokenRetry(async (token) => {
    try {
      // Named API (verified 2026-10-19): fn_index 2 became the _start_timer
      // helper after the space's UI rework — see generateZImageModel above.
      const output: any = await runGradioNamedTask(
        ZIMAGE_BASE_API_URL,
        "generate_image",
        {
          prompt,
          height,
          width,
          num_inference_steps: steps,
          seed,
          randomize_seed: false, // the client always resolves the seed itself
        },
        token,
      );

      const data = output.data;
      if (!data || !data[0]) throw new Error("error_invalid_response");

      // Output: [ImageData (path|url), seedUsed]
      const url = Array.isArray(data[0])
        ? gradioFileUrl(data[0][0], ZIMAGE_BASE_API_URL)
        : gradioFileUrl(data[0], ZIMAGE_BASE_API_URL);
      if (!url) throw new Error("error_invalid_response");

      // Extract seed from data[1] if available
      const returnedSeed = typeof data[1] === "number" ? data[1] : seed;

      return {
        id: generateUUID(),
        url,
        model: "z-image-turbo",
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed: returnedSeed,
        steps,
      };
    } catch (error) {
      console.error("Z-Image Turbo Generation Error:", error);
      throw error;
    }
  });
};

const generateFluxSchnellImage = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed: number = Math.round(Math.random() * 2147483647),
  enableHD: boolean = false,
  steps: number = 4,
): Promise<GeneratedImage> => {
  const { width, height } = getDimensions(aspectRatio, enableHD);

  return runWithHFTokenRetry(async (token) => {
    try {
      // Data: ["Prompt", Seed, Randomize seed (false), Width, Height, steps]
      const output: any = await runGradioTask(
        FLUX_SCHNELL_BASE_API_URL,
        [prompt, seed, false, width, height, steps],
        2, // fn_index
        5, // trigger_id
        token,
      );

      const data = output.data;
      const url = gradioOutputUrl(data, FLUX_SCHNELL_BASE_API_URL);
      if (!url) throw new Error("error_invalid_response");

      return {
        id: generateUUID(),
        url,
        model: "flux-1-schnell",
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed,
        steps,
      };
    } catch (error) {
      console.error("Flux Schnell Generation Error:", error);
      throw error;
    }
  });
};

// --- Qwen Image 2.1 (mrfakename/qwen-image-2-1) ---
// API "generate" (fn_index 1):
// [prompt, reference_images(gallery|null), transparent, aspect_ratio, resolution,
//  num_inference_steps, true_cfg_scale, negative_prompt, seed, randomize_seed]

// Aspect keys accepted by the Qwen Image 2.1 spaces, with their ratios
const QWEN21_ASPECT_KEYS: [string, number][] = [
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

const nearestQwen21Aspect = (width: number, height: number): string => {
  const ratio = width / Math.max(height, 1);
  let best = "1:1";
  let bestDiff = Infinity;
  for (const [key, value] of QWEN21_ASPECT_KEYS) {
    // Log-space distance: unbiased towards wide ratios
    const diff = Math.abs(Math.log(ratio / value));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
};

// The LEGACY space (mrfakename/qwen-image-2-1) books ~60s of GPU per run and
// estimates duration from the passed resolution only. Large outputs with many
// steps overrun the booking and ZeroGPU kills the run mid-flight (surfaced as
// {"error": null} with no detail). Cost ~0.5s/step at 1MP (measured: 16.3s
// for 40 steps @1024), so cap steps to a ~45s budget (+~8s fixed overhead
// stays under the booking). The hugging-apps primary space books dynamically
// from a fitted cost model instead, but the same cap keeps its reservation
// well inside the free-tier per-task duration limit.
const qwen21SafeSteps = (steps: number, resolution: number): number => {
  const budget = Math.floor(45 / (0.5 * Math.pow(resolution / 1024, 2)));
  return Math.max(10, Math.min(steps, budget));
};

// Re-encode an arbitrary image blob into a 3-channel JPEG (≤2048 long side,
// alpha flattened onto white). The space does no image-mode conversion of its
// own and crashes on 4-channel (RGBA) conditioning — canvas PNG exports are
// always RGBA, so JPEG is the only canvas export that guarantees true RGB.
// Falls back to the original blob when the input is not decodable as an image.
const normalizeImageForGradio = async (blob: Blob): Promise<Blob> => {
  try {
    const bitmap = await createImageBitmap(blob);
    const maxSide = 2048;
    const scale = Math.min(
      1,
      maxSide / Math.max(bitmap.width, bitmap.height),
    );
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return blob;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    return out || blob;
  } catch {
    return blob;
  }
};

// Fallback: HF's own hugging-apps/qwen-image-2-1 space. Single-call /generate
// API — a null gallery makes it text-to-image. Same checkpoint as the primary
// space, but with AOTI kernels and a fitted dynamic ZeroGPU booking.
const generateQwenImage21ViaHuggingApps = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  finalSeed: number,
  steps: number,
  negativePrompt: string | undefined,
  guidanceScale: number | undefined,
  enableHD: boolean,
  token: string | null,
  signal?: AbortSignal,
): Promise<GeneratedImage> => {
  const neg = (negativePrompt || "").trim();
  // The space only applies true CFG when a negative prompt is present
  const trueCfg = neg && guidanceScale ? guidanceScale : 1;
  const resolution = enableHD ? 2048 : 1024;
  const effSteps = qwen21SafeSteps(steps, resolution);

  const output: any = await runGradioNamedTask(
    HUGGING_APPS_QWEN21_BASE_API_URL,
    "generate",
    {
      prompt,
      input_images: null, // no reference images -> text-to-image
      negative_prompt: neg,
      true_cfg_scale: trueCfg,
      num_inference_steps: effSteps,
      seed: finalSeed,
      resolution,
      aspect_ratio: aspectRatio,
    },
    token,
    signal,
  );

  const data = output.data;
  const url = gradioOutputUrl(data, HUGGING_APPS_QWEN21_BASE_API_URL);
  if (!url) throw new Error("error_invalid_response");

  return {
    id: generateUUID(),
    url,
    model: "qwen-image-2.1",
    prompt,
    aspectRatio,
    timestamp: Date.now(),
    seed: typeof data[1] === "number" ? data[1] : finalSeed,
    steps: effSteps,
    ...(trueCfg > 1 ? { guidanceScale: trueCfg } : {}),
  };
};

// Primary: the original community space via the queue/join protocol — the
// endpoint this model option was originally built against and which has
// always worked for text-to-image (only the edit payload was ever broken).
const generateQwenImage21ViaLegacySpace = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  finalSeed: number,
  steps: number,
  negativePrompt: string | undefined,
  guidanceScale: number | undefined,
  enableHD: boolean,
  token: string | null,
  signal?: AbortSignal,
): Promise<GeneratedImage> => {
  const neg = (negativePrompt || "").trim();
  const trueCfg = neg && guidanceScale ? guidanceScale : 1;
  const resolution = enableHD ? 2048 : 1024;
  const effSteps = qwen21SafeSteps(steps, resolution);

  const output: any = await runGradioTask(
    QWEN_IMAGE_21_BASE_API_URL,
    [
      prompt,
      null, // reference_images: none for text-to-image
      false, // transparent (RGBA wrapper)
      aspectRatio,
      resolution,
      effSteps,
      trueCfg,
      neg,
      finalSeed,
      false, // randomize_seed: the client always resolves the seed itself
    ],
    1, // fn_index: "generate" button dependency
    null, // trigger_id (optional on Gradio 6)
    token,
    signal,
  );

  const data = output.data;
  const url = gradioOutputUrl(data, QWEN_IMAGE_21_BASE_API_URL);
  if (!url) throw new Error("error_invalid_response");

  return {
    id: generateUUID(),
    url,
    model: "qwen-image-2.1",
    prompt,
    aspectRatio,
    timestamp: Date.now(),
    seed: typeof data[1] === "number" ? data[1] : finalSeed,
    steps: effSteps,
    ...(trueCfg > 1 ? { guidanceScale: trueCfg } : {}),
  };
};

const generateQwenImage21 = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  steps: number = 40,
  negativePrompt?: string,
  guidanceScale?: number,
  enableHD: boolean = false,
): Promise<GeneratedImage> => {
  const finalSeed = seed ?? Math.round(Math.random() * 2147483647);

  return runWithHFTokenRetry(async (token) => {
    try {
      return await generateQwenImage21ViaLegacySpace(
        prompt,
        aspectRatio,
        finalSeed,
        steps,
        negativePrompt,
        guidanceScale,
        enableHD,
        token,
      );
    } catch (error) {
      console.error("Qwen Image 2.1 Generation Error:", error);
      if (!shouldFailOver(error)) throw error;
      console.warn(
        "[hfService] qwen-image-2.1 primary space failed; retrying on hugging-apps space",
      );
      return await generateQwenImage21ViaHuggingApps(
        prompt,
        aspectRatio,
        finalSeed,
        steps,
        negativePrompt,
        guidanceScale,
        enableHD,
        token,
      );
    }
  });
};

// --- Qwen Image 2.1 Turbo (lpkramit/qwen-image-2-1-turbo) ---
// Named API "generate": [prompt, reference(image|null), aspect, quality, seed, randomize]
// Official Turbo checkpoint with a fixed 8-step schedule; no CFG / negative prompt.
const TURBO_ASPECT_LABELS: Record<string, string> = {
  "1:1": "Square · 1:1",
  "4:3": "Landscape · 4:3",
  "3:4": "Portrait · 3:4",
  "3:2": "Photo · 3:2",
  "2:3": "Portrait · 2:3",
  "16:9": "Wide · 16:9",
  "9:16": "Tall · 9:16",
  "5:4": "Landscape · 4:3", // nearest supported preset
  "4:5": "Portrait · 3:4",
};

const generateQwenImage21Turbo = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  enableHD: boolean = false,
): Promise<GeneratedImage> => {
  const finalSeed = seed ?? Math.round(Math.random() * 2147483647);
  const randomize = seed === undefined;
  const aspectLabel = TURBO_ASPECT_LABELS[aspectRatio] || "Square · 1:1";
  const quality = enableHD ? "Full · 2K" : "Fast · 1K";

  return runWithHFTokenRetry(async (token) => {
    try {
      const output: any = await runGradioTask(
        QWEN_IMAGE_21_TURBO_BASE_API_URL,
        [prompt, null, aspectLabel, quality, finalSeed, randomize],
        0, // fn_index: "generate" button dependency
        null, // trigger_id (optional on Gradio 6)
        token,
      );

      const data = output.data;
      const url = gradioOutputUrl(data, QWEN_IMAGE_21_TURBO_BASE_API_URL);
      if (!url) throw new Error("error_invalid_response");

      return {
        id: generateUUID(),
        url,
        model: "qwen-image-2.1-turbo",
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed: typeof data[1] === "number" ? data[1] : finalSeed,
        steps: 8,
      };
    } catch (error) {
      console.error("Qwen Image 2.1 Turbo Generation Error:", error);
      throw error;
    }
  });
};

const generateOvisImage = async (
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed: number = Math.round(Math.random() * 2147483647),
  enableHD: boolean = false,
  steps: number = 24,
): Promise<GeneratedImage> => {
  const { width, height } = getDimensions(aspectRatio, enableHD);

  return runWithHFTokenRetry(async (token) => {
    try {
      const output: any = await runGradioTask(
        OVIS_IMAGE_BASE_API_URL,
        [prompt, height, width, seed, steps, 4],
        2, // fn_index
        5, // trigger_id
        token,
      );

      const data = output.data;
      const url = gradioOutputUrl(data, OVIS_IMAGE_BASE_API_URL);
      if (!url) throw new Error("error_invalid_response");

      return {
        id: generateUUID(),
        url,
        model: "ovis-image",
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed,
        steps,
      };
    } catch (error) {
      console.error("Ovis Image Generation Error:", error);
      throw error;
    }
  });
};

// Fetch + normalize + upload every source blob as a Gradio gallery payload
// for a given Space. Upload paths are Space-local, so the primary and the
// fallback Space each need their own upload round-trip.
const uploadEditGallery = async (
  baseUrl: string,
  imageBlobs: (Blob | string)[],
  token: string | null,
  signal?: AbortSignal,
): Promise<any[]> => {
  const imagePayloadPromises = imageBlobs.map(async (item) => {
    let blob: Blob;
    if (typeof item === "string") {
      if (item.startsWith("opfs://")) {
        blob = await fetchCloudBlob(item);
      } else {
        blob = await fetchBlob(item);
      }
    } else {
      blob = item;
    }
    // Normalize before upload: the spaces do no image conversion of their
    // own, and exotic sources (palette/16-bit/CMYK PNG, webp, huge photos)
    // crash their pipelines. Re-encode via canvas to a plain 8-bit JPEG
    // capped at 2048 on the long side.
    blob = await normalizeImageForGradio(blob);
    console.info(
      "[hfService] edit upload:",
      blob.type,
      `${blob.size} bytes`,
    );
    const path = await uploadToGradio(baseUrl, blob, token, signal);
    // Gallery item shape: { image: FileData, caption: null }
    return {
      image: { path, meta: { _type: "gradio.FileData" } },
      caption: null,
    };
  });

  return Promise.all(imagePayloadPromises);
};

// Fallback edit endpoint: hugging-apps/qwen-image-2-1, single-call /generate
// API: (prompt, input_images, negative_prompt, true_cfg_scale,
// num_inference_steps, seed, resolution, aspect_ratio). Parameters are
// passed BY NAME, so it is immune to argument-order mistakes. It also
// screens edit prompts with a safety classifier before reserving GPU time.
//
// `resolution` is pinned to the space's tested 1K tier: measured 21.7s for 40
// steps with one reference image, and the space books GPU time from a fitted
// cost model (~27s), which stays inside the free-tier per-task duration cap
// that larger tiers would violate.
const editQwen21ViaHuggingApps = async (
  imagePayload: any[],
  prompt: string,
  width: number,
  height: number,
  steps: number,
  guidanceScale: number,
  seed: number,
  token: string | null,
  signal?: AbortSignal,
): Promise<GeneratedImage> => {
  const aspectKey = nearestQwen21Aspect(width, height);
  const effSteps = qwen21SafeSteps(steps, 1024);
  const trueCfg = guidanceScale && guidanceScale > 1 ? guidanceScale : 1;
  const params = {
    prompt,
    input_images: imagePayload,
    negative_prompt: "",
    true_cfg_scale: trueCfg,
    num_inference_steps: effSteps,
    seed,
    resolution: 1024,
    aspect_ratio: aspectKey, // explicit aspect derived from the source image
  };
  // Full call body exposed for console-side replay debugging
  (window as any).__lastEditJoin = {
    baseUrl: HUGGING_APPS_QWEN21_BASE_API_URL,
    apiName: "generate",
    data: params,
  };
  console.info(
    "[hfService] edit payload:",
    JSON.stringify({
      space: "hugging-apps/qwen-image-2-1",
      refs: imagePayload.length,
      srcDims: `${width}x${height}`,
      aspect: aspectKey,
      resolution: 1024,
      steps: effSteps,
      cfg: trueCfg,
      promptChars: prompt.length,
      promptHead: prompt.slice(0, 80),
      seed,
      uploadPath: imagePayload[0]?.image?.path,
    }),
  );

  const output: any = await runGradioNamedTask(
    HUGGING_APPS_QWEN21_BASE_API_URL,
    "generate",
    params,
    token,
    signal,
  );

  const data = output.data;
  const url = gradioOutputUrl(data, HUGGING_APPS_QWEN21_BASE_API_URL);
  if (!url) {
    throw new Error("error_invalid_response");
  }

  return {
    id: generateUUID(),
    url,
    model: "qwen-image-2.1",
    prompt,
    aspectRatio: "custom",
    timestamp: Date.now(),
    seed: typeof data[1] === "number" ? data[1] : seed,
    steps: effSteps,
    provider: "huggingface",
  };
};

// Edit via the primary (mrfakename) Space, queue/join protocol.
// "generate" endpoint argument order — prompt FIRST, gallery second:
// [prompt, reference_images, transparent, aspect_ratio, resolution,
//  steps, true_cfg_scale, negative_prompt, seed, randomize_seed]
// NOTE: this payload used to be sent as [imagePayload, prompt, ...] with
// the first two arguments swapped, which crashed the Space's worker
// instantly with {"error": null} — the very failure this whole fix
// started from. Text-to-image was never affected (it always sent the
// prompt first).
const editQwen21ViaLegacySpace = async (
  imagePayload: any[],
  prompt: string,
  width: number,
  height: number,
  steps: number,
  guidanceScale: number,
  seed: number,
  token: string | null,
  signal?: AbortSignal,
): Promise<GeneratedImage> => {
  // Derive an EXPLICIT output size from the editor's dimensions instead of
  // "Auto (match reference)": Auto lets the pipeline pick the size from the
  // reference image, so a large source with many steps overruns the space's
  // ~60s GPU booking and ZeroGPU kills the run ({"error": null}).
  const aspectKey = nearestQwen21Aspect(width, height);
  // Snap to the slider's 64-step: Gradio 6 may validate steps server-side
  const resolution = Math.min(
    2048,
    Math.max(512, Math.round(Math.sqrt(width * height) / 64) * 64),
  );
  const effSteps = qwen21SafeSteps(steps, resolution);
  const joinData = [
    prompt,
    imagePayload,
    false, // transparent
    aspectKey, // explicit aspect so the output size is predictable
    resolution, // area-equivalent side length of the source
    effSteps,
    guidanceScale && guidanceScale > 1 ? guidanceScale : 1, // true_cfg_scale
    "", // negative_prompt
    seed,
    false, // randomize_seed
  ];
  (window as any).__lastEditJoin = {
    baseUrl: QWEN_IMAGE_21_BASE_API_URL,
    fnIndex: 1,
    data: joinData,
  };

  const output: any = await runGradioTask(
    QWEN_IMAGE_21_BASE_API_URL,
    joinData,
    1, // fn_index: "generate" button dependency
    null, // trigger_id (optional on Gradio 6)
    token,
    signal,
  );

  const data = output.data;
  const url = gradioOutputUrl(data, QWEN_IMAGE_21_BASE_API_URL);
  if (!url) {
    throw new Error("error_invalid_response");
  }

  return {
    id: generateUUID(),
    url,
    model: "qwen-image-2.1",
    prompt,
    aspectRatio: "custom",
    timestamp: Date.now(),
    seed: typeof data[1] === "number" ? data[1] : seed,
    steps: effSteps,
    provider: "huggingface",
  };
};

export const editImageQwen = async (
  imageBlobs: (Blob | string)[],
  prompt: string,
  width: number,
  height: number,
  steps: number = 40,
  guidanceScale: number = 1,
  signal?: AbortSignal,
): Promise<GeneratedImage> => {
  return runWithHFTokenRetry(async (token) => {
    const seed = Math.round(Math.random() * 2147483647);

    try {
      // 1. Upload + run on the primary Space (mrfakename/qwen-image-2-1),
      //    the endpoint this feature was originally built against.
      const imagePayload = await uploadEditGallery(
        QWEN_IMAGE_21_BASE_API_URL,
        imageBlobs,
        token,
        signal,
      );
      return await editQwen21ViaLegacySpace(
        imagePayload,
        prompt,
        width,
        height,
        steps,
        guidanceScale,
        seed,
        token,
        signal,
      );
    } catch (error) {
      if (!shouldFailOver(error)) {
        console.error("Qwen Image Edit Error:", error);
        throw error;
      }
      // 2. The primary Space failed for a non-quota reason (outage, broken
      // deploy, illegal GPU duration for the account tier, ...). Retry once
      // on the hugging-apps Space before giving up.
      console.error("Qwen Image Edit Error:", error);
      console.warn(
        "[hfService] primary edit Space failed; retrying on hugging-apps Space",
      );
      try {
        const imagePayload = await uploadEditGallery(
          HUGGING_APPS_QWEN21_BASE_API_URL,
          imageBlobs,
          token,
          signal,
        );
        return await editQwen21ViaHuggingApps(
          imagePayload,
          prompt,
          width,
          height,
          steps,
          guidanceScale,
          seed,
          token,
          signal,
        );
      } catch (fallbackError) {
        console.error("Qwen Image Edit Error (hugging-apps fallback):", fallbackError);
        throw fallbackError;
      }
    }
  });
};

export const generateImage = async (
  model: ModelOption,
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  enableHD: boolean = false,
  steps?: number,
  guidanceScale?: number,
  negativePrompt?: string,
): Promise<GeneratedImage> => {
  const finalSeed = seed ?? Math.round(Math.random() * 2147483647);

  if (model === "flux-1-schnell") {
    return generateFluxSchnellImage(
      prompt,
      aspectRatio,
      finalSeed,
      enableHD,
      steps,
    );
  } else if (model === "qwen-image-2.1" || model === "qwen-image") {
    // Legacy "qwen-image" selections route to the 2.1 space
    return generateQwenImage21(
      prompt,
      aspectRatio,
      seed,
      steps,
      negativePrompt,
      guidanceScale,
      enableHD,
    );
  } else if (model === "qwen-image-2.1-turbo") {
    return generateQwenImage21Turbo(prompt, aspectRatio, seed, enableHD);
  } else if (model === "ovis-image") {
    return generateOvisImage(prompt, aspectRatio, finalSeed, enableHD, steps);
  } else if (model === "z-image") {
    return generateZImageModel(
      prompt,
      aspectRatio,
      finalSeed,
      steps,
      guidanceScale,
      enableHD,
    );
  } else {
    // Default to z-image-turbo
    return generateZImage(prompt, aspectRatio, finalSeed, enableHD, steps);
  }
};

// Upscale an image 4x through the named API:
//   /upscale_image(image, model_selection, face_enhance) -> image
// The Space answers with a PAIR [original, upscaled] (a before/after slider on
// its own UI), so the upscaled entry must be picked explicitly — taking
// data[0] would silently return the untouched input.
const UPSCALER_MODEL_NAMES = [
  "4xRealESRGAN",
  "4xSwinIRLarge",
  "4xRealHATGANSharper",
  "4xNomosWebPhotoRealPLKSR",
];

export const upscaler = async (
  url: string,
  model: string = "4xRealESRGAN",
): Promise<{ url: string }> => {
  // Configs persisted before the Space swap still hold the old model name
  // ("RealESRGAN_x4plus"); fall back to a name this Space accepts rather than
  // sending an unknown option and failing.
  const modelName = UPSCALER_MODEL_NAMES.includes(model)
    ? model
    : "4xRealESRGAN";

  // Fetch image as blob first to upload to Gradio
  const blob = await fetchBlob(url);

  return runWithHFTokenRetry(async (token) => {
    try {
      // 1. Upload to Gradio
      const filePath = await uploadToGradio(UPSCALER_BASE_API_URL, blob, token);

      // 2. Call inference (parameters are positional, in signature order)
      const output: any = await runGradioNamedTask(
        UPSCALER_BASE_API_URL,
        "upscale_image",
        {
          image: { path: filePath, meta: { _type: "gradio.FileData" } },
          model_selection: modelName,
          face_enhance: false,
        },
        token,
      );

      const data = output.data;
      const items = Array.isArray(data?.[0]) ? data[0] : data;
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error("error_invalid_response");
      }
      // Prefer the entry explicitly named "upscaled"; otherwise the last one.
      const picked =
        items.find((item: any) =>
          String(item?.orig_name ?? item?.path ?? "").includes("upscaled"),
        ) ?? items[items.length - 1];

      const resultUrl = gradioFileUrl(picked, UPSCALER_BASE_API_URL);
      if (!resultUrl) throw new Error("error_invalid_response");

      return { url: resultUrl };
    } catch (error) {
      console.error("Upscaler Error:", error);
      throw Object.assign(new Error("error_upscale_failed"), { cause: error });
    }
  });
};

export const optimizePrompt = async (
  originalPrompt: string,
  model: string = "openai-fast",
): Promise<string> => {
  try {
    // Append the fixed suffix to the user's custom system prompt
    const systemInstruction =
      getSystemPromptContent() + FIXED_SYSTEM_PROMPT_SUFFIX;
    const apiModel = API_MODEL_MAP.huggingface[model] || model;

    const response = await fetch(POLLINATIONS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: apiModel,
        messages: [
          {
            role: "system",
            content: systemInstruction,
          },
          {
            role: "user",
            content: originalPrompt,
          },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error("error_prompt_optimization_failed");
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    return content || originalPrompt;
  } catch (error) {
    console.error("Prompt Optimization Error:", error);
    throw Object.assign(new Error("error_prompt_optimization_failed"), {
      cause: error,
    });
  }
};

// --- Video Generation Services (HF) ---

const VIDEO_NEGATIVE_PROMPT =
  "Vivid colors, overexposed, static, blurry details, subtitles, style, artwork, painting, image, still, overall grayish tone, worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn face, deformed, disfigured, malformed limbs, fused fingers, still image, cluttered background, three legs, many people in the background, walking backward, Screen shaking";

export const createVideoTaskHF = async (
  imageInput: string | Blob,
  seed: number = 42,
): Promise<string> => {
  return runWithHFTokenRetry(async (token) => {
    try {
      const finalSeed = seed ?? Math.floor(Math.random() * 2147483647);
      const settings = getVideoSettings("huggingface");

      let filePath = "";

      if (typeof imageInput === "string") {
        if (imageInput.startsWith("opfs://")) {
          const blob = await fetchCloudBlob(imageInput);
          filePath = await uploadToGradio(WAN2_VIDEO_API_URL, blob, token);
        } else {
          // Assume it's a remote URL accessible by Gradio, or a path already returned by uploadToGradio
          filePath = imageInput;
        }
      } else {
        filePath = await uploadToGradio(WAN2_VIDEO_API_URL, imageInput, token);
      }

      // Call Inference using Queue
      const output: any = await runGradioTask(
        WAN2_VIDEO_API_URL,
        [
          { path: filePath, meta: { _type: "gradio.FileData" } },
          settings.prompt,
          settings.steps,
          VIDEO_NEGATIVE_PROMPT,
          settings.duration,
          settings.guidance, // 1st guidance
          settings.guidance, // 2nd guidance
          finalSeed,
          false, // Randomize seed
        ],
        0, // fn_index
        16, // trigger_id
        token,
      );

      const data = output.data;
      if (data && data[0]) {
        const vid = data[0];
        if (vid?.video?.url) return vid.video.url;
        if (vid?.url) return vid.url;
        return vid;
      }

      throw new Error("No video output returned");
    } catch (error) {
      console.error("Create Video Task HF Error:", error);
      throw error;
    }
  });
};
