import { anthropicConfigured, anthropicProvider, ANTHROPIC_MODEL } from '@/lib/image-import/providers/anthropic';
import { geminiConfigured, geminiProvider } from '@/lib/image-import/providers/gemini';
import {
  ScreenshotReadError,
  type ScreenshotImage,
  type ScreenshotProvider,
  type ScreenshotRead,
} from '@/lib/image-import/reading-contract';

/**
 * Which service reads a banking screenshot.
 *
 * Two are wired up, behind one interface, on purpose: the quality that matters
 * here is whether a model reads "6.500.000" as six and a half million rather
 * than six thousand five hundred, and that is settled by running the same
 * image through both — not by a price list or a benchmark about other work.
 *
 * SERVER ONLY. Neither key reaches a browser, and the image is sent once and
 * stored nowhere by this application.
 */

export {
  ScreenshotReadError,
  sniffImageType,
  type ScreenshotMediaType,
  type ScreenshotImage,
  type ScreenshotProvider,
  type ScreenshotRead,
} from '@/lib/image-import/reading-contract';

export type ScreenshotProviderName = 'anthropic' | 'gemini';

/**
 * The provider in use.
 *
 * `SCREENSHOT_PROVIDER` decides when it is set, so a deployment can switch
 * without touching keys. With neither set it falls back to whichever key
 * exists, preferring Anthropic — the reader this import was built and proved
 * against, and therefore the one an unconfigured deployment should get.
 */
export function activeProvider(): ScreenshotProvider | null {
  const named = process.env.SCREENSHOT_PROVIDER?.trim().toLowerCase();

  if (named === 'anthropic') return anthropicConfigured() ? anthropicProvider : null;
  if (named === 'gemini') return geminiConfigured() ? geminiProvider : null;
  // A value that names neither stops the feature rather than falling through.
  // "antropic" is a plausible typo, and falling through would send the
  // company's bank screenshots to a service nobody chose.
  if (named) return null;

  if (anthropicConfigured()) return anthropicProvider;
  if (geminiConfigured()) return geminiProvider;
  return null;
}

export function screenshotImportConfigured(): boolean {
  return activeProvider() !== null;
}

/**
 * The model the import will use, for the audit trail and the setup notice.
 *
 * Falls back to the Anthropic model's name when nothing is configured, because
 * callers use it as a label rather than as a decision.
 */
export function screenshotModel(): string {
  return activeProvider()?.model ?? ANTHROPIC_MODEL;
}

/**
 * Why screenshot import is not available, in words an operator can act on.
 *
 * Empty when it is available. Separate from the boolean because the two
 * failures need different fixes: no key at all, versus a Gemini key whose tier
 * has not been confirmed.
 */
export function screenshotConfigProblems(): string[] {
  if (screenshotImportConfigured()) return [];

  const named = process.env.SCREENSHOT_PROVIDER?.trim().toLowerCase();
  if (named === 'gemini' && process.env.GEMINI_API_KEY && !geminiConfigured()) {
    return [
      'SCREENSHOT_PROVIDER is "gemini" and GEMINI_API_KEY is set, but GEMINI_PAID_TIER is not "true". Google\'s terms allow it to use anything sent to the free tier to improve its products, so screenshots are not sent until the key is confirmed to belong to a billed project.',
    ];
  }
  if (named === 'anthropic' && !anthropicConfigured()) {
    return ['SCREENSHOT_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.'];
  }
  if (named && named !== 'anthropic' && named !== 'gemini') {
    return [`SCREENSHOT_PROVIDER is "${named}", which is not a reader. Use "anthropic" or "gemini".`];
  }
  return ['Neither ANTHROPIC_API_KEY nor a confirmed GEMINI_API_KEY is set, so screenshots cannot be read.'];
}

/**
 * One screenshot, one request. Several screenshots are several requests, made
 * a few at a time by the browser — each finishes well inside a serverless time
 * limit, and a failure costs one image rather than the batch.
 */
export async function readScreenshot(image: ScreenshotImage): Promise<ScreenshotRead> {
  const provider = activeProvider();
  if (!provider) {
    throw new ScreenshotReadError('not_configured', screenshotConfigProblems()[0] ?? 'Screenshot reading is not configured.');
  }
  return provider.read(image);
}
