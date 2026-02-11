import fs from "fs";
import path from "path";
import sharp from "sharp";

const rootDir = process.cwd();
const inputPath = path.join(rootDir, "unprocessedImages", "grassland.jpg");
const outputDir = path.join(rootDir, "client-table", "public", "textures");
const outputPath = path.join(outputDir, "grassland.webp");

if (!fs.existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function collectCornerAverage(data, width, height, channels, size, corner) {
  let x0 = 0;
  let y0 = 0;
  if (corner === "tr") x0 = width - size;
  if (corner === "bl") y0 = height - size;
  if (corner === "br") {
    x0 = width - size;
    y0 = height - size;
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y0 + size; y += 1) {
    for (let x = x0; x < x0 + size; x += 1) {
      const i = (y * width + x) * channels;
      r += data[i + 0];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

function makeBackgroundMask(data, width, height, channels, bg, threshold) {
  const total = width * height;
  const dist = new Uint16Array(total);
  const thresholdSq = threshold * threshold;

  for (let i = 0; i < total; i += 1) {
    const p = i * channels;
    const dr = data[p + 0] - bg.r;
    const dg = data[p + 1] - bg.g;
    const db = data[p + 2] - bg.b;
    const d2 = dr * dr + dg * dg + db * db;
    dist[i] = Math.round(Math.sqrt(d2));
  }

  const isBg = new Uint8Array(total);
  const q = [];
  const pushIfBg = (idx) => {
    if (idx < 0 || idx >= total) return;
    if (isBg[idx]) return;
    const d = dist[idx];
    if (d * d > thresholdSq) return;
    isBg[idx] = 1;
    q.push(idx);
  };

  for (let x = 0; x < width; x += 1) {
    pushIfBg(x);
    pushIfBg((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pushIfBg(y * width);
    pushIfBg(y * width + (width - 1));
  }

  for (let head = 0; head < q.length; head += 1) {
    const idx = q[head];
    const x = idx % width;
    const y = Math.floor(idx / width);
    if (x > 0) pushIfBg(idx - 1);
    if (x < width - 1) pushIfBg(idx + 1);
    if (y > 0) pushIfBg(idx - width);
    if (y < height - 1) pushIfBg(idx + width);
  }

  return { isBg, dist };
}

function buildRgba(data, width, height, channels, isBg, dist, edgeSoftness) {
  const total = width * height;
  const out = new Uint8Array(total * 4);

  for (let i = 0; i < total; i += 1) {
    const p = i * channels;
    const o = i * 4;
    out[o + 0] = data[p + 0];
    out[o + 1] = data[p + 1];
    out[o + 2] = data[p + 2];

    if (isBg[i]) {
      out[o + 3] = 0;
      continue;
    }

    const x = i % width;
    const y = Math.floor(i / width);
    const touchingBg =
      (x > 0 && isBg[i - 1]) ||
      (x < width - 1 && isBg[i + 1]) ||
      (y > 0 && isBg[i - width]) ||
      (y < height - 1 && isBg[i + width]);

    if (touchingBg) {
      const d = dist[i];
      const t = clamp((d - edgeSoftness.min) / Math.max(1, edgeSoftness.max - edgeSoftness.min), 0, 1);
      out[o + 3] = Math.round(110 + t * 145);
    } else {
      out[o + 3] = 255;
    }
  }

  return out;
}

function isNeutralBright(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const bright = (r + g + b) / 3;
  return bright > 152 && (mx - mn) < 55;
}

function removeNeutralEdgeBackground(rgba, width, height) {
  const total = width * height;
  const mark = new Uint8Array(total);
  const q = [];
  const pushIfNeutral = (idx) => {
    if (idx < 0 || idx >= total) return;
    if (mark[idx]) return;
    const p = idx * 4;
    if (rgba[p + 3] < 8) return;
    const r = rgba[p + 0];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    if (!isNeutralBright(r, g, b)) return;
    mark[idx] = 1;
    q.push(idx);
  };

  for (let x = 0; x < width; x += 1) {
    pushIfNeutral(x);
    pushIfNeutral((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pushIfNeutral(y * width);
    pushIfNeutral(y * width + (width - 1));
  }

  for (let head = 0; head < q.length; head += 1) {
    const idx = q[head];
    const x = idx % width;
    const y = Math.floor(idx / width);
    if (x > 0) pushIfNeutral(idx - 1);
    if (x < width - 1) pushIfNeutral(idx + 1);
    if (y > 0) pushIfNeutral(idx - width);
    if (y < height - 1) pushIfNeutral(idx + width);
  }

  for (let i = 0; i < total; i += 1) {
    if (!mark[i]) continue;
    rgba[i * 4 + 3] = 0;
  }
}

async function run() {
  fs.mkdirSync(outputDir, { recursive: true });

  const source = sharp(inputPath).rotate().removeAlpha();
  const sourceMeta = await source.metadata();
  const srcW = sourceMeta.width || 0;
  const srcH = sourceMeta.height || 0;
  if (srcW < 8 || srcH < 8) {
    throw new Error(`Invalid source dimensions: ${srcW}x${srcH}`);
  }

  // Use the center field area and avoid tile bevel/background around edges.
  const insetX = Math.max(2, Math.round(srcW * 0.2));
  const insetY = Math.max(2, Math.round(srcH * 0.2));
  const cropLeft = clamp(insetX, 0, srcW - 2);
  const cropTop = clamp(insetY, 0, srcH - 2);
  const cropWidth = clamp(srcW - cropLeft * 2, 2, srcW - cropLeft);
  const cropHeight = clamp(srcH - cropTop * 2, 2, srcH - cropTop);

  const { data, info } = await sharp(inputPath)
    .rotate()
    .removeAlpha()
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const sampleSize = Math.max(12, Math.round(Math.min(width, height) * 0.08));
  const corners = ["tl", "tr", "bl", "br"].map((c) =>
    collectCornerAverage(data, width, height, channels, sampleSize, c)
  );
  const bg = {
    r: corners.reduce((s, c) => s + c.r, 0) / corners.length,
    g: corners.reduce((s, c) => s + c.g, 0) / corners.length,
    b: corners.reduce((s, c) => s + c.b, 0) / corners.length
  };

  const { isBg, dist } = makeBackgroundMask(data, width, height, channels, bg, 42);
  const rgba = buildRgba(data, width, height, channels, isBg, dist, { min: 32, max: 64 });
  removeNeutralEdgeBackground(rgba, width, height);

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize({ width: 512, height: 512, fit: "cover" })
    .webp({
      quality: 82,
      alphaQuality: 85,
      effort: 6,
      smartSubsample: true
    })
    .toFile(outputPath);

  const stats = fs.statSync(outputPath);
  console.log(`Wrote ${path.relative(rootDir, outputPath)} (${Math.round(stats.size / 1024)} KB)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
