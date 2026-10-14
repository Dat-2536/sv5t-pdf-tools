"use strict";

const { PDFDocument } = PDFLib;
const A4 = [595.28, 841.89];
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|tiff?|avif)$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const icon = (name) => `<svg class="i"><use href="#i-${name}" /></svg>`;
const SEP = `<i class="sep"></i>`;
const ARROW = icon("arrow-right");
const warn = (text) => `<span class="warn">${icon("triangle-alert")} ${text}</span>`;

// ---------- helpers ----------

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

function safeName(name, fallback) {
  const s = (name || "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return s || fallback;
}

function isImage(file) {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Reads the EXIF orientation of a JPEG (1 = normal). */
function jpegOrientation(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little);
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error("Trình duyệt không đọc được ảnh này (HEIC chưa được hỗ trợ).");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function drawToCanvas(bmp, scale = 1, whiteBg = false) {
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (whiteBg) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Không mã hóa được ảnh."))), type, quality)
  );
}

/** Returns { bytes, kind: "jpg" | "png" } ready for pdf-lib. */
async function imageForPdf(file, compress) {
  const isJpeg = /jpe?g|jfif/i.test(file.type) || /\.(jpe?g|jfif)$/i.test(file.name);
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);

  if (!compress) {
    const buf = await file.arrayBuffer();
    if (isJpeg && jpegOrientation(buf) === 1) return { bytes: buf, kind: "jpg" };
    if (isPng) return { bytes: buf, kind: "png" };
  }

  const bmp = await loadBitmap(file);
  if (compress) {
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const blob = await canvasBlob(drawToCanvas(bmp, scale, true), "image/jpeg", 0.8);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  if (isJpeg) {
    const blob = await canvasBlob(drawToCanvas(bmp, 1, true), "image/jpeg", 0.92);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  const blob = await canvasBlob(drawToCanvas(bmp), "image/png");
  return { bytes: await blob.arrayBuffer(), kind: "png" };
}

async function addImagePage(doc, file, { pageMode = "image", compress = false } = {}) {
  const { bytes, kind } = await imageForPdf(file, compress);
  let img;
  try {
    img = kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch {
    // Some exotic PNG/JPEG variants trip pdf-lib; re-encode through canvas.
    const bmp = await loadBitmap(file);
    const blob = await canvasBlob(drawToCanvas(bmp), "image/png");
    img = await doc.embedPng(await blob.arrayBuffer());
  }

  if (pageMode === "a4") {
    const landscape = img.width > img.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  } else {
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
}

// ---------- file lists ----------

const lists = { img2pdf: [], merge: [], compress: [], fit: [], watermark: [] };
const accepts = {
  img2pdf: isImage,
  merge: (f) => isPdf(f) || isImage(f),
  compress: isImage,
  fit: isImage,
  watermark: isImage,
};
const runButtons = {
  img2pdf: "#i2p-run",
  merge: "#merge-run",
  compress: "#c-run",
  fit: "#fit-run",
  watermark: "#wm-run",
};
const listHooks = {};
let uid = 0;

function addFiles(key, files) {
  const ok = [...files].filter(accepts[key]);
  const skipped = files.length - ok.length;
  for (const file of ok) {
    lists[key].push({
      id: ++uid,
      file,
      thumb: isImage(file) ? URL.createObjectURL(file) : null,
    });
  }
  if (skipped) toast(`Bỏ qua ${skipped} file không đúng định dạng.`);
  renderList(key);
  listHooks[key]?.added?.();
}

function removeItem(key, id) {
  const i = lists[key].findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = lists[key].splice(i, 1);
  listHooks[key]?.removed?.(it);
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  renderList(key);
}

function moveItem(key, from, to) {
  const arr = lists[key];
  if (to < 0 || to >= arr.length) return;
  const [it] = arr.splice(from, 1);
  arr.splice(to, 0, it);
  renderList(key);
}

function renderList(key) {
  const box = $(`[data-list="${key}"]`);
  const arr = lists[key];
  box.innerHTML = "";
  arr.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "item";
    row.draggable = true;
    row.dataset.idx = idx;
    row.innerHTML = `
      <span class="grip" title="Kéo để đổi thứ tự">${icon("grip-vertical")}</span>
      ${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : `<span class="thumb">${icon("file-text")}</span>`}
      <div class="meta">
        <div class="name"></div>
        <div class="size">${idx + 1}. ${fmtSize(it.file.size)}</div>
      </div>
      <div class="btns">
        ${key === "watermark" ? `<button data-act="edit" title="Tô vùng cần xoá">${icon("pencil")}</button>` : ""}
        <button data-act="up" title="Lên">${icon("chevron-up")}</button>
        <button data-act="down" title="Xuống">${icon("chevron-down")}</button>
        <button data-act="del" title="Xóa">${icon("x")}</button>
      </div>`;
    $(".name", row).textContent = it.file.name;
    $(".name", row).title = it.file.name;
    row.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "up") moveItem(key, idx, idx - 1);
      if (act === "down") moveItem(key, idx, idx + 1);
      if (act === "del") removeItem(key, it.id);
      if (act === "edit") listHooks[key]?.edit?.(it);
    });
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-idx", String(idx));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/x-idx")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      const from = e.dataTransfer.getData("text/x-idx");
      if (from === "") return;
      e.preventDefault();
      e.stopPropagation();
      moveItem(key, Number(from), idx);
    });
    box.appendChild(row);
  });

  $(runButtons[key]).disabled = arr.length === 0;
}

// ---------- results ----------

function resultsHeader(box, title, zipItems, zipName) {
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `<strong></strong>`;
  $("strong", head).textContent = title;
  if (zipItems && zipItems.length > 1) {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `${icon("folder-down")} Tải tất cả (.zip)`;
    btn.onclick = async () => {
      btn.disabled = true;
      const zip = new JSZip();
      const used = new Set();
      for (const { blob, name } of zipItems) {
        let n = name;
        for (let k = 2; used.has(n); k++) n = `${baseName(name)} (${k})${name.slice(baseName(name).length)}`;
        used.add(n);
        zip.file(n, blob);
      }
      download(await zip.generateAsync({ type: "blob" }), zipName);
      btn.disabled = false;
    };
    head.appendChild(btn);
  }
  box.appendChild(head);
}

function resultRow(box, { name, blob, info, error, previews }) {
  const row = document.createElement("div");
  row.className = "res" + (error ? " error" : "");
  row.innerHTML = `<div class="meta"><div class="name"></div><div class="size"></div></div>`;
  if (previews?.length) {
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    for (const p of previews) {
      const a = document.createElement("a");
      a.href = p.url;
      a.target = "_blank";
      a.title = p.label;
      a.innerHTML = `<img alt="">`;
      a.firstChild.src = p.url;
      thumbs.appendChild(a);
    }
    row.prepend(thumbs);
  }
  $(".name", row).textContent = name;
  const size = $(".size", row);
  if (error) {
    size.textContent = error;
  } else {
    size.innerHTML = info || fmtSize(blob.size);
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.innerHTML = `${icon("download")} Tải về`;
    btn.onclick = () => download(blob, name);
    row.appendChild(btn);
  }
  box.appendChild(row);
}

function progressBar(box) {
  box.innerHTML = `<div class="progress"><div></div></div>`;
  const bar = $(".progress > div", box);
  return (done, total) => (bar.style.width = `${(done / total) * 100}%`);
}

async function withBusy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Đang xử lý...";
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast("Lỗi: " + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

// ---------- Ảnh sang PDF ----------

async function runImg2Pdf() {
  const items = lists.img2pdf;
  const mode = $("#i2p-mode").value;
  const opts = { pageMode: $("#i2p-page").value, compress: $("#i2p-quality").value === "compress" };
  const box = $("#i2p-results");
  const setProgress = progressBar(box);

  if (mode === "one") {
    const doc = await PDFDocument.create();
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      try {
        await addImagePage(doc, items[i].file, opts);
      } catch (e) {
        errors.push({ name: items[i].file.name, error: e.message || String(e) });
      }
      setProgress(i + 1, items.length);
    }
    const name = safeName($("#i2p-name").value, "tong-hop") + ".pdf";
    resultsHeader(box, `Xong: ${doc.getPageCount()} trang`);
    if (doc.getPageCount()) {
      const blob = new Blob([await doc.save()], { type: "application/pdf" });
      resultRow(box, { name, blob, info: `${doc.getPageCount()} trang ${SEP} ${fmtSize(blob.size)}` });
    }
    errors.forEach((e) => resultRow(box, e));
    return;
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    const name = baseName(f.name) + ".pdf";
    try {
      const doc = await PDFDocument.create();
      await addImagePage(doc, f, opts);
      results.push({ name, blob: new Blob([await doc.save()], { type: "application/pdf" }) });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong: ${ok.length}/${results.length} file`, ok, "anh-sang-pdf.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Gộp PDF ----------

async function runMerge() {
  const items = lists.merge;
  const box = $("#merge-results");
  const setProgress = progressBar(box);
  const out = await PDFDocument.create();
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      if (isPdf(f)) {
        const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else {
        await addImagePage(out, f);
      }
    } catch (e) {
      errors.push({ name: f.name, error: "Không đọc được: " + (e.message || e) });
    }
    setProgress(i + 1, items.length);
  }

  const name = safeName($("#merge-name").value, "da-gop") + ".pdf";
  resultsHeader(box, `Xong: ${out.getPageCount()} trang`);
  if (out.getPageCount()) {
    const blob = new Blob([await out.save()], { type: "application/pdf" });
    resultRow(box, { name, blob, info: `${out.getPageCount()} trang ${SEP} ${fmtSize(blob.size)}` });
  }
  errors.forEach((e) => resultRow(box, e));
}

// ---------- Nén ảnh ----------

async function compressOne(file, { mode, targetKB, quality, maxDim, type }) {
  const bmp = await loadBitmap(file);
  const longEdge = Math.max(bmp.width, bmp.height);
  let scale = maxDim > 0 ? Math.min(1, maxDim / longEdge) : 1;
  const whiteBg = type === "image/jpeg";

  if (mode === "quality") {
    const blob = await canvasBlob(drawToCanvas(bmp, scale, whiteBg), type, quality);
    if (scale === 1 && blob.size >= file.size) return { blob: file, scale, kept: true };
    return { blob, scale };
  }

  const target = targetKB * 1024;
  if (file.size <= target && scale === 1) return { blob: file, scale, kept: true };

  let best = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const canvas = drawToCanvas(bmp, scale, whiteBg);
    let lo = 0.3, hi = 0.95, fit = null;
    for (let step = 0; step < 7; step++) {
      const q = (lo + hi) / 2;
      const blob = await canvasBlob(canvas, type, q);
      if (blob.size <= target) { fit = blob; lo = q; } else { hi = q; }
    }
    if (!fit) {
      const blob = await canvasBlob(canvas, type, lo);
      if (blob.size <= target) fit = blob;
      else if (!best || blob.size < best.size) best = blob;
    }
    if (fit) return { blob: fit, scale };
    scale *= 0.8;
  }
  return { blob: best, scale, missed: true };
}

async function runCompress() {
  const items = lists.compress;
  const type = $("#c-format").value;
  const ext = type === "image/webp" ? ".webp" : ".jpg";
  const opts = {
    mode: $("#c-mode").value,
    targetKB: Math.max(10, Number($("#c-target").value) || 500),
    quality: Number($("#c-quality").value) / 100,
    maxDim: Math.max(0, Number($("#c-maxdim").value) || 0),
    type,
  };
  const box = $("#c-results");
  const setProgress = progressBar(box);
  const results = [];
  let before = 0, after = 0;

  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      const r = await compressOne(f, opts);
      const name = r.kept ? f.name : baseName(f.name) + ext;
      const saved = Math.round((1 - r.blob.size / f.size) * 100);
      let info = `${fmtSize(f.size)} ${ARROW} <b>${fmtSize(r.blob.size)}</b>`;
      if (r.kept) info += ` ${SEP} đã đủ nhỏ, giữ nguyên file gốc`;
      else if (saved > 0) info += ` ${SEP} <span class="save">-${saved}%</span>`;
      if (r.scale < 1) info += ` ${SEP} thu nhỏ ${Math.round(r.scale * 100)}%`;
      if (r.missed) info += ` ${SEP} ${warn(`chưa đạt ${opts.targetKB} KB`)}`;
      before += f.size;
      after += r.blob.size;
      results.push({ name, blob: r.blob, info });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }

  const ok = results.filter((r) => !r.error);
  const total = before ? `, tổng ${fmtSize(before)} còn ${fmtSize(after)}` : "";
  resultsHeader(box, `Xong: ${ok.length}/${results.length} ảnh${total}`, ok, "anh-da-nen.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Chỉnh dung lượng theo khoảng MIN-MAX (bản web của resizer/resize.py) ----------

function parseSize(raw) {
  const m = String(raw).trim().toUpperCase().replace(/\s+/g, "").match(/^(\d+(?:[.,]\d+)?)(B|KB|MB|GB)?$/);
  if (!m) throw new Error(`Không hiểu dung lượng "${raw}" (vd. 1MB, 500KB)`);
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] || "MB"];
  const v = Math.floor(parseFloat(m[1].replace(",", ".")) * mult);
  if (v <= 0) throw new Error("Dung lượng phải > 0");
  return v;
}

function gaussianKernel(sigma) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
}

/** Giống PIL UnsharpMask(radius=1.2, percent=140, threshold=2). */
function unsharp(canvas, sigma = 1.2, percent = 140, threshold = 2) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h * 3);
  const blur = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        const p = (y * w + xx) * 4, kv = k[i + r];
        a += src[p] * kv; b += src[p + 1] * kv; c += src[p + 2] * kv;
      }
      const o = (y * w + x) * 3;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        const p = (yy * w + x) * 3, kv = k[i + r];
        a += tmp[p] * kv; b += tmp[p + 1] * kv; c += tmp[p + 2] * kv;
      }
      const o = (y * w + x) * 3;
      blur[o] = a; blur[o + 1] = b; blur[o + 2] = c;
    }
  }
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) {
      const diff = src[i + c] - blur[j + c];
      if (Math.abs(diff) >= threshold) src[i + c] = src[i + c] + (diff * percent) / 100;
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/** Chèn segment COM (FF FE) trước EOI để file đạt targetSize; ảnh hiển thị không đổi. */
async function padJpeg(blob, targetSize) {
  if (blob.size >= targetSize) return blob;
  const data = new Uint8Array(await blob.arrayBuffer());
  let eoi = -1;
  for (let i = data.length - 2; i >= 0; i--) {
    if (data[i] === 0xff && data[i + 1] === 0xd9) { eoi = i; break; }
  }
  if (eoi < 0) return blob;
  const parts = [data.subarray(0, eoi)];
  let remaining = targetSize - data.length;
  while (remaining > 0) {
    const payload = Math.min(65533, Math.max(0, remaining - 4));
    const seg = new Uint8Array(payload + 4);
    seg[0] = 0xff; seg[1] = 0xfe;
    seg[2] = (payload + 2) >> 8; seg[3] = (payload + 2) & 0xff;
    parts.push(seg);
    remaining -= seg.length;
  }
  parts.push(data.subarray(eoi));
  return new Blob(parts, { type: "image/jpeg" });
}

const encodeJpeg = (canvas, q) => canvasBlob(canvas, "image/jpeg", q);

/** Nén JPEG chất lượng cao nhất mà vẫn <= maxBytes, không được thì thu nhỏ dần. */
async function compressToMax(canvas, maxBytes) {
  const search = async (c) => {
    let lo = 35, hi = 95;
    let best = await encodeJpeg(c, lo / 100);
    if (best.size > maxBytes) return best;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const cand = await encodeJpeg(c, mid / 100);
      if (cand.size <= maxBytes) { best = cand; lo = mid; } else { hi = mid - 1; }
    }
    return best;
  };
  let best = await search(canvas);
  if (best.size <= maxBytes) return { blob: best, scale: 1 };
  let scale = 0.92, total = 1;
  for (let i = 0; i < 12; i++) {
    total *= scale;
    const w = Math.max(64, Math.round(canvas.width * total));
    const h = Math.max(64, Math.round(canvas.height * total));
    best = await search(drawToCanvas(canvas, w / canvas.width, true));
    if (best.size <= maxBytes) return { blob: best, scale: total };
    scale = 0.9;
  }
  return { blob: best, scale: total };
}

async function fitOne(file, cfg) {
  const bmp = await loadBitmap(file);
  let canvas = drawToCanvas(bmp, 1, true);
  const notes = [];
  let wmRemoved = false;
  if (cfg.removeWm && canvas.width * canvas.height <= 2_000_000) {
    const r = await MyBk.remove(canvas);
    if (r.removed) {
      canvas = r.canvas;
      wmRemoved = true;
      notes.push(`đã xoá watermark (${r.hits} chữ)`);
    }
  }

  const size = file.size;
  const inRange = size >= cfg.min && size <= cfg.max;
  if (inRange && !wmRemoved) return { blob: file, kept: true, notes: ["đã nằm trong khoảng, giữ nguyên"] };

  let blob;
  if (size > cfg.max || inRange) {
    const r = await compressToMax(canvas, cfg.max);
    blob = r.blob;
    if (size > cfg.max) notes.push("nén");
    if (r.scale < 1) notes.push(`thu nhỏ ${Math.round(r.scale * 100)}%`);
  } else {
    // Ảnh vừa xoá watermark không làm nét để khỏi làm lộ vết chữ còn sót.
    const sharpen = cfg.sharpen && !wmRemoved;
    const work = sharpen ? unsharp(canvas) : canvas;
    if (sharpen) notes.push("làm nét");
    blob = await encodeJpeg(work, 0.98);
    for (let ratio = 1.05; blob.size < cfg.min && ratio <= cfg.maxUpscale + 1e-9; ratio += 0.03) {
      const cand = await encodeJpeg(drawToCanvas(work, ratio), 0.98);
      blob = cand;
      if (cand.size >= cfg.min) notes.push(`phóng to ${ratio.toFixed(2)}x`);
    }
    if (blob.size < cfg.min) blob = await encodeJpeg(work, 1);
  }

  if (blob.size > cfg.max) {
    const r = await compressToMax(canvas, cfg.max);
    blob = r.blob;
  }
  if (blob.size < cfg.min && cfg.pad) {
    const before = blob.size;
    blob = await padJpeg(blob, cfg.min);
    notes.push(`pad metadata +${fmtSize(blob.size - before)}`);
  }
  return { blob, notes, outOfRange: blob.size < cfg.min || blob.size > cfg.max };
}

async function runFit() {
  let cfg;
  try {
    cfg = {
      min: parseSize($("#fit-min").value),
      max: parseSize($("#fit-max").value),
      maxUpscale: Math.max(1, Number($("#fit-upscale").value) || 1),
      sharpen: $("#fit-sharpen").checked,
      pad: $("#fit-pad").checked,
      removeWm: $("#fit-wm").checked,
    };
  } catch (e) {
    toast(e.message);
    return;
  }
  if (cfg.min > cfg.max) {
    toast("Tối thiểu phải nhỏ hơn hoặc bằng tối đa.");
    return;
  }

  const items = lists.fit;
  const box = $("#fit-results");
  const setProgress = progressBar(box);
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      const r = await fitOne(f, cfg);
      const name = r.kept ? f.name : baseName(f.name) + ".jpg";
      let info = `${fmtSize(f.size)} ${ARROW} <b>${fmtSize(r.blob.size)}</b>`;
      for (const note of r.notes) info += ` ${SEP} ${note}`;
      if (r.outOfRange) info += ` ${SEP} ${warn("chưa vào khoảng yêu cầu")}`;
      results.push({ name, blob: r.blob, info });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong: ${ok.length}/${results.length} ảnh, khoảng ${fmtSize(cfg.min)} đến ${fmtSize(cfg.max)}`, ok, "anh-da-chinh.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Xoá watermark ----------

const wmResults = new Map(); // item id -> result

function renderWmResults() {
  const box = $("#wm-results");
  const items = lists.watermark.filter((it) => wmResults.has(it.id));
  if (!items.length) {
    box.innerHTML = "";
    return;
  }
  const rows = items.map((it) => wmResults.get(it.id));
  const ok = rows.filter((r) => !r.error);
  resultsHeader(box, `Kết quả: ${ok.length} ảnh`, ok, "anh-da-xoa-watermark.zip");
  rows.forEach((r) => resultRow(box, r));
}

function setWmResult(item, result) {
  const old = wmResults.get(item.id);
  if (old?.previews) old.previews.forEach((p) => p.revoke && URL.revokeObjectURL(p.url));
  wmResults.set(item.id, result);
  renderWmResults();
}

async function wmOutput(item, canvas, info) {
  const blob = await encodeJpeg(canvas, 0.95);
  const url = URL.createObjectURL(blob);
  return {
    name: baseName(item.file.name) + ".jpg",
    blob,
    info: `${info} ${SEP} ${fmtSize(blob.size)}`,
    previews: [
      { url: item.thumb, label: "Ảnh gốc" },
      { url, label: "Sau khi xoá", revoke: true },
    ],
  };
}

async function runWatermarkAuto() {
  const items = lists.watermark;
  const strength = Number($("#wm-strength").value);
  const btn = $("#wm-run");
  for (let i = 0; i < items.length; i++) {
    btn.textContent = `Đang xử lý ${i + 1}/${items.length}...`;
    const it = items[i];
    try {
      const canvas = drawToCanvas(await loadBitmap(it.file), 1, true);
      if (canvas.width * canvas.height > 2_000_000) throw new Error("Ảnh quá lớn cho chế độ myBk, hãy dùng chế độ tô vùng.");
      const r = await MyBk.remove(canvas, { strength });
      if (!r.removed) {
        setWmResult(it, { name: it.file.name, error: `Không thấy watermark myBk (chỉ khớp ${r.hits} chữ), thử chế độ tô vùng.` });
      } else {
        setWmResult(it, await wmOutput(it, r.canvas, `Đã xoá ${r.hits} chữ watermark`));
      }
    } catch (e) {
      setWmResult(it, { name: it.file.name, error: e.message || String(e) });
    }
  }
}

const editor = {
  item: null,
  base: null,
  original: null,
  history: [],
  tool: "paint",
  painting: false,
  last: null,
};

function edDraw(canvas) {
  const img = $("#ed-img");
  img.width = canvas.width;
  img.height = canvas.height;
  img.getContext("2d").drawImage(canvas, 0, 0);
}

function edClearMask() {
  const m = $("#ed-mask");
  m.getContext("2d").clearRect(0, 0, m.width, m.height);
}

function edStatus(text) {
  $("#ed-status").textContent = text;
}

async function openEditor(item) {
  editor.item = item;
  const canvas = drawToCanvas(await loadBitmap(item.file), 1, true);
  editor.original = canvas;
  editor.base = canvas;
  editor.history = [];
  $("#ed-undo").disabled = true;
  $("#ed-name").textContent = item.file.name;
  edDraw(canvas);
  const m = $("#ed-mask");
  m.width = canvas.width;
  m.height = canvas.height;
  edClearMask();
  $("#wm-editor").hidden = false;
  $("#wm-editor").scrollIntoView({ behavior: "smooth", block: "start" });
  edStatus('Tô lên chữ/logo cần xoá rồi bấm "Xoá vùng đã tô".');
  Inpaint.load((p) => edStatus(`Đang tải model AI... ${Math.round(p * 100)}%`))
    .then(() => edStatus('Model AI sẵn sàng. Tô lên vùng cần xoá rồi bấm "Xoá vùng đã tô".'))
    .catch(() => edStatus("Không tải được model AI, sẽ dùng thuật toán OpenCV thay thế."));
}

function closeEditor() {
  editor.item = null;
  $("#wm-editor").hidden = true;
}

function edPoint(e) {
  const m = $("#ed-mask");
  const rect = m.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * m.width,
    y: ((e.clientY - rect.top) / rect.height) * m.height,
    scale: m.width / rect.width,
  };
}

function edStroke(from, to) {
  const ctx = $("#ed-mask").getContext("2d");
  ctx.globalCompositeOperation = editor.tool === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = "#ff1744";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Number($("#ed-brush").value) * to.scale;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x + 0.01, to.y);
  ctx.stroke();
}

function edMask() {
  const m = $("#ed-mask");
  const a = m.getContext("2d").getImageData(0, 0, m.width, m.height).data;
  const mask = new Uint8Array(m.width * m.height);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (a[i * 4 + 3] > 0) { mask[i] = 1; count++; }
  }
  return count ? mask : null;
}

async function edRun() {
  const mask = edMask();
  if (!mask) {
    toast("Chưa tô vùng nào.");
    return;
  }
  const btn = $("#ed-run");
  btn.disabled = true;
  edStatus("Đang xoá...");
  try {
    const t = performance.now();
    const r = await Inpaint.run(editor.base, mask, (p) => edStatus(`Đang tải model AI... ${Math.round(p * 100)}%`));
    editor.history.push(editor.base);
    editor.base = r.canvas;
    $("#ed-undo").disabled = false;
    edDraw(r.canvas);
    edClearMask();
    edStatus(`Xong bằng ${r.engine} (${((performance.now() - t) / 1000).toFixed(1)}s). Còn sót thì tô tiếp và chạy lại.`);
  } catch (e) {
    console.error(e);
    edStatus("Lỗi: " + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

async function edSave() {
  const it = editor.item;
  if (!it) return;
  if (!editor.history.length) {
    toast("Chưa xoá gì trên ảnh này.");
    return;
  }
  setWmResult(it, await wmOutput(it, editor.base, `Đã xoá ${editor.history.length} lượt bằng AI`));
  const next = lists.watermark.find((x) => !wmResults.has(x.id));
  if (next) openEditor(next);
  else {
    closeEditor();
    toast("Đã xử lý hết ảnh trong danh sách.");
  }
}

function wmModeChanged() {
  const brush = $("#wm-mode").value === "brush";
  $("#wm-strength-wrap").hidden = brush;
  $("#wm-run").textContent = brush ? "Bắt đầu tô ảnh đầu tiên" : "Xoá watermark";
  if (!brush) closeEditor();
}

listHooks.watermark = {
  edit: (it) => {
    $("#wm-mode").value = "brush";
    wmModeChanged();
    openEditor(it);
  },
  added: () => {
    if ($("#wm-mode").value === "brush" && !editor.item) {
      const next = lists.watermark.find((x) => !wmResults.has(x.id));
      if (next) openEditor(next);
    }
  },
  removed: (it) => {
    wmResults.get(it.id)?.previews?.forEach((p) => p.revoke && URL.revokeObjectURL(p.url));
    wmResults.delete(it.id);
    if (editor.item === it) closeEditor();
    renderWmResults();
  },
};

$("#wm-mode").addEventListener("change", wmModeChanged);
$("#wm-strength").addEventListener("input", (e) => ($("#wm-strength-val").textContent = e.target.value));
$("#wm-run").addEventListener("click", (e) => {
  if ($("#wm-mode").value === "brush") {
    const next = lists.watermark.find((x) => !wmResults.has(x.id)) || lists.watermark[0];
    if (next) openEditor(next);
  } else {
    withBusy(e.currentTarget, runWatermarkAuto);
  }
});

const maskEl = $("#ed-mask");
maskEl.addEventListener("pointerdown", (e) => {
  editor.painting = true;
  maskEl.setPointerCapture(e.pointerId);
  editor.last = edPoint(e);
  edStroke(editor.last, editor.last);
});
maskEl.addEventListener("pointermove", (e) => {
  if (!editor.painting) return;
  const p = edPoint(e);
  edStroke(editor.last, p);
  editor.last = p;
});
["pointerup", "pointercancel"].forEach((ev) => maskEl.addEventListener(ev, () => (editor.painting = false)));

$("#ed-tool").addEventListener("click", (e) => {
  editor.tool = editor.tool === "paint" ? "erase" : "paint";
  e.currentTarget.innerHTML = editor.tool === "paint"
    ? `${icon("paintbrush")}<span>Đang tô</span>`
    : `${icon("eraser")}<span>Đang tẩy</span>`;
});
$("#ed-clear").addEventListener("click", edClearMask);
$("#ed-undo").addEventListener("click", () => {
  if (!editor.history.length) return;
  editor.base = editor.history.pop();
  edDraw(editor.base);
  $("#ed-undo").disabled = !editor.history.length;
});
const peek = $("#ed-peek");
peek.addEventListener("pointerdown", () => editor.original && edDraw(editor.original));
["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
  peek.addEventListener(ev, () => editor.base && edDraw(editor.base))
);
$("#ed-run").addEventListener("click", edRun);
$("#ed-save").addEventListener("click", edSave);
$("#ed-close").addEventListener("click", closeEditor);

// ---------- wiring ----------

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab.dataset.tab));
  })
);

$$(".drop").forEach((drop) => {
  const key = drop.dataset.target;
  const input = $("input", drop);
  input.addEventListener("change", () => {
    addFiles(key, input.files);
    input.value = "";
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("over");
    addFiles(key, e.dataTransfer.files);
  });
});

// Dropping files anywhere on the active panel also works.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.dataTransfer.files.length) return;
  const active = $(".panel.active .drop");
  if (active) addFiles(active.dataset.target, e.dataTransfer.files);
});

$$("[data-sort]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const key = btn.dataset.sort;
    lists[key].sort((a, b) =>
      a.file.name.localeCompare(b.file.name, "vi", { numeric: true, sensitivity: "base" })
    );
    renderList(key);
  })
);

$$("[data-clear]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const key = btn.dataset.clear;
    lists[key].forEach((it) => {
      listHooks[key]?.removed?.(it);
      if (it.thumb) URL.revokeObjectURL(it.thumb);
    });
    lists[key] = [];
    renderList(key);
  })
);

$("#i2p-mode").addEventListener("change", (e) => ($("#i2p-name-wrap").hidden = e.target.value !== "one"));
$("#c-mode").addEventListener("change", (e) => {
  $("#c-target-wrap").hidden = e.target.value !== "target";
  $("#c-quality-wrap").hidden = e.target.value !== "quality";
});
$("#c-quality").addEventListener("input", (e) => ($("#c-quality-val").textContent = e.target.value));

function dressSelects() {
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const closePick = (pick) => {
    pick.classList.remove("open");
    const menu = $(".pick-menu", pick);
    const btn = $(".pick-btn", pick);
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  };
  $$("select").forEach((sel) => {
    const pick = document.createElement("div");
    pick.className = "pick";
    sel.before(pick);
    pick.appendChild(sel);
    sel.classList.add("pick-native");
    sel.tabIndex = -1;
    sel.addEventListener("focus", () => btn.focus());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pick-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `<span class="pick-label"></span><svg class="i pick-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
    const menu = document.createElement("div");
    menu.className = "pick-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    pick.append(btn, menu);

    const label = $(".pick-label", btn);
    const paint = () => {
      label.textContent = sel.selectedOptions[0]?.textContent.trim() || "";
      $$(".pick-opt", menu).forEach((opt) => {
        opt.setAttribute("aria-selected", opt.dataset.value === sel.value ? "true" : "false");
      });
    };
    menu.replaceChildren(...[...sel.options].map((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pick-opt";
      item.setAttribute("role", "option");
      item.dataset.value = opt.value;
      item.textContent = opt.textContent.trim();
      item.addEventListener("click", () => {
        if (sel.value !== opt.value) {
          valueDesc.set.call(sel, opt.value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        paint();
        closePick(pick);
        btn.focus();
      });
      return item;
    }));
    Object.defineProperty(sel, "value", {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) {
        valueDesc.set.call(this, v);
        paint();
      },
    });
    paint();

    btn.addEventListener("click", () => {
      const willOpen = menu.hidden;
      $$(".pick.open").forEach(closePick);
      if (!willOpen) return;
      menu.hidden = false;
      pick.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePick(pick);
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        if (menu.hidden) {
          e.preventDefault();
          btn.click();
        }
      }
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pick")) $$(".pick.open").forEach(closePick);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".pick.open").forEach(closePick);
  });
}
dressSelects();

$("#i2p-run").addEventListener("click", (e) => withBusy(e.currentTarget, runImg2Pdf));
$("#merge-run").addEventListener("click", (e) => withBusy(e.currentTarget, runMerge));
$("#c-run").addEventListener("click", (e) => withBusy(e.currentTarget, runCompress));
$("#fit-run").addEventListener("click", (e) => withBusy(e.currentTarget, runFit));
