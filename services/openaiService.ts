import { GeneratedImage, AspectRatioOption, ModelOption } from "../types";
import { getDimensions } from "./dimensions";
import { generateUUID } from "./utils";
import { useConfigStore } from "../store/configStore";
import { runWithTokenRetry } from "./tokenRetry";

// Token retry delegates to shared service
const runWithOpenAITokenRetry = <T>(
  operation: (token: string) => Promise<T>,
): Promise<T> => {
  return runWithTokenRetry(
    "openai",
    operation as (token: string | null) => Promise<T>,
  );
};

// Helper to handle OpenAI API errors
const handleOpenAIApiError = async (response: Response, operationType: string): Promise<never> => {
  const errData = await response.json().catch(() => ({}));
  throw new Error(
    errData.error?.message || `OpenAI ${operationType} API Error: ${response.status}`
  );
};

const isGptImageModel = (model: string): boolean =>
  model.toLowerCase().startsWith("gpt-image");

const isDallE2Model = (model: string): boolean =>
  model.toLowerCase().startsWith("dall-e-2");

// Helper function to convert aspect ratio to OpenAI-supported size format
const aspectRatioToOpenAISize = (
  aspectRatio: AspectRatioOption,
  model: string,
): string => {
  if (aspectRatio === "1:1" || isDallE2Model(model)) return "1024x1024";

  const landscapeRatios: AspectRatioOption[] = ["16:9", "3:2", "4:3", "5:4"];
  const isLandscape = landscapeRatios.includes(aspectRatio);

  if (isGptImageModel(model)) {
    return isLandscape ? "1536x1024" : "1024x1536";
  }

  return isLandscape ? "1792x1024" : "1024x1792";
};

const openAIImageQuality = (model: string, enableHD: boolean): string =>
  isGptImageModel(model) ? (enableHD ? "high" : "medium") : enableHD ? "hd" : "standard";

const extractOpenAIImageUrl = (entry: any): string | undefined => {
  if (typeof entry?.url === "string") return entry.url;
  if (typeof entry?.b64_json === "string") {
    return `data:image/png;base64,${entry.b64_json.replace(/^data:image\/\w+;base64,/, "")}`;
  }
  return undefined;
};

// Helper to convert base64 to Blob for multipart uploads
const base64ToBlob = (base64: string, mimeType = "image/png"): Blob => {
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, "");
  const byteCharacters = atob(base64Data);
  const byteArray = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteArray[i] = byteCharacters.charCodeAt(i);
  }
  return new Blob([byteArray], { type: mimeType });
};

export const generateOpenAIImagenImage = async (
  model: string,
  prompt: string,
  aspectRatio: AspectRatioOption,
  enableHD: boolean = false,
  seed?: number,
): Promise<GeneratedImage> => {
  return runWithOpenAITokenRetry(async (token) => {
    try {
      const { openaiImagenConfig } = useConfigStore.getState();
      const baseUrl =
        openaiImagenConfig.apiUrl || "https://api.openai.com/v1/images";
      const actualModel =
        model === "default" ? openaiImagenConfig.modelId : model;

      const size = aspectRatioToOpenAISize(aspectRatio, actualModel);
      const quality = openAIImageQuality(actualModel, enableHD);

      const requestBody: Record<string, unknown> = {
        model: actualModel,
        prompt,
        size,
        quality,
        n: 1,
      };
      if (!isGptImageModel(actualModel)) requestBody.response_format = "url";

      const response = await fetch(`${baseUrl}/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        await handleOpenAIApiError(response, "Imagen");
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        throw new Error("error_invalid_response");
      }

      const imageUrl = extractOpenAIImageUrl(data.data[0]);
      if (!imageUrl) {
        throw new Error("error_invalid_response");
      }
      const revisedPrompt = data.data[0].revised_prompt;

      return {
        id: generateUUID(),
        url: imageUrl,
        model: actualModel,
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        seed,
        provider: "openai",
        revised_prompt: revisedPrompt,
      };
    } catch (error) {
      console.error("[OpenAI Imagen] Generation Error:", error);
      throw error;
    }
  });
};

export const editOpenAIImagenImage = async (
  model: string,
  prompt: string,
  base64Image: string,
  aspectRatio: AspectRatioOption,
  enableHD: boolean = false,
  maskImage?: string,
): Promise<GeneratedImage> => {
  return runWithOpenAITokenRetry(async (token) => {
    try {
      const { openaiImagenConfig } = useConfigStore.getState();
      const baseUrl =
        openaiImagenConfig.apiUrl || "https://api.openai.com/v1/images";
      const actualModel =
        model === "default" ? openaiImagenConfig.modelId : model;

      const size = aspectRatioToOpenAISize(aspectRatio, actualModel);

      // Convert base64 to Blob
      const imageBlob = base64ToBlob(base64Image);

      // Create multipart form data
      const formData = new FormData();
      formData.append("image", imageBlob, "image.png");
      formData.append("prompt", prompt);
      formData.append("model", actualModel);
      formData.append("size", size);
      formData.append("n", "1");
      formData.append("quality", openAIImageQuality(actualModel, enableHD));

      if (maskImage) {
        const maskBlob = base64ToBlob(maskImage);
        formData.append("mask", maskBlob, "mask.png");
      }

      const response = await fetch(`${baseUrl}/edits`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        await handleOpenAIApiError(response, "Imagen Edit");
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        throw new Error("error_invalid_response");
      }

      const imageUrl = extractOpenAIImageUrl(data.data[0]);
      if (!imageUrl) {
        throw new Error("error_invalid_response");
      }
      const revisedPrompt = data.data[0].revised_prompt;

      return {
        id: generateUUID(),
        url: imageUrl,
        model: actualModel,
        prompt,
        aspectRatio,
        timestamp: Date.now(),
        provider: "openai",
        revised_prompt: revisedPrompt,
      };
    } catch (error) {
      console.error("[OpenAI Imagen] Edit Error:", error);
      throw error;
    }
  });
};

export const generateOpenAIImage = async (
  model: ModelOption,
  prompt: string,
  aspectRatio: AspectRatioOption,
  seed?: number,
  steps?: number,
  enableHD: boolean = false,
  guidanceScale?: number,
  base64Image?: string | string[],
): Promise<GeneratedImage> => {
  return runWithOpenAITokenRetry(async (token) => {
    try {
      const { openaiConfig } = useConfigStore.getState();
      const apiUrl =
        openaiConfig.apiUrl || "https://api.openai.com/v1/responses";
      const actualModel = model === "default" ? openaiConfig.modelId : model;

      const { width, height } = getDimensions(aspectRatio, enableHD);
      const sizeString = `${width}x${height}`;

      const imageArray = Array.isArray(base64Image)
        ? base64Image
        : base64Image
          ? [base64Image]
          : [];
      const inputs: any[] = [];

      if (imageArray.length > 0) {
        const content: any[] = [
          {
            type: "input_text",
            text: `Please edit the provided image according to these instructions: ${prompt} (Target image size: ${sizeString})`,
          },
        ];

        for (const img of imageArray) {
          let base64Data = img;
          if (!base64Data.startsWith("data:")) {
            base64Data = `data:image/png;base64,${base64Data}`;
          } else {
            base64Data = base64Data.replace(/^data:([^;]*);base64,/, (match, mimeType) => {
              if (!mimeType || !mimeType.startsWith("image/")) {
                return "data:image/png;base64,";
              }
              return match;
            });
          }

          content.push({
            type: "input_image",
            image_url: base64Data,
          });
        }

        inputs.push({
          role: "user",
          content: content,
        });
      } else {
        inputs.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Please generate an image based on these instructions: ${prompt} (Target image size: ${sizeString})`,
            },
          ],
        });
      }

      const requestBody = {
        model: actualModel,
        input: inputs,
        tools: [
          {
            type: "image_generation",
            image_generation: {
              size: sizeString,
            },
          },
        ],
      };

      const response = await fetch(apiUrl, {
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
          errData.error?.message || `OpenAI API Error: ${response.status}`,
        );
      }

      const data = await response.json();

      let base64Result = "";

      // Look for the image generation result in the new Responses API output array
      const outputs = data.output || [];
      const imageGenerationCall = outputs.find(
        (o: any) => o.type === "image_generation_call",
      );

      if (imageGenerationCall && imageGenerationCall.result) {
        base64Result = imageGenerationCall.result;
      } else {
        // Fallback to older proxy formats or tool_calls format if still used
        const toolCalls = data.choices?.[0]?.message?.tool_calls || [];
        const oldImageCall = toolCalls.find(
          (t: any) =>
            t.type === "image_generation_call" ||
            t.function?.name === "image_generation_call",
        );

        if (oldImageCall && oldImageCall.result) {
          base64Result = oldImageCall.result;
        } else if (
          data.imageGenerationCall &&
          data.imageGenerationCall[0]?.result
        ) {
          base64Result = data.imageGenerationCall[0].result;
        } else if (toolCalls.length > 0) {
          try {
            const args = JSON.parse(toolCalls[0].function?.arguments || "{}");
            if (args.result) base64Result = args.result;
            if (args.image) base64Result = args.image;
          } catch {
            // ignore
          }
        }
      }

      if (!base64Result) {
        console.error("Unrecognized OpenAI response format", data);
        throw new Error("error_invalid_response");
      }

      const imageUrl = `data:image/png;base64,${base64Result.replace(/^data:image\/\w+;base64,/, "")}`;

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
        provider: "openai",
      };
    } catch (error) {
      console.error("OpenAI Image Generation Error:", error);
      throw error;
    }
  });
};
