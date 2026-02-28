import express from 'express';
import cors from 'cors';
import sharp from 'sharp';

const app = express();
const port = Number(process.env.PORT || 8787);
const revision = process.env.KLAVIYO_REVISION || '2025-10-15';
const defaultJpegQuality = Number(process.env.SLICE_JPEG_QUALITY || 80);
const minJpegQuality = Number(process.env.SLICE_MIN_JPEG_QUALITY || 60);
const targetSliceKb = Number(process.env.SLICE_TARGET_KB || 250);

app.use(cors());
app.use(express.json({ limit: '35mb' }));

function extractErrorText(payload, fallback) {
  if (payload && payload.errors && payload.errors[0] && payload.errors[0].detail) {
    return payload.errors[0].detail;
  }
  if (payload && payload.error) return payload.error;
  return fallback;
}

function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function px(val, scale) {
  return Math.max(0, Math.round(Number(val || 0) * scale));
}

function bytesToKb(bytes) {
  return Math.round((Number(bytes || 0) / 1024) * 100) / 100;
}

function normalizeAccountId(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return val.replace(/[^a-z0-9_-]/g, '');
}

function readConfiguredAccounts() {
  const configured = String(process.env.KLAVIYO_ACCOUNTS || '')
    .split(',')
    .map((v) => normalizeAccountId(v))
    .filter(Boolean);
  return Array.from(new Set(configured));
}

function accountEnvKey(accountId) {
  return `KLAVIYO_API_KEY_${String(accountId || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')}`;
}

function resolveApiKey(accountIdRaw) {
  const accountId = normalizeAccountId(accountIdRaw);
  const configured = readConfiguredAccounts();

  if (accountId) {
    const envName = accountEnvKey(accountId);
    const key = process.env[envName];
    if (!key) {
      return {
        ok: false,
        error: `No API key configured for accountId "${accountId}". Expected env: ${envName}`
      };
    }
    return { ok: true, accountId, apiKey: key, source: envName };
  }

  const fallback = process.env.KLAVIYO_API_KEY || process.env.KLAVIYO_PRIVATE_KEY;
  if (fallback) {
    return { ok: true, accountId: 'default', apiKey: fallback, source: process.env.KLAVIYO_API_KEY ? 'KLAVIYO_API_KEY' : 'KLAVIYO_PRIVATE_KEY' };
  }

  if (configured.length) {
    const first = configured[0];
    const envName = accountEnvKey(first);
    const key = process.env[envName];
    if (key) return { ok: true, accountId: first, apiKey: key, source: envName };
  }

  return { ok: false, error: 'No Klaviyo API key found. Configure KLAVIYO_API_KEY or KLAVIYO_API_KEY_<ACCOUNT_ID>.' };
}

function buildAutoVerticalSlices(logicalWidth, bodyTop, bodyBottom, maxSliceHeight) {
  const slices = [];
  const safeMax = Math.max(200, Math.round(maxSliceHeight || 1200));
  let y = bodyTop;

  while (y < bodyBottom) {
    const h = Math.min(safeMax, bodyBottom - y);
    slices.push({ x: 0, y, width: logicalWidth, height: h, url: '', label: '', alt: '' });
    y += h;
  }

  return slices;
}

function normalizeManualRectSlices(logicalWidth, logicalHeight, bodyTop, bodyBottom, manualSlices) {
  const list = Array.isArray(manualSlices) ? manualSlices : [];
  const rects = [];

  for (const s of list) {
    if (!s || !s.rect) continue;

    const x = clamp(Math.round(Number(s.rect.x || 0)), 0, Math.max(0, logicalWidth - 1));
    const y = clamp(Math.round(Number(s.rect.y || 0)), bodyTop, Math.max(bodyTop, bodyBottom - 1));

    const maxW = logicalWidth - x;
    const maxH = bodyBottom - y;

    const w = clamp(Math.round(Number(s.rect.width || 0)), 1, Math.max(1, maxW));
    const h = clamp(Math.round(Number(s.rect.height || 0)), 1, Math.max(1, maxH));

    if (w < 2 || h < 2) continue;

    rects.push({
      x,
      y,
      width: w,
      height: h,
      url: safeUrl(s.url),
      label: String(s.label || ''),
      alt: String(s.alt || '')
    });
  }

  return rects;
}

async function uploadImageToKlaviyo({ apiKey, name, base64Image, mimeType }) {
  const response = await fetch('https://a.klaviyo.com/api/images/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      accept: 'application/vnd.api+json',
      'content-type': 'application/vnd.api+json',
      revision
    },
    body: JSON.stringify({
      data: {
        type: 'image',
        attributes: {
          name,
          import_from_url: `data:${mimeType};base64,${base64Image}`
        }
      }
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Image upload failed: ${extractErrorText(json, `HTTP ${response.status}`)}`);

  const imageUrl = json?.data?.attributes?.image_url;
  if (!imageUrl) throw new Error('Image uploaded but image_url missing from Klaviyo response');
  return imageUrl;
}

async function compressSlice(sliceBuffer, hasAlpha) {
  const originalBytes = sliceBuffer.length;

  if (hasAlpha) {
    const png = await sharp(sliceBuffer).png({ compressionLevel: 9, palette: true }).toBuffer();
    return {
      buf: png,
      mime: 'image/png',
      quality: null,
      originalKb: bytesToKb(originalBytes),
      compressedKb: bytesToKb(png.length)
    };
  }

  let quality = defaultJpegQuality;
  let best = await sharp(sliceBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();
  const targetBytes = targetSliceKb * 1024;

  while (best.length > targetBytes && quality > minJpegQuality) {
    quality -= 5;
    best = await sharp(sliceBuffer).jpeg({ quality, mozjpeg: true }).toBuffer();
  }

  return {
    buf: best,
    mime: 'image/jpeg',
    quality,
    originalKb: bytesToKb(originalBytes),
    compressedKb: bytesToKb(best.length)
  };
}

function clampExtractRect(rect, pixelRatio, sourceWidth, sourceHeight) {
  const left = clamp(px(rect.x, pixelRatio), 0, Math.max(0, sourceWidth - 1));
  const top = clamp(px(rect.y, pixelRatio), 0, Math.max(0, sourceHeight - 1));

  const desiredW = Math.max(1, px(rect.width, pixelRatio));
  const desiredH = Math.max(1, px(rect.height, pixelRatio));

  const width = clamp(desiredW, 1, Math.max(1, sourceWidth - left));
  const height = clamp(desiredH, 1, Math.max(1, sourceHeight - top));

  return { left, top, width, height };
}

async function buildAndUploadSlices({
  apiKey,
  batchName,
  sourceBase64,
  logicalWidth,
  logicalHeight,
  pixelRatio,
  headerHeight,
  footerHeight,
  maxSliceHeight,
  manualSlices
}) {
  const sourceBuffer = Buffer.from(sourceBase64, 'base64');
  const sourceMeta = await sharp(sourceBuffer).metadata();
  const sourceWidth = Number(sourceMeta.width || 0);
  const sourceHeight = Number(sourceMeta.height || 0);

  if (!sourceWidth || !sourceHeight) {
    throw new Error('Could not read exported image dimensions.');
  }

  const bodyTop = clamp(Math.round(headerHeight || 0), 0, logicalHeight);
  const bodyBottom = logicalHeight - clamp(Math.round(footerHeight || 0), 0, logicalHeight);

  if (bodyBottom <= bodyTop) throw new Error('Invalid header/footer crop. Body region is empty.');

  let slices = [];
  if (Array.isArray(manualSlices) && manualSlices.length > 0) {
    slices = normalizeManualRectSlices(logicalWidth, logicalHeight, bodyTop, bodyBottom, manualSlices);
    if (!slices.length) throw new Error('Manual slices provided but no valid rectangles were generated.');
  } else {
    slices = buildAutoVerticalSlices(logicalWidth, bodyTop, bodyBottom, maxSliceHeight);
  }

  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const extractRect = clampExtractRect(s, pixelRatio, sourceWidth, sourceHeight);

    const extracted = await sharp(sourceBuffer)
      .extract(extractRect)
      .toBuffer({ resolveWithObject: true });

    const compressed = await compressSlice(extracted.data, !!extracted.info.hasAlpha);
    const imageUrl = await uploadImageToKlaviyo({
      apiKey,
      name: `${batchName}-slice-${i + 1}`,
      base64Image: compressed.buf.toString('base64'),
      mimeType: compressed.mime
    });

    s.imageUrl = imageUrl;
    s.mimeType = compressed.mime;
    s.jpegQuality = compressed.quality;
    s.originalKb = compressed.originalKb;
    s.compressedKb = compressed.compressedKb;
  }

  return { slices, bodyTop, bodyBottom };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    revision,
    mode: 'v11-upload-only',
    targetSliceKb,
    accounts: readConfiguredAccounts()
  });
});

app.get('/api/accounts', (_req, res) => {
  const list = readConfiguredAccounts();
  const fallbackExists = Boolean(process.env.KLAVIYO_API_KEY || process.env.KLAVIYO_PRIVATE_KEY);
  const accounts = fallbackExists ? ['default', ...list] : list;
  res.json({ ok: true, accounts: Array.from(new Set(accounts)) });
});

app.post('/api/push', async (req, res) => {
  try {
    const {
      batchName,
      imageBase64,
      logicalWidth,
      logicalHeight,
      pixelRatio,
      headerHeight,
      footerHeight,
      maxSliceHeight,
      manualSlices,
      frameName,
      accountId
    } = req.body || {};

    const resolved = resolveApiKey(accountId);
    if (!resolved.ok) return res.status(500).json({ error: resolved.error });
    const apiKey = resolved.apiKey;

    const lw = Number(logicalWidth);
    const lh = Number(logicalHeight);
    const pr = Number(pixelRatio || 1);
    const safeBatchName = String(batchName || frameName || 'Figma Export');

    if (!safeBatchName || !imageBase64 || !lw || !lh) {
      return res.status(400).json({ error: 'Missing required fields: batchName/imageBase64/logicalWidth/logicalHeight' });
    }

    const built = await buildAndUploadSlices({
      apiKey,
      batchName: safeBatchName,
      sourceBase64: imageBase64,
      logicalWidth: lw,
      logicalHeight: lh,
      pixelRatio: pr,
      headerHeight: Number(headerHeight || 0),
      footerHeight: Number(footerHeight || 0),
      maxSliceHeight: Number(maxSliceHeight || 1200),
      manualSlices: Array.isArray(manualSlices) ? manualSlices : []
    });

    const slices = built.slices.map((s, idx) => ({
      index: idx + 1,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      imageUrl: s.imageUrl,
      url: s.url || '',
      label: s.label || '',
      alt: s.alt || '',
      mimeType: s.mimeType,
      jpegQuality: s.jpegQuality,
      originalKb: s.originalKb,
      compressedKb: s.compressedKb
    }));

    res.json({
      ok: true,
      accountId: resolved.accountId,
      batchName: safeBatchName,
      frameName: frameName || null,
      sliceCount: slices.length,
      mode: 'v11-upload-only',
      manualMode: Array.isArray(manualSlices) && manualSlices.length > 0,
      targetSliceKb,
      slices
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
