"""WB A/B Slider 后端。

设计要点
--------
1. 两路 IMAGE 输入（image_a / image_b）直接取第 0 帧，不经过 /history，
   所以「节点一跑完，画布里立刻就有图」，也不存在跨域 / 读取历史失败的问题。
2. 每个输入单独落一张预览 PNG 到 ComfyUI 的 temp 目录，通过 /api/view 提供；
   用 ``preview_max_side`` 限制长边（默认 2048），避免 4K/8K 原图拖垮浏览器。
   想看原图细节就把这个数值调大再重跑。
3. 两路尺寸不同时，把 B 等比 + 居中补齐到 A 的尺寸，保证滑块左右完全对齐。
4. ``ui`` 里的键全部加 ``wb_`` 前缀、值全部用列表，避免和 ComfyUI 内核的
   ``images`` 自动预览语义撞车（这正是旧节点空白 / 只露一角的根因之一）。
5. 额外输出一张静态并排预览 IMAGE，作为「万一前端没渲染」时的保底。
"""

import os
import uuid

import numpy as np
import torch
from PIL import Image

import folder_paths


def _scalar(v, default):
    """个别内核会把 widget 标量包成单元素 list，这里统一解包。"""
    if isinstance(v, list) and len(v) == 1:
        v = v[0]
    if v is None:
        return default
    return v


def _first_frame(tensor) -> Image.Image:
    """IMAGE 张量 [B,H,W,C] 或 [H,W,C]（float 0..1）→ 第 0 帧 PIL RGB。"""
    t = tensor
    if hasattr(t, "dim") and t.dim() == 3:
        t = t.unsqueeze(0)
    t = t.detach().cpu().float()[0]
    arr = (t.numpy() * 255.0).clip(0, 255).astype(np.uint8)
    if arr.ndim == 2:
        return Image.fromarray(arr).convert("RGB")
    if arr.shape[-1] == 4:  # RGBA → 白底合成
        rgba = Image.fromarray(arr, "RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    return Image.fromarray(arr[..., :3], "RGB")


def _limit_long_side(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    longest = max(w, h)
    if longest <= max_side:
        return img
    s = max_side / float(longest)
    return img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)


def _fit_to(img: Image.Image, size) -> Image.Image:
    """等比缩放到目标框内并居中补黑边，使 A/B 像素级对齐。"""
    tw, th = size
    if img.size == (tw, th):
        return img
    s = min(tw / img.width, th / img.height)
    nw, nh = max(1, int(img.width * s)), max(1, int(img.height * s))
    small = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (tw, th), (0, 0, 0))
    canvas.paste(small, ((tw - nw) // 2, (th - nh) // 2))
    return canvas


def _save_temp(img: Image.Image, tag: str) -> dict:
    out_dir = folder_paths.get_temp_directory()
    os.makedirs(out_dir, exist_ok=True)
    name = "wb_ab_%s_%s.png" % (tag, uuid.uuid4().hex[:10])
    img.save(os.path.join(out_dir, name), format="PNG", optimize=True)
    return {"filename": name, "subfolder": "", "type": "temp"}


def _pil_to_tensor(img: Image.Image) -> torch.Tensor:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _side_by_side(a: Image.Image, b: Image.Image) -> torch.Tensor:
    """保底输出：两张各缩到高 512 后横向拼接。"""
    h = 512
    def scale(im):
        return im.resize((max(1, int(im.width * h / im.height)), h), Image.LANCZOS)
    ra, rb = scale(a), scale(b)
    canvas = Image.new("RGB", (ra.width + rb.width, h), (18, 18, 18))
    canvas.paste(ra, (0, 0))
    canvas.paste(rb, (ra.width, 0))
    return _pil_to_tensor(canvas)


class WBABSliderNode:
    """画布内 A/B 滑块对比（拖动分割线 / 并排 / 交换 / 键盘微调 / 可拉宽）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_a": ("IMAGE",),
                "image_b": ("IMAGE",),
                "label_a": ("STRING", {"default": "A", "multiline": False}),
                "label_b": ("STRING", {"default": "B", "multiline": False}),
                "preview_max_side": (
                    "INT",
                    {
                        "default": 2048,
                        "min": 512,
                        "max": 8192,
                        "step": 256,
                        "tooltip": "前端预览图长边上限。调大可看 4K/8K 细节，但加载更慢、更占内存。",
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("preview",)
    RETURN_TOOLTIPS = ("静态并排预览（保底用），画布里的交互由前端 DOM widget 负责。",)
    FUNCTION = "compare"
    CATEGORY = "image/compare"
    OUTPUT_NODE = True

    def compare(self, **kwargs):
        image_a = kwargs.get("image_a")
        image_b = kwargs.get("image_b")
        label_a = str(_scalar(kwargs.get("label_a"), "A"))
        label_b = str(_scalar(kwargs.get("label_b"), "B"))
        max_side = int(_scalar(kwargs.get("preview_max_side"), 2048))
        unique_id = str(_scalar(kwargs.get("unique_id"), ""))

        if image_a is None or image_b is None:
            raise RuntimeError("[WB A/B Slider] image_a 与 image_b 都必须接上 IMAGE 输入。")

        pa = _limit_long_side(_first_frame(image_a), max_side)
        pb = _limit_long_side(_first_frame(image_b), max_side)

        warning = ""
        if pa.size != pb.size:
            warning = "A/B 尺寸不同 (%sx%s vs %sx%s)，已把 B 等比居中补齐到 A 的尺寸。" % (
                pa.width, pa.height, pb.width, pb.height,
            )
            pb = _fit_to(pb, pa.size)

        info_a = _save_temp(pa, "a")
        info_b = _save_temp(pb, "b")
        info_a["label"] = label_a
        info_b["label"] = label_b
        info_a["width"], info_a["height"] = pa.size
        info_b["width"], info_b["height"] = pb.size

        return {
            "result": (_side_by_side(pa, pb),),
            "ui": {
                "wb_images": [info_a, info_b],
                "wb_labels": [label_a, label_b],
                "wb_node_id": [unique_id],
                "wb_warning": [warning],
            },
        }
