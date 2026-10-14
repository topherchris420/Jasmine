import { createRequire } from 'node:module';
import { EngineError } from '../errors.ts';
const require = createRequire(import.meta.url);

export interface OcrPage {
  text: string;
  confidence: number;
  tsv: string;
  png: Uint8Array;
  width: number;
  height: number;
  figures?: { png: Uint8Array; x: number; y: number; width: number; height: number }[];
}
/** Offline English OCR. Language data and WASM are bundled npm dependencies. */
export async function recognizeDocument(
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: (data: unknown) => void,
): Promise<OcrPage[]> {
  signal.throwIfAborted();
  const canvasModule = await import('@napi-rs/canvas');
  const images: {
    png: Uint8Array;
    width: number;
    height: number;
    figures?: { png: Uint8Array; x: number; y: number; width: number; height: number }[];
  }[] = [];
  if (Buffer.from(bytes.subarray(0, 4)).toString() === '%PDF') {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals['DOMMatrix'] ??= canvasModule.DOMMatrix;
    globals['ImageData'] ??= canvasModule.ImageData;
    globals['Path2D'] ??= canvasModule.Path2D;
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdf.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const abort = () => void task.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const document = await task.promise;
      if (document.numPages > 50) throw new EngineError('BAD_PAYLOAD', 'Local OCR is limited to 50 pages per node');
      for (let n = 1; n <= document.numPages; n++) {
        signal.throwIfAborted();
        const page = await document.getPage(n),
          base = page.getViewport({ scale: 1 }),
          viewport = page.getViewport({ scale: Math.min(2, 4096 / Math.max(base.width, base.height)) });
        const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const operators = await page.getOperatorList();
        let matrix = [1, 0, 0, 1, 0, 0];
        const stack: number[][] = [];
        const figures: { png: Uint8Array; x: number; y: number; width: number; height: number }[] = [];
        const multiply = (a: number[], b: number[]) => [
          a[0]! * b[0]! + a[2]! * b[1]!,
          a[1]! * b[0]! + a[3]! * b[1]!,
          a[0]! * b[2]! + a[2]! * b[3]!,
          a[1]! * b[2]! + a[3]! * b[3]!,
          a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
          a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
        ];
        for (let i = 0; i < operators.fnArray.length; i++) {
          const operation = operators.fnArray[i],
            args = operators.argsArray[i];
          if (operation === pdf.OPS.save) stack.push([...matrix]);
          else if (operation === pdf.OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
          else if (operation === pdf.OPS.transform) matrix = multiply(matrix, args as number[]);
          else if (operation === pdf.OPS.paintImageXObject || operation === pdf.OPS.paintInlineImageXObject) {
            try {
              const image = (
                operation === pdf.OPS.paintInlineImageXObject
                  ? args[0]
                  : await new Promise((resolve) =>
                      (String(args[0]).startsWith('g_') ? page.commonObjs : page.objs).get(args[0], resolve),
                    )
              ) as { width: number; height: number; kind: number; data: Uint8Array };
              if (!image?.data || image.width * image.height > 16000000 || figures.length >= 100) continue;
              const rgba = new Uint8ClampedArray(image.width * image.height * 4);
              for (let pixel = 0; pixel < image.width * image.height; pixel++) {
                if (image.kind === 3) {
                  rgba.set(image.data.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
                } else if (image.kind === 2) {
                  rgba.set(image.data.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
                  rgba[pixel * 4 + 3] = 255;
                } else {
                  const stride = Math.ceil(image.width / 8),
                    row = Math.floor(pixel / image.width),
                    column = pixel % image.width,
                    v = ((image.data[row * stride + Math.floor(column / 8)] ?? 0) >> (7 - (column % 8))) & 1 ? 255 : 0;
                  rgba.set([v, v, v, 255], pixel * 4);
                }
              }
              const figure = canvasModule.createCanvas(image.width, image.height);
              figure.getContext('2d').putImageData(new canvasModule.ImageData(rgba, image.width, image.height), 0, 0);
              const corners = [
                [0, 0],
                [1, 0],
                [0, 1],
                [1, 1],
              ].map(([x, y]) =>
                viewport.convertToViewportPoint(
                  matrix[0]! * x! + matrix[2]! * y! + matrix[4]!,
                  matrix[1]! * x! + matrix[3]! * y! + matrix[5]!,
                ),
              );
              const xs = corners.map((c) => c[0]!),
                ys = corners.map((c) => c[1]!);
              figures.push({
                png: figure.toBuffer('image/png'),
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
              });
            } catch {
              /* Unsupported masks/bitmap resources stay visible in the saved page render. */
            }
          }
        }
        await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport })
          .promise;
        images.push({ png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height, figures });
        onProgress?.({ stage: 'render', page: n, pages: document.numPages });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await task.destroy().catch(() => {});
    }
  } else {
    const image = await canvasModule.loadImage(Buffer.from(bytes));
    if (image.width * image.height > 16_000_000)
      throw new EngineError('BAD_PAYLOAD', 'OCR image exceeds 16 million pixels');
    const canvas = canvasModule.createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    images.push({ png: canvas.toBuffer('image/png'), width: image.width, height: image.height });
  }
  const { createWorker } = await import('tesseract.js');
  const language = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
  const worker = await createWorker('eng', 1, {
    langPath: language.langPath,
    gzip: language.gzip,
    cacheMethod: 'none',
    logger: (m) => onProgress?.(m),
  });
  const abort = () => void worker.terminate();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const pages: OcrPage[] = [];
    for (const image of images) {
      signal.throwIfAborted();
      const r = await worker.recognize(Buffer.from(image.png), {}, { text: true, tsv: true });
      pages.push({ ...image, text: r.data.text, confidence: r.data.confidence, tsv: r.data.tsv ?? '' });
    }
    return pages;
  } finally {
    signal.removeEventListener('abort', abort);
    await worker.terminate().catch(() => {});
  }
}
