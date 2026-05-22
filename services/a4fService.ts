import { GeneratedImage, AspectRatioOption, ModelOption } from "../types";
import { getDimensions } from "./dimensions";
import {
  generateUUID,
  getSystemPromptContent,
  FIXED_SYSTEM_PROMPT_SUFFIX,
} from "./utils";
import { API_MODEL_MAP } from "../constants";

import { runWithTokenRetry } from "./tokenRetry";

const A4F_BASE_URL = "/a4f-api/";
const A4F_GENERATE_API_URL = `${A4F_BASE_URL}v1/images/generations`;
const A4F_CHAT_API_URL = `${A4F_BASE_URL}v1/chat/completions`;

// Token retry delegates to shared service
const runWithA4FTokenRetry = <T>(
  operation: (token: string) => Promise<T>,
): Promise<T> => {
  return runWithTokenRetry(
    "a4f",
    operation as (token: string | null) => Promise<T>,
  );
};

// --- Service Logic ---

export const generateA4FImage = async (
  model: ModelOption,
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  steps?: number,
  enableHD: boolean = false,
  guidanceScale?: number,
): Promise<GeneratedImage> => {
  const { width, height } = getDimensions(aspectRatio, enableHD);
  const sizeString = `${width}x${height}`;

  // A4F generally ignores seed for some models via API but we pass n=1
  // steps/guidance might not be supported in standard OpenAI image format, but we'll try standard payload

  const apiModel = API_MODEL_MAP.a4f[model];
  if (!apiModel) {
    throw new Error(`Model ${model} not supported on A4F`);
  }

  return runWithA4FTokenRetry(async (token) => {
    try {
      const requestBody: any = {
        model: apiModel,
        prompt,
        n: 1,
        size: sizeString,
        response_format: "url",
      };

      const response = await fetch(A4F_GENERATE_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          errData.error?.message || `A4F API Error: ${response.status}`,
        );
      }

      const data = await response.json();

      const imageUrl = data.data?.[0]?.url;

      if (!imageUrl) {
        throw new Error("error_invalid_response");
      }

      return {
        id: generateUUID(),
        url: imageUrl,
        model,
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed: seed, // A4F might not return seed
        steps: steps,
        guidanceScale,
        provider: "a4f",
      };
    } catch (error) {
      console.error("A4F Image Generation Error:", error);
      throw error;
    }
  });
};

export const optimizePromptA4F = async (
  originalPrompt: string,
  model: string = "gemini-2.5-flash-lite",
): Promise<string> => {
  return runWithA4FTokenRetry(async (token) => {
    try {
      const systemInstruction =
        getSystemPromptContent() + FIXED_SYSTEM_PROMPT_SUFFIX;
      const apiModel = API_MODEL_MAP.a4f[model] || model;

      const response = await fetch(A4F_CHAT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
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
          temperature: 0.7,
          max_tokens: 1000,
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
      console.error("A4F Prompt Optimization Error:", error);
      throw error;
    }
  });
};
