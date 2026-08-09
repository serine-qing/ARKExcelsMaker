import type { OcrResultItem } from "@paddleocr/paddleocr-js";
import { loadOperators } from "../data/operatorIndex";
import type {
  ImageRect,
  OperatorSkillRecognition,
  SkillCandidate,
  SkillCropConfig,
  SkillRecognitionResult,
} from "../types/skill";
import {
  boundingRect,
  calculateSkillRect,
  cropToCanvas,
} from "../utils/imageCrop";
import {
  compareSkillImage,
  locateSkillImage,
} from "../utils/imageComparison";
import { matchOperatorName } from "../utils/similarity";

export const DEFAULT_SKILL_CROP_CONFIG: SkillCropConfig = {
  iconSizeByTextHeight: 1.28,
  // 标定截图上略偏上；略减小间距，让裁剪中心下移。
  verticalGapByTextHeight: 0.02,
  horizontalOffsetByTextHeight: 0.38,
  // 紧贴图标：padding 会把背景算进相似度，大图也会从 ~0.9 掉到 ~0.5。
  // 位置/尺寸误差由 locateSkillImage 多尺度搜索吸收。
  paddingRatio: 0,
};

const MIN_SKILL_SCORE = 0.68;
const MIN_CANDIDATE_GAP = 0.04;
const LOW_GAP_THRESHOLD = 0.01;
const MIN_NAME_SCORE = 0.64;
// 在标定截图中，名字行距约为文字布局单位的 10 倍。
// 结合完整编队截图标定后，技能框边长约等于行距的 12.8%。
const TEXT_HEIGHT_BY_ROW_PITCH = 0.1;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function correctOcrTextHeight(ocrTextHeight: number): number {
  // OCR unclip 会系统性放大文字框，回退路径需要校正。
  return ocrTextHeight > 0 ? ocrTextHeight / 1.6 : 0;
}

function estimateLayoutUnitFromRowPitch(
  nameBoxes: ImageRect[],
  fallbackTextHeight: number,
): number {
  if (nameBoxes.length < 2 || fallbackTextHeight <= 0) {
    return correctOcrTextHeight(fallbackTextHeight);
  }

  const rowTolerance = Math.max(8, fallbackTextHeight * 1.5);
  const centers = nameBoxes
    .map((box) => box.y + box.height / 2)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const rows: number[][] = [];

  for (const center of centers) {
    const currentRow = rows[rows.length - 1];
    if (
      !currentRow ||
      Math.abs(center - median(currentRow)) > rowTolerance
    ) {
      rows.push([center]);
    } else {
      currentRow.push(center);
    }
  }

  const rowCenters = rows.map(median).sort((left, right) => left - right);
  const validGaps = rowCenters
    .slice(1)
    .map((center, index) => center - (rowCenters[index] ?? center))
    .filter((gap) => gap >= fallbackTextHeight * 4);
  if (validGaps.length === 0) {
    return correctOcrTextHeight(fallbackTextHeight);
  }

  // 取最小有效间距，避免中间整行未识别时把两倍行距当作基准。
  const rowPitch = Math.min(...validGaps);
  const inferredLayoutUnit = rowPitch * TEXT_HEIGHT_BY_ROW_PITCH;
  const ratioToOcrHeight = inferredLayoutUnit / fallbackTextHeight;

  // 行数太少或截图布局不同可能产生异常间距，此时保守回退。
  if (ratioToOcrHeight < 0.65 || ratioToOcrHeight > 1.6) {
    return correctOcrTextHeight(fallbackTextHeight);
  }
  return inferredLayoutUnit;
}

function stabilizeNameAnchor(
  nameBox: ImageRect,
  allNameBoxes: ImageRect[],
  layoutUnit: number,
): ImageRect {
  // 样本太少时不做同行/同列稳定化，避免局部截图被错误平移。
  if (allNameBoxes.length < 3) return nameBox;

  const centerY = nameBox.y + nameBox.height / 2;
  const right = nameBox.x + nameBox.width;
  const rowTolerance = Math.max(4, layoutUnit * 1.5);
  const columnTolerance = Math.max(6, layoutUnit * 2.5);
  const sameRow = allNameBoxes.filter(
    (box) =>
      Math.abs(box.y + box.height / 2 - centerY) <= rowTolerance,
  );
  const sameColumn = allNameBoxes.filter(
    (box) =>
      Math.abs(box.x + box.width - right) <= columnTolerance,
  );
  const stableTop = median(sameRow.map((box) => box.y)) || nameBox.y;
  const stableRight =
    median(sameColumn.map((box) => box.x + box.width)) || right;

  return {
    ...nameBox,
    x: stableRight - nameBox.width,
    y: stableTop,
  };
}

export async function recognizeOperatorSkills(
  file: File,
  lines: OcrResultItem[],
  config: SkillCropConfig = DEFAULT_SKILL_CROP_CONFIG,
): Promise<SkillRecognitionResult> {
  const [operators, image] = await Promise.all([
    loadOperators(),
    createImageBitmap(file),
  ]);
  try {
    const items: OperatorSkillRecognition[] = [];
    const seen = new Set<string>();
    const matchedNameBoxes = lines
      .filter((line) => {
        const match = matchOperatorName(line.text, operators);
        return (
          match.name !== null &&
          match.confidence >= MIN_NAME_SCORE &&
          match.operators.length > 0
        );
      })
      .map(boundingRect)
      .filter(
        (box) =>
          Number.isFinite(box.height) &&
          Number.isFinite(box.y) &&
          box.height > 0,
      );
    const medianTextHeight = median(
      matchedNameBoxes.map((box) => box.height),
    );
    const layoutUnit = estimateLayoutUnitFromRowPitch(
      matchedNameBoxes,
      medianTextHeight,
    );

    for (const line of lines) {
      const nameMatch = matchOperatorName(line.text, operators);
      if (
        !nameMatch.name ||
        nameMatch.confidence < MIN_NAME_SCORE ||
        nameMatch.operators.length === 0
      ) {
        continue;
      }

      const rawNameBox = boundingRect(line);
      const nameBox = stabilizeNameAnchor(
        rawNameBox,
        matchedNameBoxes,
        layoutUnit || rawNameBox.height,
      );
      const dedupeKey = `${nameMatch.name}:${Math.round(nameBox.x / 10)}:${Math.round(nameBox.y / 10)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const cropRect = calculateSkillRect(
        nameBox,
        image.width,
        image.height,
        config,
        layoutUnit || nameBox.height,
      );
      const skills = [
        ...new Map(
          nameMatch.operators
            .flatMap((operator) => operator.skills)
            .map((skill) => [skill.skillId, skill]),
        ).values(),
      ];

      if (skills.length === 0) {
        items.push({
          rawText: line.text,
          matchedName: nameMatch.name,
          operatorIds: nameMatch.operators.map(
            (operator) => operator.characterId,
          ),
          nameConfidence: nameMatch.confidence,
          ocrConfidence: line.score,
          nameBox,
          cropRect,
          cropDataUrl: null,
          status: "no-skills",
          best: null,
          candidates: [],
        });
        continue;
      }

      if (!cropRect) {
        items.push({
          rawText: line.text,
          matchedName: nameMatch.name,
          operatorIds: nameMatch.operators.map(
            (operator) => operator.characterId,
          ),
          nameConfidence: nameMatch.confidence,
          ocrConfidence: line.score,
          nameBox,
          cropRect: null,
          cropDataUrl: null,
          status: "out-of-bounds",
          best: null,
          candidates: [],
        });
        continue;
      }

      // 行距和名字只提供初始区域；在小型归一化区域内用原生模板快速定位图标。
      const localization = await locateSkillImage(
        image,
        image.width,
        image.height,
        cropRect,
        skills,
      );
      const resolvedCropRect = localization.rect;
      // 128px 保留细节；compareSkillImage 内部再统一到 64。
      const cropCanvas = cropToCanvas(image, resolvedCropRect, 128);
      const candidates: SkillCandidate[] = (
        await Promise.all(
          skills.map(async (skill) => {
            const similarity = await compareSkillImage(cropCanvas, skill);
            const templateScore =
              localization.templateScores.get(skill.skillId) ?? 0;
            // 定位分高时取特征分与模板分的较大值，避免紧裁后仍被轻微错位拖低。
            const score =
              templateScore >= 0.55
                ? Math.max(similarity.score, templateScore)
                : similarity.score;
            return {
              skill,
              ...similarity,
              score,
            };
          }),
        )
      ).sort((left, right) => right.score - left.score);

      const best = candidates[0] ?? null;
      const second = candidates[1] ?? null;
      let status: OperatorSkillRecognition["status"] = "matched";

      if (nameMatch.confidence < 0.75) {
        status = "name-uncertain";
      } else if (second && best && best.score - second.score < LOW_GAP_THRESHOLD) {
        // 分差过小，可信度较低（优先于 low-confidence 判断）
        status = "low-gap";
      } else if (!best || best.score < MIN_SKILL_SCORE) {
        status = "low-confidence";
      } else if (second && best.score - second.score < MIN_CANDIDATE_GAP) {
        status = "ambiguous";
      }

      items.push({
        rawText: line.text,
        matchedName: nameMatch.name,
        operatorIds: nameMatch.operators.map(
          (operator) => operator.characterId,
        ),
        nameConfidence: nameMatch.confidence,
        ocrConfidence: line.score,
        nameBox,
        cropRect: resolvedCropRect,
        cropDataUrl: cropCanvas.toDataURL("image/png"),
        status,
        best,
        candidates: candidates.slice(0, 3),
      });
    }

    return {
      items,
      config: { ...config },
      image: { width: image.width, height: image.height },
    };
  } finally {
    image.close();
  }
}
