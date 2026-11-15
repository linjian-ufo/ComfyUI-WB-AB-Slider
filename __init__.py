"""WB A/B Slider —— 画布内可拖动的双图滑块对比节点。

由 WB_AB_Slider.html 独立页改造而来：把原来「独立网页读 /history」的逻辑
搬进 ComfyUI 节点，图片直接由两路 IMAGE 输入推送，不再依赖手工刷新。
独立页也随插件内置（js/WB_AB_Slider.html），作为画布控件之外的备用查看方式。
"""

from .nodes import WBABSliderNode

NODE_CLASS_MAPPINGS = {
    "WBABSlider": WBABSliderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WBABSlider": "WB · A/B 滑块对比 (画布内)",
}

# ComfyUI 会把该目录下的 .js 注册成前端扩展
WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
