import { GeneratedImage, AspectRatioOption, ModelOption } from "../types";
import { generateUUID } from "./utils";
import { getDimensions } from "./dimensions";
import { useConfigStore } from "../store/configStore";
import { runWithTokenRetry } from "./tokenRetry";

// Token retry delegates to shared service
const runWithGoogleTokenRetry = <T>(
  operation: (token: string) => Promise<T>,
): Promise<T> => {
  return runWithTokenRetry(
    "google",
    operation as (token: string | null) => Promise<T>,
  );
};

// Helper to extract base64 from Google Imagen predict responses.
const extractBase64FromGoogleImagenResponse = (data: any): string => {
  const predictions = Array.isArray(data.predictions) ? data.predictions : [];
  for (const prediction of predictions) {
    const candidates = [
      prediction?.bytesBase64Encoded,
      prediction?.bytes_base64_encoded,
      prediction?.b64_json,
      prediction?.image?.bytesBase64Encoded,
      prediction?.image?.bytes_base64_encoded,
    ];
    const base64Result = candidates.find((value) => typeof value === "string");
    if (base64Result) {
      return base64Result.replace(/^data:image\/\w+;base64,/, "");
    }
  }

  throw new Error("error_invalid_response");
};

// Helper to extract MIME type and base64 data from data URL
const extractBase64AndMimeType = (base64Image: string): { mimeType: string; base64Data: string } => {
  const mimeTypeMatch = base64Image.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/png";
  const base64Data = base64Image.replace(/^data:[^;]*;base64,/, "");
  return { mimeType, base64Data };
};

// Helper to handle Google API errors
const handleGoogleApiError = async (response: Response, operationType: string): Promise<never> => {
  const errData = await response.json().catch(() => ({}));
  throw new Error(
    errData.error?.message || `Google ${operationType} API Error: ${response.status}`
  );
};

const toGoogleImagenAspectRatio = (
  aspectRatio: AspectRatioOption,
): "1:1" | "3:4" | "4:3" | "9:16" | "16:9" => {
  if (aspectRatio === "1:1" || aspectRatio === "9:16" || aspectRatio === "16:9") {
    return aspectRatio;
  }
  const landscapeRatios: AspectRatioOption[] = ["3:2", "4:3", "5:4"];
  return landscapeRatios.includes(aspectRatio) ? "4:3" : "3:4";
};

export const generateGoogleImagenImage = async (
  model: string,
  prompt: string,
  aspectRatio: AspectRatioOption,
  _enableHD: boolean = false,
  seed?: number,
  guidanceScale?: number,
): Promise<GeneratedImage> => {
  return runWithGoogleTokenRetry(async (token) => {
    try {
      const { googleImagenConfig } = useConfigStore.getState();
      const apiUrl =
        googleImagenConfig.apiUrl ||
        "https://generativelanguage.googleapis.com/v1beta/models";

      const actualModel =
        !model || model === "default" ? googleImagenConfig.modelId : model;
      const endpoint = `${apiUrl.replace(/\/$/, "")}/${actualModel}:predict`;

      const requestBody: any = {
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: toGoogleImagenAspectRatio(aspectRatio),
        },
      };

      if (seed !== undefined) {
        requestBody.parameters.seed = seed;
      }

      const response = await fetch(`${endpoint}?key=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        await handleGoogleApiError(response, "Imagen");
      }

      const data = await response.json();
      const base64Result = extractBase64FromGoogleImagenResponse(data);
      const imageUrl = `data:image/png;base64,${base64Result}`;

      return {
        id: generateUUID(),
        url: imageUrl,
        model: actualModel,
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed,
        guidanceScale,
        provider: "google",
      };
    } catch (error) {
      console.error("[Google Imagen] Generation Error:", error);
      throw error;
    }
  });
};

export const editGoogleImagenImage = async (
  model: string,
  prompt: string,
  base64Image: string,
  aspectRatio: AspectRatioOption,
  _maskImage?: string,
): Promise<GeneratedImage> => {
  return runWithGoogleTokenRetry(async (token) => {
    try {
      const { googleImagenConfig } = useConfigStore.getState();
      const apiUrl =
        googleImagenConfig.apiUrl ||
        "https://generativelanguage.googleapis.com/v1beta/models";

      const actualModel =
        !model || model === "default" ? googleImagenConfig.modelId : model;
      const endpoint = `${apiUrl.replace(/\/$/, "")}/${actualModel}:predict`;

      const { mimeType, base64Data } = extractBase64AndMimeType(base64Image);

      const requestBody: any = {
        instances: [
          {
            prompt,
            image: {
              bytesBase64Encoded: base64Data,
              mimeType,
            },
          },
        ],
        parameters: {
          sampleCount: 1,
          aspectRatio: toGoogleImagenAspectRatio(aspectRatio),
        },
      };

      const response = await fetch(`${endpoint}?key=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        await handleGoogleApiError(response, "Imagen Edit");
      }

      const data = await response.json();
      const base64Result = extractBase64FromGoogleImagenResponse(data);
      const imageUrl = `data:image/png;base64,${base64Result}`;

      return {
        id: generateUUID(),
        url: imageUrl,
        model: actualModel,
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        provider: "google",
      };
    } catch (error) {
      console.error("[Google Imagen] Edit Error:", error);
      throw error;
    }
  });
};

export const generateGoogleImage = async (
  model: ModelOption,
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  steps?: number,
  enableHD: boolean = false,
  guidanceScale?: number,
  base64Image?: string | string[],
): Promise<GeneratedImage> => {
  return runWithGoogleTokenRetry(async (token) => {
    try {
      const { googleConfig } = useConfigStore.getState();
      const apiUrl =
        googleConfig.apiUrl ||
        "https://generativelanguage.googleapis.com/v1beta/models";

      const actualModel = model === "default" ? googleConfig.modelId : model;
      const endpoint = `${apiUrl.replace(/\/$/, "")}/${actualModel}:generateContent`;

      const imageArray = Array.isArray(base64Image)
        ? base64Image
        : base64Image
          ? [base64Image]
          : [];

      const { width, height } = getDimensions(aspectRatio, enableHD);

      const enhancedPrompt =
        imageArray.length > 0
          ? `Please edit the provided image according to these instructions: ${prompt} (Target image size: ${width}x${height})`
          : `Please generate an image based on these instructions: ${prompt} (Target image size: ${width}x${height})`;

      const parts: any[] = [{ text: enhancedPrompt }];

      for (const img of imageArray) {
        // extract the base64 data regardless of what the MIME type claims to be
        const mimeTypeMatch = img.match(/^data:(image\/\w+);base64,/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/png";
        const base64Data = img.replace(/^data:[^;]*;base64,/, "");

        parts.push({
          inline_data: {
            mime_type: mimeType,
            data: base64Data,
          },
        });
      }

      const requestBody: any = {
        contents: [
          {
            parts: parts,
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: aspectRatio,
          },
        },
      };

      if (enableHD) {
        requestBody.generationConfig.imageConfig.imageSize = "2K";
      }

      const response = await fetch(`${endpoint}?key=${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          errData.error?.message || `Google API Error: ${response.status}`,
        );
      }

      const data = await response.json();

      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        throw new Error("error_invalid_response");
      }

      const responseParts = candidates[0].content?.parts || [];
      let base64Result = "";

      for (const part of responseParts) {
        if (part.inlineData && part.inlineData.data) {
          base64Result = part.inlineData.data;
          break;
        } else if (part.inline_data && part.inline_data.data) {
          base64Result = part.inline_data.data;
          break;
        }
      }

      if (!base64Result) {
        throw new Error("error_invalid_response");
      }

      const imageUrl = `data:image/png;base64,${base64Result}`;

      return {
        id: generateUUID(),
        url: imageUrl,
        model,
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed: seed,
        steps: steps,
        guidanceScale,
        provider: "google",
      };
    } catch (error) {
      console.error("Google Image Generation Error:", error);
      throw error;
    }
  });
};
