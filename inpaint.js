"use strict";

// Vẽ lại vùng được tô bằng model MI-GAN (ONNX) ngay trong trình duyệt.
const Inpaint = (() => {
  const MODEL_URL = "models/migan_pipeline_v2.onnx";
  let sessionPromise;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Không tải được " + src));
      document.head.appendChild(s);
    });
  }

  async function fetchModel(onProgress) {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error("Không tải được model AI (HTTP " + res.status + ")");
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (onProgress && total) onProgress(got / total);
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return buf;
  }

  function load(onProgress) {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (!window.ort) await loadScript("vendor/ort.wasm.min.js");
        ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
        if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
        const model = await fetchModel(onProgress);
        return ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
      })().catch((e) => {
        sessionPromise = null;
        throw e;
      });
    }
    return sessionPromise;
  }

  /** mask: Uint8Array w*h, 1 = cần xoá. Trả về canvas mới. */
  async function runAi(source, mask, onProgress) {
    const session = await load(onProgress);
    const w = source.width, h = source.height, n = w * h;
    const px = source.getContext("2d").getImageData(0, 0, w, h).data;
    const img = new Uint8Array(3 * n);
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      img[i] = px[i * 4];
      img[n + i] = px[i * 4 + 1];
      img[2 * n + i] = px[i * 4 + 2];
      m[i] = mask[i] ? 0 : 255; // model: 255 = giữ, 0 = vẽ lại
    }
    const out = await session.run({
      image: new ort.Tensor("uint8", img, [1, 3, h, w]),
      mask: new ort.Tensor("uint8", m, [1, 1, h, w]),
    });
    const r = out.result.data;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const data = ctx.createImageData(w, h);
    for (let i = 0; i < n; i++) {
      data.data[i * 4] = r[i];
      data.data[i * 4 + 1] = r[n + i];
      data.data[i * 4 + 2] = r[2 * n + i];
      data.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  }

  async function runClassic(source, mask) {
    const cv = await MyBk.loadCv();
    const w = source.width, h = source.height;
    const src = cv.imread(source);
    const rgb = new cv.Mat();
    const m = new cv.Mat(h, w, cv.CV_8U);
    const dst = new cv.Mat();
    try {
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      for (let i = 0; i < w * h; i++) m.data[i] = mask[i] ? 255 : 0;
      cv.inpaint(rgb, m, dst, 5, cv.INPAINT_TELEA);
      const canvas = document.createElement("canvas");
      cv.imshow(canvas, dst);
      return canvas;
    } finally {
      [src, rgb, m, dst].forEach((x) => x.delete());
    }
  }

  /** Thử model AI trước, lỗi thì dùng thuật toán inpaint cổ điển của OpenCV. */
  async function run(source, mask, onProgress) {
    try {
      return { canvas: await runAi(source, mask, onProgress), engine: "AI (MI-GAN)" };
    } catch (e) {
      console.warn("AI inpaint lỗi, chuyển sang OpenCV:", e);
      return { canvas: await runClassic(source, mask), engine: "OpenCV (dự phòng)" };
    }
  }

  return { run, load };
})();
