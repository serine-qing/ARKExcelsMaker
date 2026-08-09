#!/usr/bin/env python3
"""离线验证 pic 中技能图标定位与最终匹配分（对齐当前前端逻辑）。"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PIC_DIR = ROOT / "pic"
SKILL_DIR = ROOT / "public" / "skills"
OUT_DIR = ROOT / "pic" / "diagnose"

# 与前端 locateSkillImage 一致
LOCALIZATION_SEARCH_SIZE = 48
LOCALIZATION_TEMPLATE_SIZES = (16, 18, 20, 22, 24, 26, 28, 30, 32)
LOCALIZATION_NOMINAL_TEMPLATE = 24
LOCALIZATION_MIN_SCORE = 0.55

# 标定参数（与 skillRecognition / imageCrop 对齐）
ICON_SIZE_BY_TEXT = 1.28
VERTICAL_GAP = 0.02
HORIZONTAL_OFFSET = 0.38
PADDING_RATIO = 0.0
TEXT_HEIGHT_BY_ROW_PITCH = 0.1
MIN_MATCH_SCORE = 0.70

CASES = {
    "小图.png": [
        ("白雪", "skchr_yuki_2.webp"),
        ("云迹", "skchr_ctrail_2.webp"),
        ("格雷伊", "skchr_greyy_2.webp"),
    ],
    # 小图2 是干员档案卡（潜能 C+/C++），不含编队技能图标，不纳入技能匹配验收。
    "QQ20260808-004852.png": [
        ("桃金娘", "skcom_assist_cost-2.webp"),
        ("讯使", "skcom_charge_cost-2.webp"),
        ("泡泡", "skchr_bubble_2.webp"),
        ("清流", "skchr_finlpp_2.webp"),
    ],
    "QQ20260808-010752.png": [
        ("桃金娘", "skcom_assist_cost-2.webp"),
        ("讯使", "skcom_charge_cost-2.webp"),
        ("泡泡", "skchr_bubble_2.webp"),
        ("清流", "skchr_finlpp_2.webp"),
    ],
    "23b64d7c-4cbd-4aad-b4df-a803eeb3d558.png": [
        ("云迹", "skchr_ctrail_2.webp"),
        ("清流", "skchr_finlpp_2.webp"),
        ("泡泡", "skchr_bubble_2.webp"),
        ("调香师", "skchr_flower_2.webp"),
    ],
}


def load_bgr(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"无法读取图片: {path}")
    return image


def find_icon(image: np.ndarray, template_path: Path) -> tuple[float, int, int, int] | None:
    template = load_bgr(template_path)
    best = (-1.0, 0, 0, 0)
    h, w = image.shape[:2]
    min_side = min(h, w)
    # 覆盖小截图到 2K 编队图的技能图标尺度。
    sizes = range(max(10, min_side // 50), max(11, min_side // 6))
    for size in sizes:
        resized = cv2.resize(template, (size, size), interpolation=cv2.INTER_AREA)
        if resized.shape[0] >= h or resized.shape[1] >= w:
            continue
        for mode in ("gray", "color"):
            src = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if mode == "gray" else image
            tpl = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY) if mode == "gray" else resized
            result = cv2.matchTemplate(src, tpl, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)
            if max_val > best[0]:
                best = (float(max_val), int(max_loc[0]), int(max_loc[1]), size)
    if best[0] < 0.55:
        return None
    return best


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float32).ravel()
    b = b.astype(np.float32).ravel()
    a = a - a.mean()
    b = b - b.mean()
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom < 1e-8:
        return 0.0
    return float(np.dot(a, b) / denom)


def ncc01(a: np.ndarray, b: np.ndarray) -> float:
    return max(0.0, min(1.0, (ncc(a, b) + 1.0) / 2.0))


def positive_ncc(a: np.ndarray, b: np.ndarray) -> float:
    return max(0.0, ncc(a, b))


def locate_from_initial(
    image: np.ndarray,
    initial_rect: tuple[int, int, int, int],
    template_path: Path,
) -> tuple[float, tuple[int, int, int, int]]:
    """模拟前端 locateSkillImage：多尺度归一化搜索。"""
    ix, iy, iw, ih = initial_rect
    search_scale = LOCALIZATION_SEARCH_SIZE / LOCALIZATION_NOMINAL_TEMPLATE
    search_w = iw * search_scale
    search_h = ih * search_scale
    cx = ix + iw / 2
    cy = iy + ih / 2
    sx = int(max(0, min(image.shape[1] - search_w, cx - search_w / 2)))
    sy = int(max(0, min(image.shape[0] - search_h, cy - search_h / 2)))
    sw = int(search_w)
    sh = int(search_h)
    if sw <= 0 or sh <= 0:
        return 0.0, initial_rect

    search = image[sy : sy + sh, sx : sx + sw]
    search_norm = cv2.resize(
        search,
        (LOCALIZATION_SEARCH_SIZE, LOCALIZATION_SEARCH_SIZE),
        interpolation=cv2.INTER_AREA,
    )
    template = load_bgr(template_path)
    search_gray = cv2.cvtColor(search_norm, cv2.COLOR_BGR2GRAY)
    search_color = search_norm.astype(np.float32) / 255.0

    best_score = -1.0
    best = (0, 0, LOCALIZATION_NOMINAL_TEMPLATE)
    for template_size in LOCALIZATION_TEMPLATE_SIZES:
        template_norm = cv2.resize(
            template,
            (template_size, template_size),
            interpolation=cv2.INTER_AREA,
        )
        template_gray = cv2.cvtColor(template_norm, cv2.COLOR_BGR2GRAY)
        template_color = template_norm.astype(np.float32) / 255.0
        max_offset = LOCALIZATION_SEARCH_SIZE - template_size
        for y in range(max_offset + 1):
            for x in range(max_offset + 1):
                patch_g = search_gray[y : y + template_size, x : x + template_size]
                patch_c = search_color[y : y + template_size, x : x + template_size]
                gray_score = positive_ncc(patch_g, template_gray)
                color_score = positive_ncc(patch_c, template_color)
                score = gray_score * 0.45 + color_score * 0.55
                if score > best_score:
                    best_score = score
                    best = (x, y, template_size)

    if best_score < LOCALIZATION_MIN_SCORE:
        return best_score, initial_rect

    px = search_w / LOCALIZATION_SEARCH_SIZE
    py = search_h / LOCALIZATION_SEARCH_SIZE
    bx, by, bsize = best
    rect = (
        int(round(sx + bx * px)),
        int(round(sy + by * py)),
        max(1, int(round(bsize * px))),
        max(1, int(round(bsize * py))),
    )
    return best_score, rect


def sobel_edges(gray: np.ndarray) -> np.ndarray:
    g = gray.astype(np.float32) / 255.0
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    out = cv2.magnitude(gx, gy)
    return out[4:-4, 4:-4]


def histogram_similarity(a: np.ndarray, b: np.ndarray) -> float:
    def hist(img: np.ndarray) -> np.ndarray:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        sample = rgb[4:-4, 4:-4]
        out = np.zeros(24, np.float32)
        n = sample.shape[0] * sample.shape[1]
        for channel, offset in ((0, 0), (1, 8), (2, 16)):
            bins = np.clip((sample[:, :, channel] * 8).astype(int), 0, 7)
            for value in bins.ravel():
                out[offset + value] += 1
        return out / max(1, n)

    left, right = hist(a), hist(b)
    return float(np.minimum(left, right).sum() / 3.0)


def average_hash(img: np.ndarray) -> str:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA)
    bits = []
    for y in range(8):
        for x in range(8):
            bits.append("1" if small[y, x] > small[y, x + 1] else "0")
    return "".join(bits)


def hash_similarity(left: str, right: str) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    same = sum(a == b for a, b in zip(left, right))
    return same / len(left)


def compare_features(crop: np.ndarray, template: np.ndarray) -> float:
    """近似前端 compareSkillImage（含小幅 scale/offset 搜索）。"""
    best = 0.0
    template64 = cv2.resize(template, (64, 64), interpolation=cv2.INTER_AREA)
    for scale in (0.94, 1.0, 1.06):
        for ox in (-2, 0, 2):
            for oy in (-2, 0, 2):
                canvas = np.zeros((64, 64, 3), np.uint8)
                size = int(round(64 * scale))
                resized = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
                x0 = (64 - size) // 2 + ox
                y0 = (64 - size) // 2 + oy
                x1 = max(0, x0)
                y1 = max(0, y0)
                x2 = min(64, x0 + size)
                y2 = min(64, y0 + size)
                sx = x1 - x0
                sy = y1 - y0
                if x2 <= x1 or y2 <= y1:
                    continue
                canvas[y1:y2, x1:x2] = resized[sy : sy + (y2 - y1), sx : sx + (x2 - x1)]
                cg = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
                tg = cv2.cvtColor(template64, cv2.COLOR_BGR2GRAY)
                edge = ncc01(sobel_edges(cg), sobel_edges(tg))
                pixel = ncc01(cg[4:-4, 4:-4], tg[4:-4, 4:-4])
                color = histogram_similarity(canvas, template64)
                hashed = hash_similarity(average_hash(canvas), average_hash(template64))
                score = edge * 0.40 + pixel * 0.30 + hashed * 0.20 + color * 0.10
                best = max(best, score)
    return best


def estimate_initial_from_truth(
    truth: tuple[int, int, int],
    row_pitch: float | None,
) -> tuple[int, int, int, int]:
    tx, ty, ts = truth
    icon_center_x = tx + ts / 2
    icon_center_y = ty + ts / 2
    if row_pitch and row_pitch > 0:
        layout_unit = row_pitch * TEXT_HEIGHT_BY_ROW_PITCH
    else:
        layout_unit = ts / ICON_SIZE_BY_TEXT
    base_size = layout_unit * ICON_SIZE_BY_TEXT
    size = base_size * (1 + 2 * PADDING_RATIO)
    name_right = icon_center_x + 0.62 * layout_unit
    name_top = icon_center_y + 0.55 * layout_unit
    center_x = name_right - layout_unit + layout_unit * HORIZONTAL_OFFSET
    x = center_x - size / 2
    y = name_top - layout_unit * VERTICAL_GAP - base_size
    return (
        int(round(x)),
        int(round(y)),
        max(1, int(round(size))),
        max(1, int(round(size))),
    )


def estimate_row_pitch(truths: list[tuple[int, int, int]]) -> float | None:
    # 只用相近尺寸的图标估行距，避免把不同 UI 区块混在一起。
    if not truths:
        return None
    sizes = sorted(ts for _, _, ts in truths)
    median_size = sizes[len(sizes) // 2]
    centers = sorted(
        ty + ts / 2
        for _, ty, ts in truths
        if abs(ts - median_size) <= max(6, median_size * 0.25)
    )
    if len(centers) < 2:
        return None
    gaps = []
    for index in range(1, len(centers)):
        gap = centers[index] - centers[index - 1]
        if gap > median_size * 2:
            gaps.append(gap)
    return min(gaps) if gaps else None


def center_offset(
    truth: tuple[int, int, int],
    rect: tuple[int, int, int, int],
) -> tuple[float, float]:
    tx, ty, ts = truth
    rx, ry, rw, rh = rect
    dx = (rx + rw / 2) - (tx + ts / 2)
    dy = (ry + rh / 2) - (ty + ts / 2)
    return dx, dy


def resolve_image_path(image_name: str) -> Path | None:
    image_path = PIC_DIR / image_name
    if image_path.exists():
        return image_path
    by_size = {
        "小图.png": (291, 365),
        "小图2.png": (306, 1174),
    }
    target = by_size.get(image_name)
    if target:
        for path in PIC_DIR.glob("*.png"):
            img = load_bgr(path)
            if (img.shape[1], img.shape[0]) == target:
                return path
    matches = [
        path
        for path in PIC_DIR.glob("*.png")
        if path.name.startswith(image_name[:2]) or path.name == image_name
    ]
    return matches[0] if matches else None


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report: list[dict] = []

    for image_name, entries in CASES.items():
        image_path = resolve_image_path(image_name)
        if image_path is None:
            print(f"[跳过] 找不到 {image_name}")
            continue

        image = load_bgr(image_path)
        print(f"\n=== {image_path.name} ({image.shape[1]}x{image.shape[0]}) ===")
        truths: list[tuple[str, str, tuple[int, int, int]]] = []
        for name, skill_file in entries:
            skill_path = SKILL_DIR / skill_file
            if not skill_path.exists():
                print(f"  [缺素材] {name} {skill_file}")
                continue
            found = find_icon(image, skill_path)
            if not found:
                print(f"  [未找到] {name} {skill_file}")
                continue
            score, x, y, size = found
            truths.append((name, skill_file, (x, y, size)))
            print(f"  真值 {name}: find={score:.3f} rect=({x},{y},{size}x{size})")

        row_pitch = estimate_row_pitch([item[2] for item in truths])
        print(f"  估计行距: {row_pitch}")

        vis = image.copy()
        for name, skill_file, truth in truths:
            skill_path = SKILL_DIR / skill_file
            template = load_bgr(skill_path)
            initial = estimate_initial_from_truth(truth, row_pitch)
            loc_score, located = locate_from_initial(image, initial, skill_path)
            lx, ly, lw, lh = located
            crop = image[ly : ly + lh, lx : lx + lw]
            feature_score = compare_features(crop, template) if crop.size else 0.0
            final_score = (
                max(feature_score, loc_score)
                if loc_score >= LOCALIZATION_MIN_SCORE
                else feature_score
            )
            idx, idy = center_offset(truth, initial)
            ldx, ldy = center_offset(truth, located)
            item = {
                "image": image_path.name,
                "name": name,
                "skill": skill_file,
                "truth": {"x": truth[0], "y": truth[1], "size": truth[2]},
                "initial": {"rect": list(initial), "dx": idx, "dy": idy},
                "located": {
                    "rect": list(located),
                    "score": loc_score,
                    "dx": ldx,
                    "dy": ldy,
                },
                "featureScore": feature_score,
                "finalScore": final_score,
                "pass": final_score >= MIN_MATCH_SCORE
                and abs(ldx) <= 4
                and abs(ldy) <= 4,
            }
            report.append(item)
            status = "PASS" if item["pass"] else "FAIL"
            print(
                f"  [{status}] {name}: "
                f"初始偏移=({idx:+.1f},{idy:+.1f}) "
                f"定位偏移=({ldx:+.1f},{ldy:+.1f}) "
                f"定位分={loc_score:.3f} 特征分={feature_score:.3f} "
                f"最终分={final_score:.3f}"
            )

            tx, ty, ts = truth
            cv2.rectangle(vis, (tx, ty), (tx + ts, ty + ts), (0, 255, 0), 1)
            ix, iy, iw, ih = initial
            cv2.rectangle(vis, (ix, iy), (ix + iw, iy + ih), (0, 165, 255), 1)
            cv2.rectangle(vis, (lx, ly), (lx + lw, ly + lh), (255, 0, 0), 1)

        out_path = OUT_DIR / f"{image_path.stem}-boxes.png"
        cv2.imencode(".png", vis)[1].tofile(str(out_path))
        print(f"  可视化: {out_path}")

    summary_path = OUT_DIR / "report.json"
    summary_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    passed = sum(1 for item in report if item["pass"])
    print(f"\n汇总: {passed}/{len(report)} 通过 (最终分>={MIN_MATCH_SCORE})")
    print(f"报告: {summary_path}")
    if report:
        lows = sorted(report, key=lambda item: item["finalScore"])
        print("最低分:")
        for item in lows[:5]:
            print(
                f"  {item['image']} {item['name']}: "
                f"{item['finalScore']:.3f} "
                f"(定位 {item['located']['score']:.3f}, "
                f"特征 {item['featureScore']:.3f})"
            )


if __name__ == "__main__":
    main()
