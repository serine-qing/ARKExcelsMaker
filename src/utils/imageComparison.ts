import type { ImageRect, SkillData } from "../types/skill";
import { hashSimilarity } from "./similarity";
import { computeImageFeatures } from "./imageHash";

interface DetailedImageFeatures {
  gray: Float32Array;
  edges: Float32Array;
  colorHistogram: Float32Array;
  hash: string;
}

export interface DetailedSimilarity {
  score: number;
  edgeSimilarity: number;
  pixelSimilarity: number;
  colorSimilarity: number;
  hashSimilarity: number;
}

const SIZE = 64;
const SAMPLE_MARGIN = 4;
const LOCALIZATION_SEARCH_SIZE = 48;
// 覆盖初始框约 ±33% 的尺寸误差（相对名义 24px 模板）。
const LOCALIZATION_TEMPLATE_SIZES = [
  16, 18, 20, 22, 24, 26, 28, 30, 32,
] as const;
const LOCALIZATION_MIN_SCORE = 0.55;
const imageCache = new Map<string, Promise<HTMLImageElement>>();
const standardFeatureCache = new Map<string, Promise<DetailedImageFeatures>>();
const localizationImageCache = new Map<string, Promise<HTMLImageElement>>();

function resolveAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`.replace(
    /\/{2,}/g,
    "/",
  );
}

function loadImage(path: string): Promise<HTMLImageElement> {
  const url = resolveAsset(path);
  let promise = imageCache.get(url);
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`技能图标加载失败：${path}`));
      image.src = url;
    });
    imageCache.set(url, promise);
  }
  return promise;
}

function renderVariant(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  scale = 1,
  offsetX = 0,
  offsetY = 0,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建图像比较画布");

  context.fillStyle = "#000";
  context.fillRect(0, 0, SIZE, SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const renderedSize = SIZE * scale;
  context.drawImage(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    (SIZE - renderedSize) / 2 + offsetX,
    (SIZE - renderedSize) / 2 + offsetY,
    renderedSize,
    renderedSize,
  );
  return canvas;
}

function extractDetailedFeatures(
  source: CanvasImageSource,
  width: number,
  height: number,
): DetailedImageFeatures {
  const canvas = renderVariant(source, width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法读取图像比较画布");
  const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
  const fullGray = new Float32Array(SIZE * SIZE);
  const colorHistogram = new Float32Array(24);
  let sampledPixels = 0;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const pixelIndex = y * SIZE + x;
      const offset = pixelIndex * 4;
      const r = pixels[offset] / 255;
      const g = pixels[offset + 1] / 255;
      const b = pixels[offset + 2] / 255;
      fullGray[pixelIndex] = r * 0.299 + g * 0.587 + b * 0.114;

      if (
        x >= SAMPLE_MARGIN &&
        x < SIZE - SAMPLE_MARGIN &&
        y >= SAMPLE_MARGIN &&
        y < SIZE - SAMPLE_MARGIN
      ) {
        colorHistogram[Math.min(7, Math.floor(r * 8))] += 1;
        colorHistogram[8 + Math.min(7, Math.floor(g * 8))] += 1;
        colorHistogram[16 + Math.min(7, Math.floor(b * 8))] += 1;
        sampledPixels += 1;
      }
    }
  }

  const valuesPerSide = SIZE - SAMPLE_MARGIN * 2;
  const gray = new Float32Array(valuesPerSide * valuesPerSide);
  const edges = new Float32Array(valuesPerSide * valuesPerSide);
  let outputIndex = 0;

  for (let y = SAMPLE_MARGIN; y < SIZE - SAMPLE_MARGIN; y += 1) {
    for (let x = SAMPLE_MARGIN; x < SIZE - SAMPLE_MARGIN; x += 1) {
      gray[outputIndex] = fullGray[y * SIZE + x];

      const topLeft = fullGray[(y - 1) * SIZE + x - 1];
      const top = fullGray[(y - 1) * SIZE + x];
      const topRight = fullGray[(y - 1) * SIZE + x + 1];
      const left = fullGray[y * SIZE + x - 1];
      const right = fullGray[y * SIZE + x + 1];
      const bottomLeft = fullGray[(y + 1) * SIZE + x - 1];
      const bottom = fullGray[(y + 1) * SIZE + x];
      const bottomRight = fullGray[(y + 1) * SIZE + x + 1];
      const gradientX =
        -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gradientY =
        -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      edges[outputIndex] = Math.sqrt(
        gradientX * gradientX + gradientY * gradientY,
      );
      outputIndex += 1;
    }
  }

  for (let index = 0; index < colorHistogram.length; index += 1) {
    colorHistogram[index] /= sampledPixels;
  }

  const simple = computeImageFeatures(canvas, SIZE, SIZE);
  return {
    gray,
    edges,
    colorHistogram,
    hash: simple.hash,
  };
}

function normalizedCorrelation(
  left: Float32Array,
  right: Float32Array,
): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;

  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < length; index += 1) {
    leftMean += left[index];
    rightMean += right[index];
  }
  leftMean /= length;
  rightMean /= length;

  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  const denominator = Math.sqrt(leftVariance * rightVariance);
  if (denominator < 1e-8) return 0;
  const correlation = covariance / denominator;
  return Math.max(0, Math.min(1, (correlation + 1) / 2));
}

/** 归一化互相关，负相关截为 0，输出 [0, 1]。 */
function positiveNcc(left: Float32Array, right: Float32Array): number {
  return Math.max(0, normalizedCorrelation(left, right) * 2 - 1);
}

function histogramSimilarity(
  left: Float32Array,
  right: Float32Array,
): number {
  const length = Math.min(left.length, right.length);
  let intersection = 0;
  for (let index = 0; index < length; index += 1) {
    intersection += Math.min(left[index], right[index]);
  }
  // 三个颜色通道的直方图分别归一化，总交集最大为 3。
  return Math.max(0, Math.min(1, intersection / 3));
}

function compareFeatures(
  screenshot: DetailedImageFeatures,
  standard: DetailedImageFeatures,
): DetailedSimilarity {
  const edgeScore = normalizedCorrelation(screenshot.edges, standard.edges);
  const pixelScore = normalizedCorrelation(screenshot.gray, standard.gray);
  const colorScore = histogramSimilarity(
    screenshot.colorHistogram,
    standard.colorHistogram,
  );
  const hashScore = hashSimilarity(screenshot.hash, standard.hash);

  return {
    score: edgeScore * 0.40 + pixelScore * 0.30 + hashScore * 0.20 + colorScore * 0.10,
    edgeSimilarity: edgeScore,
    pixelSimilarity: pixelScore,
    colorSimilarity: colorScore,
    hashSimilarity: hashScore,
  };
}

async function getStandardFeatures(
  skill: SkillData,
): Promise<DetailedImageFeatures> {
  let promise = standardFeatureCache.get(skill.icon);
  if (!promise) {
    promise = loadImage(skill.icon).then((image) =>
      extractDetailedFeatures(
        image,
        image.naturalWidth || SIZE,
        image.naturalHeight || SIZE,
      ),
    );
    standardFeatureCache.set(skill.icon, promise);
  }
  return promise;
}

function extractLocalizationPixels(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  outputSize: number,
): { gray: Float32Array; rgb: Float32Array } {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法读取技能定位图像");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    outputSize,
    outputSize,
  );
  const pixels = context.getImageData(0, 0, outputSize, outputSize).data;
  const gray = new Float32Array(outputSize * outputSize);
  const rgb = new Float32Array(outputSize * outputSize * 3);
  for (let index = 0; index < outputSize * outputSize; index += 1) {
    const sourceOffset = index * 4;
    const targetOffset = index * 3;
    const r = pixels[sourceOffset] / 255;
    const g = pixels[sourceOffset + 1] / 255;
    const b = pixels[sourceOffset + 2] / 255;
    gray[index] = r * 0.299 + g * 0.587 + b * 0.114;
    rgb[targetOffset] = r;
    rgb[targetOffset + 1] = g;
    rgb[targetOffset + 2] = b;
  }
  return { gray, rgb };
}

function extractLocalizationPatch(
  source: { gray: Float32Array; rgb: Float32Array },
  searchSize: number,
  templateSize: number,
  x: number,
  y: number,
): { gray: Float32Array; rgb: Float32Array } {
  const gray = new Float32Array(templateSize * templateSize);
  const rgb = new Float32Array(templateSize * templateSize * 3);
  let outputIndex = 0;
  for (let row = 0; row < templateSize; row += 1) {
    for (let column = 0; column < templateSize; column += 1) {
      const sourceIndex = (y + row) * searchSize + x + column;
      gray[outputIndex] = source.gray[sourceIndex];
      const sourceRgbIndex = sourceIndex * 3;
      const outputRgbIndex = outputIndex * 3;
      rgb[outputRgbIndex] = source.rgb[sourceRgbIndex];
      rgb[outputRgbIndex + 1] = source.rgb[sourceRgbIndex + 1];
      rgb[outputRgbIndex + 2] = source.rgb[sourceRgbIndex + 2];
      outputIndex += 1;
    }
  }
  return { gray, rgb };
}

async function getLocalizationImage(
  skill: SkillData,
): Promise<HTMLImageElement> {
  let promise = localizationImageCache.get(skill.icon);
  if (!promise) {
    promise = loadImage(skill.icon);
    localizationImageCache.set(skill.icon, promise);
  }
  return promise;
}

function scoreLocalizationPatch(
  patch: { gray: Float32Array; rgb: Float32Array },
  template: { gray: Float32Array; rgb: Float32Array },
): number {
  const grayScore = positiveNcc(patch.gray, template.gray);
  const colorScore = positiveNcc(patch.rgb, template.rgb);
  return grayScore * 0.45 + colorScore * 0.55;
}

export interface SkillLocalizationResult {
  rect: ImageRect;
  templateScores: Map<string, number>;
}

export async function locateSkillImage(
  source: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  initialRect: ImageRect,
  skills: SkillData[],
): Promise<SkillLocalizationResult> {
  // 以初始框为中心放大搜索；多尺度模板覆盖约 ±25% 尺寸误差。
  const nominalTemplateSize = 24;
  const searchScale = LOCALIZATION_SEARCH_SIZE / nominalTemplateSize;
  const searchWidth = initialRect.width * searchScale;
  const searchHeight = initialRect.height * searchScale;
  const centerX = initialRect.x + initialRect.width / 2;
  const centerY = initialRect.y + initialRect.height / 2;
  const searchRect: ImageRect = {
    x: Math.max(0, Math.min(imageWidth - searchWidth, centerX - searchWidth / 2)),
    y: Math.max(
      0,
      Math.min(imageHeight - searchHeight, centerY - searchHeight / 2),
    ),
    width: searchWidth,
    height: searchHeight,
  };
  if (
    searchRect.width <= 0 ||
    searchRect.height <= 0 ||
    searchRect.x + searchRect.width > imageWidth ||
    searchRect.y + searchRect.height > imageHeight
  ) {
    return { rect: initialRect, templateScores: new Map() };
  }

  const searchCanvas = document.createElement("canvas");
  searchCanvas.width = LOCALIZATION_SEARCH_SIZE;
  searchCanvas.height = LOCALIZATION_SEARCH_SIZE;
  const searchContext = searchCanvas.getContext("2d");
  if (!searchContext) throw new Error("浏览器无法创建技能定位画布");
  searchContext.imageSmoothingEnabled = true;
  searchContext.imageSmoothingQuality = "high";
  searchContext.drawImage(
    source,
    searchRect.x,
    searchRect.y,
    searchRect.width,
    searchRect.height,
    0,
    0,
    LOCALIZATION_SEARCH_SIZE,
    LOCALIZATION_SEARCH_SIZE,
  );
  const searchPixels = extractLocalizationPixels(
    searchCanvas,
    LOCALIZATION_SEARCH_SIZE,
    LOCALIZATION_SEARCH_SIZE,
    LOCALIZATION_SEARCH_SIZE,
  );

  const templateScores = new Map<string, number>();
  let best:
    | {
        score: number;
        x: number;
        y: number;
        templateSize: number;
      }
    | null = null;

  for (const skill of skills) {
    const templateImage = await getLocalizationImage(skill);
    let skillBest = {
      score: 0,
      x: 0,
      y: 0,
      templateSize: nominalTemplateSize,
    };

    for (const templateSize of LOCALIZATION_TEMPLATE_SIZES) {
      const template = extractLocalizationPixels(
        templateImage,
        templateImage.naturalWidth || templateSize,
        templateImage.naturalHeight || templateSize,
        templateSize,
      );
      const maxOffset = LOCALIZATION_SEARCH_SIZE - templateSize;
      if (maxOffset < 0) continue;

      for (let y = 0; y <= maxOffset; y += 1) {
        for (let x = 0; x <= maxOffset; x += 1) {
          const patch = extractLocalizationPatch(
            searchPixels,
            LOCALIZATION_SEARCH_SIZE,
            templateSize,
            x,
            y,
          );
          const score = scoreLocalizationPatch(patch, template);
          if (score > skillBest.score) {
            skillBest = { score, x, y, templateSize };
          }
        }
      }
    }

    templateScores.set(skill.skillId, skillBest.score);
    if (!best || skillBest.score > best.score) best = skillBest;
  }

  if (!best || best.score < LOCALIZATION_MIN_SCORE) {
    return { rect: initialRect, templateScores };
  }

  const pixelScaleX = searchRect.width / LOCALIZATION_SEARCH_SIZE;
  const pixelScaleY = searchRect.height / LOCALIZATION_SEARCH_SIZE;
  return {
    rect: {
      x: Math.round(searchRect.x + best.x * pixelScaleX),
      y: Math.round(searchRect.y + best.y * pixelScaleY),
      width: Math.max(1, Math.round(best.templateSize * pixelScaleX)),
      height: Math.max(1, Math.round(best.templateSize * pixelScaleY)),
    },
    templateScores,
  };
}

export async function compareSkillImage(
  crop: HTMLCanvasElement,
  skill: SkillData,
): Promise<DetailedSimilarity> {
  const standard = await getStandardFeatures(skill);
  const scales = [0.94, 1, 1.06];
  const offsets = [-2, 0, 2];
  let best: DetailedSimilarity | null = null;

  for (const scale of scales) {
    for (const offsetX of offsets) {
      for (const offsetY of offsets) {
        const variant = renderVariant(
          crop,
          crop.width,
          crop.height,
          scale,
          offsetX,
          offsetY,
        );
        const screenshot = extractDetailedFeatures(variant, SIZE, SIZE);
        const result = compareFeatures(screenshot, standard);
        if (!best || result.score > best.score) best = result;
      }
    }
  }

  if (!best) throw new Error("无法生成技能图标比较结果");
  if (import.meta.env.DEV) {
    console.log(
      `[技能对比] ${skill.name} | 边缘:${best.edgeSimilarity.toFixed(3)} 像素:${best.pixelSimilarity.toFixed(3)} 哈希:${best.hashSimilarity.toFixed(3)} 颜色:${best.colorSimilarity.toFixed(3)} → 总分:${best.score.toFixed(3)}`,
    );
  }
  return best;
}
