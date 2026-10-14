"use strict";

// Bản JS của resizer/watermark.py: dò từng chữ www.hcmut.edu.vn trên ảnh thẻ myBk
// bằng template matching rồi lấp nét chữ bằng nền cục bộ.
const MyBk = (() => {
  const GLYPH_SIZE_RANGE = [0.07, 0.28];
  const MATCH_THRESHOLD = 0.45;
  const CONFIDENT_SCORE = 0.5;

  let cvPromise;
  function loadCv() {
    if (!cvPromise) {
      cvPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/opencv.js";
        s.onload = () => {
          const ready = (mod) => {
            // Emscripten module có hàm then(); xoá đi để Promise không chờ nó mãi.
            delete mod.then;
            resolve(mod);
          };
          const c = window.cv;
          if (c instanceof Promise) c.then(ready);
          else if (c.Mat) ready(c);
          else c.onRuntimeInitialized = () => ready(c);
        };
        s.onerror = () => reject(new Error("Không tải được OpenCV.js"));
        document.head.appendChild(s);
      });
    }
    return cvPromise;
  }

  function decodeGlyph(cv) {
    const bin = atob(MYBK_GLYPH.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mat = new cv.Mat(MYBK_GLYPH.size, MYBK_GLYPH.size, cv.CV_32F);
    mat.data32F.set(new Float32Array(bytes.buffer));
    return mat;
  }

  // Mọi Mat tạo trong một lần xử lý được gom lại để giải phóng một lượt.
  class Ctx {
    constructor(cv) {
      this.cv = cv;
      this.mats = [];
      this.ellipses = new Map();
      this.kernels = new Map();
      this.glyph = this.track(decodeGlyph(cv));
      this.border = cv.morphologyDefaultBorderValue();
    }
    track(m) {
      this.mats.push(m);
      return m;
    }
    mat(rows, cols, type) {
      return this.track(new this.cv.Mat(rows, cols, type));
    }
    ellipse(n) {
      if (!this.ellipses.has(n)) {
        this.ellipses.set(n, this.track(this.cv.getStructuringElement(this.cv.MORPH_ELLIPSE, new this.cv.Size(n, n))));
      }
      return this.ellipses.get(n);
    }
    kernel(size) {
      if (!this.kernels.has(size)) {
        const k = this.track(new this.cv.Mat());
        this.cv.resize(this.glyph, k, new this.cv.Size(size, size), 0, 0, this.cv.INTER_AREA);
        this.kernels.set(size, k);
      }
      return this.kernels.get(size);
    }
    dilate(src, n) {
      const dst = this.track(new this.cv.Mat());
      this.cv.dilate(src, dst, this.ellipse(n), new this.cv.Point(-1, -1), 1, this.cv.BORDER_CONSTANT, this.border);
      return dst;
    }
    close(src, n) {
      const dst = this.track(new this.cv.Mat());
      this.cv.morphologyEx(src, dst, this.cv.MORPH_CLOSE, this.ellipse(n), new this.cv.Point(-1, -1), 1, this.cv.BORDER_CONSTANT, this.border);
      return dst;
    }
    free() {
      this.mats.forEach((m) => m.delete());
      this.mats = [];
    }
  }

  /** rgb: Float32Array h*w*3 -> Mat float32 độ tối nét mảnh, cắt [0, 0.2]. */
  function strokes(ctx, rgb, w, h) {
    const { cv } = ctx;
    const u8 = ctx.mat(h, w, cv.CV_8UC3);
    for (let i = 0; i < rgb.length; i++) u8.data[i] = Math.min(255, Math.max(0, Math.trunc(rgb[i])));
    const gray = ctx.track(new cv.Mat());
    cv.cvtColor(u8, gray, cv.COLOR_RGB2GRAY);
    const lg = ctx.mat(h, w, cv.CV_32F);
    for (let i = 0; i < w * h; i++) lg.data32F[i] = Math.log(gray.data[i] + 1);
    const closed = ctx.close(lg, 5);
    const out = ctx.mat(h, w, cv.CV_32F);
    for (let i = 0; i < w * h; i++) out.data32F[i] = Math.min(0.2, Math.max(0, closed.data32F[i] - lg.data32F[i]));
    return out;
  }

  function match(ctx, st, size) {
    const { cv } = ctx;
    const padded = ctx.track(new cv.Mat());
    cv.copyMakeBorder(st, padded, size, size, size, size, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const resp = ctx.track(new cv.Mat());
    cv.matchTemplate(padded, ctx.kernel(size), resp, cv.TM_CCOEFF_NORMED);
    return resp;
  }

  function peaks(ctx, resp, thr, minDist) {
    const local = ctx.dilate(resp, Math.max(3, minDist));
    const r = resp.data32F, l = local.data32F, cols = resp.cols;
    const out = [];
    for (let i = 0; i < r.length; i++) {
      if (r[i] > thr && r[i] === l[i]) out.push([r[i], i % cols, Math.floor(i / cols)]);
    }
    return out.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  }

  function sizeScore(ctx, st, size) {
    const top = peaks(ctx, match(ctx, st, size), 0, Math.floor(size / 2)).slice(0, 12);
    return top.length ? top.reduce((s, p) => s + p[0], 0) / top.length : -1;
  }

  function argmaxSize(sizes, score) {
    let best = sizes[0], bestScore = -Infinity;
    for (const s of sizes) {
      const v = score(s);
      if (v > bestScore) { best = s; bestScore = v; }
    }
    return best;
  }

  function range(a, b, step = 1) {
    const out = [];
    for (let i = a; i < b; i += step) out.push(i);
    return out;
  }

  function bestSize(ctx, st) {
    const w = st.cols;
    const lo = Math.max(8, Math.trunc(w * GLYPH_SIZE_RANGE[0]));
    const hi = Math.trunc(w * GLYPH_SIZE_RANGE[1]);
    const coarse = argmaxSize(range(lo, hi + 1, 3), (s) => sizeScore(ctx, st, s));
    const fine = range(Math.max(lo, coarse - 2), Math.min(hi, coarse + 2) + 1);
    return argmaxSize(fine, (s) => sizeScore(ctx, st, s));
  }

  function findInstances(ctx, rgb, w, h, base) {
    if (!(w / h >= 0.6 && w / h <= 0.8)) return { instances: [], base };
    const st = strokes(ctx, rgb, w, h);
    if (base == null) base = bestSize(ctx, st);
    const responses = new Map();
    for (let s = Math.max(8, base - 2); s < base + 3; s++) responses.set(s, match(ctx, st, s));
    const instances = [];
    for (const [score, x, y] of peaks(ctx, responses.get(base), MATCH_THRESHOLD, Math.floor(base / 2))) {
      let best = [score, base, x, y];
      for (const [size, resp] of responses) {
        const x0 = Math.max(0, x - 2), y0 = Math.max(0, y - 2);
        const x1 = Math.min(x + 3, resp.cols), y1 = Math.min(y + 3, resp.rows);
        let wv = -Infinity, wx = 0, wy = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const v = resp.data32F[yy * resp.cols + xx];
            if (v > wv) { wv = v; wx = xx; wy = yy; }
          }
        }
        if (wv > best[0]) best = [wv, size, wx, wy];
      }
      const [bs, size, bx, by] = best;
      instances.push({ x: bx - size, y: by - size, size, score: bs });
    }
    return { instances, base };
  }

  function renderDepth(ctx, instances, w, h) {
    const margin = Math.max(0, ...instances.map((i) => i.size));
    const cw = w + 2 * margin, ch = h + 2 * margin;
    const canvas = new Float32Array(cw * ch);
    for (const inst of instances) {
      const k = ctx.kernel(inst.size).data32F;
      const cx = inst.x + margin, cy = inst.y + margin;
      for (let ky = 0; ky < inst.size; ky++) {
        const yy = cy + ky;
        if (yy < 0 || yy >= ch) continue;
        for (let kx = 0; kx < inst.size; kx++) {
          const xx = cx + kx;
          if (xx < 0 || xx >= cw) continue;
          const v = k[ky * inst.size + kx];
          const idx = yy * cw + xx;
          if (v > canvas[idx]) canvas[idx] = v;
        }
      }
    }
    const depth = ctx.mat(h, w, ctx.cv.CV_32F);
    for (let y = 0; y < h; y++) {
      depth.data32F.set(canvas.subarray((y + margin) * cw + margin, (y + margin) * cw + margin + w), y * w);
    }
    return depth;
  }

  function removeStrokes(ctx, rgb, depth, strength, w, h) {
    const { cv } = ctx;
    const n = w * h;
    const mask = ctx.mat(h, w, cv.CV_8U);
    for (let i = 0; i < n; i++) mask.data[i] = depth.data32F[i] > 0.003 ? 1 : 0;
    const band = ctx.dilate(mask, 5);

    const rgbMat = ctx.mat(h, w, cv.CV_32FC3);
    rgbMat.data32F.set(rgb);
    const bg = ctx.close(rgbMat, 7).data32F;
    const wide = ctx.dilate(depth, 5).data32F;

    const bandF = ctx.mat(h, w, cv.CV_32F);
    for (let i = 0; i < n; i++) bandF.data32F[i] = band.data[i];
    const softMat = ctx.track(new cv.Mat());
    cv.GaussianBlur(bandF, softMat, new cv.Size(0, 0), 0.7, 0, cv.BORDER_DEFAULT);
    const soft = softMat.data32F;

    const out = new Float32Array(rgb.length);
    for (let i = 0; i < n; i++) {
      const e = Math.exp(Math.max(wide[i], 0.01) * strength);
      const s = soft[i];
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        const v = rgb[j];
        const target = Math.min(bg[j], Math.max((v + 1) * e - 1, v));
        out[j] = Math.min(255, Math.max(0, v * (1 - s) + target * s));
      }
    }
    return out;
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Xoá watermark myBk trên canvas. Trả về { canvas, removed, hits }.
   * Canvas gốc không bị sửa.
   */
  async function remove(source, { strength = 7, passes = 2, minHits = 8 } = {}) {
    const cv = await loadCv();
    const w = source.width, h = source.height;
    const px = source.getContext("2d").getImageData(0, 0, w, h).data;
    let rgb = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2];
    }

    const ctx = new Ctx(cv);
    try {
      let { instances } = findInstances(ctx, rgb, w, h);
      const hits = instances.filter((i) => i.score >= CONFIDENT_SCORE).length;
      if (hits < minHits) return { canvas: source, removed: false, hits };
      const base = Math.trunc(median(instances.map((i) => i.size)));
      for (let pass = 0; pass < passes; pass++) {
        if (pass > 0) {
          instances = findInstances(ctx, rgb, w, h, base).instances;
          if (!instances.length) break;
        }
        rgb = removeStrokes(ctx, rgb, renderDepth(ctx, instances, w, h), strength, w, h);
      }

      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const octx = out.getContext("2d");
      const img = octx.createImageData(w, h);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
        img.data[i] = rgb[j]; img.data[i + 1] = rgb[j + 1]; img.data[i + 2] = rgb[j + 2];
        img.data[i + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      return { canvas: out, removed: true, hits };
    } finally {
      ctx.free();
    }
  }

  return { remove, loadCv };
})();
