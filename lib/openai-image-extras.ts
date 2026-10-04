import type { ImageGenerationSettings } from "./settings-types";

/** OpenAI 兼容生图的 SD 系扩展参数（负面提示词 / 步数 / CFG 引导值）。 */
export type OpenAiImageExtras = {
    negativePrompt?: string;
    steps?: number;
    guidanceScale?: number;
};

/**
 * 从生图设置（或套用了预设的合并结果）里提取并规整 OpenAI 兼容扩展参数。
 * - 来源兼容：预设字段（negativePrompt/steps/guidanceScale）由存储层/合并逻辑
 *   平铺到 ImageGenerationSettings 上，旧配置无这些字段则返回空对象。
 * - 全部可选：没填（空串 / undefined / 0）一律不进请求体，保证官方 OpenAI
 *   接口和不认识这些字段的中转站行为与改动前完全一致。
 */
export function normalizeOpenAiImageExtras(
    settings: Pick<ImageGenerationSettings, "negativePrompt" | "steps" | "guidanceScale">,
): OpenAiImageExtras {
    const extras: OpenAiImageExtras = {};
    const negativePrompt = typeof settings.negativePrompt === "string" ? settings.negativePrompt.trim() : "";
    if (negativePrompt) extras.negativePrompt = negativePrompt;
    if (typeof settings.steps === "number" && Number.isFinite(settings.steps) && settings.steps > 0) {
        extras.steps = Math.max(1, Math.min(150, Math.floor(settings.steps)));
    }
    if (typeof settings.guidanceScale === "number" && Number.isFinite(settings.guidanceScale) && settings.guidanceScale > 0) {
        extras.guidanceScale = Math.min(30, Number(settings.guidanceScale.toFixed(1)));
    }
    return extras;
}
