// WB · A/B Slider —— 画布内可拖动双图对比节点（前端扩展）
//
// 与独立页（已随插件内置：js/WB_AB_Slider.html）的区别：
//   独立页是完整 document，自己算宽高、自己 fetch /history，不受任何布局约束；
//   画布节点必须遵守 LiteGraph 的 widget 布局。这里用 node.addDOMWidget 把容器
//   交给内核托管定位/缩放/HiDPI，内部只用纯 CSS clip-path 做滑块，因此：
//     · 不会再出现「高度写死 20px → 只露一角」
//     · 不会再出现「widgets_values 里序列化了浏览器 Image 对象 → 空白」
//     · 节点右下角可以随意拉宽拉高，对比框跟着变
//   所有运行时状态都挂在内存里，widget.serialize = false，不写进工作流 JSON。
//
// 图片来源：① 节点执行后由后端 ui.wb_images 直接推送（首选，实时、无需重跑）
//          ② 右键菜单 / 「读历史」按钮从 /history 兜底读取（打开旧工作流也能看）

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "WBABSlider";
// 「读历史」不绑定任何工作流专属命名：统一取最近一次运行输出的前两张图，
// 因此对任意工作流都通用。
const STANDALONE_URL = "/extensions/ComfyUI-WB-AB-Slider/WB_AB_Slider.html";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function viewUrl(info, webp) {
    if (!info) return "";
    const q = new URLSearchParams();
    q.set("filename", info.filename || info);
    q.set("subfolder", info.subfolder || "");
    q.set("type", info.type || "temp");
    q.set("rand", Math.random().toString(36).slice(2));
    if (webp) q.set("preview", "webp;88");
    return api.apiURL("/view?" + q.toString());
}

function collectImages(entry) {
    const all = [];
    for (const o of Object.values(entry.outputs || {})) {
        for (const im of (o.images || [])) if (im && im.filename) all.push(im);
    }
    return all;
}

async function loadLatest(widget, quiet) {
    try {
        const r = await fetch("/history?max_items=40", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const hist = await r.json();
        for (const e of Object.values(hist).reverse()) {
            if (e.status && e.status.status_str !== "success") continue;
            const ims = collectImages(e);
            // 通用规则：任意工作流，只要一次运行输出 >= 2 张图就能对比
            if (ims.length < 2) continue;
            const a = ims[0], b = ims[1];
            if (a && b) {
                const short = (i) => String(i.filename || "图").slice(0, 26);
                widget.setImages([a, b], ["A · " + short(a), "B · " + short(b)],
                    "最近一次运行历史", "");
                return true;
            }
        }
        if (!quiet) widget.setStatus("⚠ 运行历史里没找到两张输出图片。接上 image_a / image_b 跑一次工作流即可。", true);
    } catch (err) {
        if (!quiet) widget.setStatus("⚠ 读取历史失败：" + err.message + "。跑一次工作流即可自动显示。", true);
    }
    return false;
}

// --------------------------------------------------------------------------- #
// DOM widget
// --------------------------------------------------------------------------- #
function makeWidget(node) {
    const container = document.createElement("div");
    Object.assign(container.style, {
        width: "100%", height: "100%", display: "flex", flexDirection: "column",
        background: "#14171b", color: "#e8edf3", overflow: "hidden",
        boxSizing: "border-box", border: "1px solid #000", borderRadius: "3px",
        fontFamily: '"Segoe UI","Microsoft YaHei",sans-serif', fontSize: "12px",
    });
    // 阻止交互冒泡到画布（否则拖滑块会变成拖节点 / 平移画布）
    for (const ev of ["pointerdown", "mousedown", "wheel"]) {
        container.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }

    const bar = document.createElement("div");
    Object.assign(bar.style, {
        display: "flex", alignItems: "center", gap: "4px", flex: "0 0 auto",
        padding: "4px 6px", minHeight: "30px", background: "#1c2026",
        borderBottom: "1px solid #333a44", boxSizing: "border-box",
    });
    const mkBtn = (text, title) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.title = title || text;
        Object.assign(b.style, {
            background: "#2a313b", color: "#e8edf3", border: "1px solid #3c4653",
            borderRadius: "4px", padding: "2px 7px", cursor: "pointer",
            fontSize: "11px", lineHeight: "18px", whiteSpace: "nowrap",
        });
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        return b;
    };
    const btnMode = mkBtn("⇔ 滑块", "切换 滑块 / 并排");
    const btnSwap = mkBtn("交换", "交换 A / B");
    const btnReset = mkBtn("50%", "分割线回到 50%");
    const btnLatest = mkBtn("读历史", "从 ComfyUI 运行历史载入最近两路成品");
    const btnFmt = mkBtn("WebP", "切换 WebP 压缩预览 / PNG 原格式");
    const btnOpenA = mkBtn("A ↗", "单独打开 A");
    const btnOpenB = mkBtn("B ↗", "单独打开 B");
    const pct = document.createElement("span");
    Object.assign(pct.style, { marginLeft: "auto", color: "#9fd0ff", fontSize: "11px", whiteSpace: "nowrap" });
    pct.textContent = "50%";
    for (const b of [btnMode, btnSwap, btnReset, btnLatest, btnFmt, btnOpenA, btnOpenB]) bar.appendChild(b);
    bar.appendChild(pct);
    container.appendChild(bar);

    const stage = document.createElement("div");
    stage.setAttribute("data-capture-wheel", "true");
    stage.tabIndex = 0;
    Object.assign(stage.style, {
        position: "relative", flex: "1 1 auto", minHeight: "0",
        background: "#000", overflow: "hidden", cursor: "ew-resize",
        touchAction: "none", userSelect: "none", outline: "none",
    });
    container.appendChild(stage);

    const mkImg = (z) => {
        const im = document.createElement("img");
        Object.assign(im.style, {
            position: "absolute", top: "0", left: "0", width: "100%", height: "100%",
            objectFit: "contain", pointerEvents: "none", userSelect: "none",
            webkitUserDrag: "none", zIndex: String(z),
        });
        im.draggable = false;
        stage.appendChild(im);
        return im;
    };
    const imgB = mkImg(1);   // 底层：B
    const imgA = mkImg(2);   // 上层：A，被 clip-path 裁掉右半边

    const mkLabel = (side) => {
        const s = document.createElement("span");
        Object.assign(s.style, {
            position: "absolute", top: "8px", zIndex: "5", pointerEvents: "none",
            padding: "3px 9px", borderRadius: "4px", fontSize: "11px", fontWeight: "600",
            background: "rgba(0,0,0,.65)", border: "1px solid rgba(255,255,255,.22)",
        });
        s.style[side] = "10px";
        stage.appendChild(s);
        return s;
    };
    const labA = mkLabel("left");
    const labB = mkLabel("right");

    const divider = document.createElement("div");
    Object.assign(divider.style, {
        position: "absolute", top: "0", bottom: "0", left: "50%", width: "2px",
        background: "#fff", zIndex: "4", pointerEvents: "none",
        boxShadow: "0 0 8px rgba(0,0,0,.8)",
    });
    stage.appendChild(divider);

    const handle = document.createElement("div");
    handle.textContent = "‹ ›";
    Object.assign(handle.style, {
        position: "absolute", left: "50%", top: "50%", zIndex: "6",
        transform: "translate(-50%,-50%)", width: "34px", height: "34px",
        borderRadius: "50%", background: "rgba(255,255,255,.95)", color: "#111",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "14px", fontWeight: "700", pointerEvents: "none",
        boxShadow: "0 2px 10px rgba(0,0,0,.6)", letterSpacing: "-2px",
    });
    stage.appendChild(handle);

    const empty = document.createElement("div");
    Object.assign(empty.style, {
        position: "absolute", inset: "0", zIndex: "7", display: "flex",
        alignItems: "center", justifyContent: "center", textAlign: "center",
        color: "#8a94a2", padding: "16px", pointerEvents: "none", lineHeight: "1.8",
    });
    empty.innerHTML = "把两路放大成品接到 <b>image_a</b> / <b>image_b</b> 后运行工作流<br>或点「读历史」载入最近一次结果<br><span style='font-size:11px'>拖节点右下角可拉宽 / 拉高</span>";
    stage.appendChild(empty);

    const status = document.createElement("div");
    Object.assign(status.style, {
        flex: "0 0 auto", padding: "3px 7px", color: "#8a94a2", fontSize: "10px",
        background: "#1c2026", borderTop: "1px solid #333a44",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        boxSizing: "border-box",
    });
    status.textContent = "就绪 · 按住图左右拖 / ← → 微调 / Shift+←→ 大步 / 右下角拉宽";
    container.appendChild(status);

    // 交给内核托管定位：容器永远在节点内，随节点缩放、平移、拉宽一起变化
    const widget = node.addDOMWidget(
        "wb_ab_slider", "wb_ab_slider", container,
        {
            hideOnZoom: false,
            getMinHeight: () => 280,
            getMaxHeight: () => 4000,
            onResize: () => relayout(),
            getValue: () => null,
            setValue: () => {},
        }
    );
    widget.serialize = false;
    widget.parent = node;

    widget.mode = "slider";      // slider | side
    widget.split = 0.5;
    widget.flip = false;
    widget.webp = true;
    widget.infos = null;
    widget.labels = ["A", "B"];
    widget.source = "";
    widget.warning = "";
    widget._dragging = false;

    function pair() {
        if (!widget.infos) return null;
        const i = widget.flip ? [1, 0] : [0, 1];
        return {
            a: widget.infos[i[0]], b: widget.infos[i[1]],
            la: widget.labels[i[0]] || "A", lb: widget.labels[i[1]] || "B",
        };
    }

    function render() {
        const side = widget.mode === "side";
        const p = (widget.split * 100).toFixed(2) + "%";
        stage.style.setProperty("--split", p);
        if (side) {
            imgA.style.clipPath = "none"; imgB.style.clipPath = "none";
            imgA.style.width = "50%"; imgB.style.width = "50%";
            imgA.style.left = "0"; imgB.style.left = "50%";
            divider.style.display = "none"; handle.style.display = "none";
            stage.style.cursor = "default";
        } else {
            imgA.style.width = "100%"; imgB.style.width = "100%";
            imgA.style.left = "0"; imgB.style.left = "0";
            imgB.style.clipPath = "none";
            imgA.style.clipPath = "inset(0 calc(100% - var(--split)) 0 0)";
            divider.style.display = "block"; handle.style.display = "flex";
            divider.style.left = p; handle.style.left = p;
            stage.style.cursor = "ew-resize";
        }
        const pr = pair();
        labA.textContent = pr ? pr.la : "A";
        labB.textContent = pr ? pr.lb : "B";
        pct.textContent = side ? "并排" : Math.round(widget.split * 100) + "%";
        empty.style.display = widget.infos ? "none" : "flex";
    }

    function relayout() {
        render();
        const w = stage.clientWidth, h = stage.clientHeight;
        if (w && h) {
            const tail = widget.warning ? "　⚠ " + widget.warning : "";
            status.textContent = (widget.source || "就绪") + "　|　画幅 " + w + "×" + h
                + "　|　按住图左右拖 / ← → 微调 / 拖节点右下角可拉宽" + tail;
        }
        if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    }

    function setSplit(v) {
        widget.split = clamp(v, 0, 1);
        render();
    }

    function applyPair() {
        const pr = pair();
        if (!pr) return;
        const ua = viewUrl(pr.a, widget.webp), ub = viewUrl(pr.b, widget.webp);
        if (imgA.src !== ua) imgA.src = ua;
        if (imgB.src !== ub) imgB.src = ub;
        render();
        relayout();
    }

    widget.setImages = function (infos, labels, source, warning) {
        this.infos = infos;
        this.labels = (labels && labels.length >= 2) ? labels : ["A", "B"];
        this.source = source || "节点本次运行";
        this.warning = warning || "";
        applyPair();
    };
    widget.setStatus = function (text, warn) {
        status.textContent = text;
        if (warn) status.style.color = "#ffc477";
    };
    widget.refreshLatest = function (quiet) { return loadLatest(this, quiet); };
    widget.relayout = relayout;

    // 拖动 / 键盘
    const localX = (clientX) => {
        const r = stage.getBoundingClientRect();
        return r.width > 0 ? (clientX - r.left) / r.width : 0.5;
    };
    stage.addEventListener("pointerdown", (e) => {
        if (widget.mode === "side") return;
        widget._dragging = true;
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        stage.focus({ preventScroll: true });
        setSplit(localX(e.clientX));
        e.preventDefault(); e.stopPropagation();
    });
    stage.addEventListener("pointermove", (e) => {
        if (!widget._dragging || widget.mode === "side") return;
        setSplit(localX(e.clientX));
        e.stopPropagation();
    });
    const stopDrag = () => { widget._dragging = false; };
    stage.addEventListener("pointerup", stopDrag);
    stage.addEventListener("pointercancel", stopDrag);
    stage.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        if (e.key === "ArrowLeft") { setSplit(widget.split - step); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === "ArrowRight") { setSplit(widget.split + step); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === "Home") { setSplit(0); e.preventDefault(); }
        else if (e.key === "End") { setSplit(1); e.preventDefault(); }
    });

    // 顶部按钮
    btnMode.onclick = () => {
        widget.mode = widget.mode === "slider" ? "side" : "slider";
        btnMode.textContent = widget.mode === "side" ? "▥ 并排" : "⇔ 滑块";
        relayout();
    };
    btnSwap.onclick = () => { widget.flip = !widget.flip; applyPair(); };
    btnReset.onclick = () => setSplit(0.5);
    btnLatest.onclick = () => widget.refreshLatest(false);
    btnFmt.onclick = () => {
        widget.webp = !widget.webp;
        btnFmt.textContent = widget.webp ? "WebP" : "PNG";
        applyPair();
    };
    btnOpenA.onclick = () => { const p = pair(); if (p) window.open(viewUrl(p.a, false), "_blank"); };
    btnOpenB.onclick = () => { const p = pair(); if (p) window.open(viewUrl(p.b, false), "_blank"); };

    const ro = new ResizeObserver(() => relayout());
    ro.observe(stage);
    widget.onRemoved = () => ro.disconnect();

    render();
    return widget;
}

// --------------------------------------------------------------------------- #
// 扩展注册
// --------------------------------------------------------------------------- #
app.registerExtension({
    name: "WB.ABSlider",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this.wb_widget = makeWidget(this);
            // 默认给一个大画幅；从工作流加载时保留用户已经拉过的更大尺寸
            const w = Math.max(760, (this.size && this.size[0]) || 0);
            const h = Math.max(560, (this.size && this.size[1]) || 0);
            this.setSize([w, h]);
            if (typeof this.setDirtyCanvas === "function") this.setDirtyCanvas(true, true);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            // 打开旧工作流也能直接看到上次结果（DOM 挂载完成后再读）
            setTimeout(() => {
                if (this.wb_widget && !this.wb_widget.infos) this.wb_widget.refreshLatest(true);
            }, 800);
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (data) {
            onExecuted?.apply(this, arguments);
            // 清掉内核可能自动挂上的缩略图，避免 widget 下方多一排小图
            this.imgs = null;
            const payload = (data && (data.output || data)) || {};
            const infos = payload.wb_images;
            if (!Array.isArray(infos) || infos.length < 2) return;
            const labels = Array.isArray(payload.wb_labels) ? payload.wb_labels : [];
            const warning = Array.isArray(payload.wb_warning) ? payload.wb_warning[0] : "";
            this.wb_widget?.setImages(infos.slice(0, 2), labels, "节点本次运行", warning || "");
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            onRemoved?.apply(this, arguments);
            this.wb_widget?.onRemoved?.();
            if (this.wb_widget && this.widgets) {
                const i = this.widgets.indexOf(this.wb_widget);
                if (i >= 0) this.widgets.splice(i, 1);
            }
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            options.push(null, {
                content: "🔄 从运行历史重新载入 A / B",
                callback: () => this.wb_widget?.refreshLatest(false),
            }, {
                content: "↗ 打开独立滑块页（备用）",
                callback: () => window.open(STANDALONE_URL, "_blank"),
            });
            return options;
        };
    },
});
