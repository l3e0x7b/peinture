import { getCustomProviders } from "./utils";
import { getModelConfig, getGuidanceScaleConfig } from "../constants";

export interface DefaultModelParams {
  defaultSteps: number;
  defaultGs: number;
  hasGs: boolean;
}

export const getDefaultModelParams = (
  provider: string,
  model: string,
): DefaultModelParams => {
  let defaultSteps = 9;
  let defaultGs = 7.5;
  let hasGs = false;

  const customProviders = getCustomProviders();
  const activeCustom = customProviders.find((p) => p.id === provider);

  if (activeCustom) {
    const customModel = activeCustom.models.generate?.find(
      (m) => m.id === model,
    );
    if (customModel) {
      if (customModel.steps) {
        defaultSteps = customModel.steps.default;
      }
      if (customModel.guidance) {
        hasGs = true;
        defaultGs = customModel.guidance.default;
      }
    } else {
      const fallback = getModelConfig(provider, model);
      // Null means the model has fixed generation params (e.g. Qwen Image 2.1 Turbo)
      defaultSteps = fallback ? fallback.default : 9;
      const fallbackGs = getGuidanceScaleConfig(model, provider);
      if (fallbackGs) {
        hasGs = true;
        defaultGs = fallbackGs.default;
      }
    }
  } else {
    const config = getModelConfig(provider, model);
    defaultSteps = config ? config.default : 9;
    const gsConfig = getGuidanceScaleConfig(model, provider);
    if (gsConfig) {
      hasGs = true;
      defaultGs = gsConfig.default;
    }
  }

  return { defaultSteps, defaultGs, hasGs };
};
