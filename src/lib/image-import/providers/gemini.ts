import * as z from 'zod/v4';
import {
  Reading,
  ScreenshotReadError,
  SYSTEM_PROMPT,
  type ScreenshotImage,
  type ScreenshotProvider,
  type ScreenshotRead,
} from '@/lib/image-import/reading-contract';

/**
 * Gemini reading a banking-app screenshot.
 *
 * The second reader. It exists so the same sample image can be put through two
 * models and the better one kept, rather than the choice being made from a
 * price list — a misread digit here is money, and that is not a judgement to
 * make without evidence.
 *
 * THE FREE TIER IS NOT ALLOWED HERE, and the guard below enforces it. Google's
 * terms (aistudio.google.com/docs/terms, effective 23 March 2026) say that on
 * the unpaid service Google "uses the content you submit to the Services and
 * any generated responses … to provide, improve, and develop Google products
 * and services and machine learning technologies", that "human reviewers may
 * read, annotate, and process your API input and output", and plainly: "Do not
 * submit sensitive, confidential, or personal information to the Unpaid
 * Services." A company's bank statements are all three. On the paid service
 * Google "doesn't use your prompts … or responses to improve our products" and
 * logs them only "for a limited period of time" for abuse detection.
 *
 * A key alone cannot tell us which tier it belongs to, so the operator says so
 * once, deliberately, in the environment. Without that, this provider refuses
 * to send anything.
 */

/** Documented on the models page; override per deployment to compare models. */
const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Request shape per aistudio.google.com/docs/image-understanding. */
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';

export function geminiModel(): string {
  return process.env.GEMINI_SCREENSHOT_MODEL?.trim() || DEFAULT_MODEL;
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY) && paidTierConfirmed();
}

/**
 * Has somebody confirmed this key belongs to a billed project?
 *
 * Deliberately a separate variable rather than something inferred. Pasting an
 * AI Studio key into a deployment is a thirty-second job; reading the terms
 * attached to it is not, and the cost of getting it wrong is a quarter of the
 * company's bank history sitting in someone else's training corpus.
 */
function paidTierConfirmed(): boolean {
  return process.env.GEMINI_PAID_TIER?.trim().toLowerCase() === 'true';
}

/**
 * The reading schema as JSON Schema.
 *
 * Gemini takes a JSON Schema in `response_format.schema`, and documents that
 * nullable fields are expressed as a type array — `{"type": ["string",
 * "null"]}` — which is what zod's own JSON Schema output produces for
 * `.nullable()`. Built once: it never varies by request.
 */
const RESPONSE_SCHEMA = z.toJSONSchema(Reading, { io: 'output' });

interface InteractionStep {
  content?: Array<{ type?: string; text?: string }>;
}

export const geminiProvider: ScreenshotProvider = {
  name: 'gemini',
  get model() {
    return geminiModel();
  },

  async read(image: ScreenshotImage): Promise<ScreenshotRead> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new ScreenshotReadError('not_configured', 'GEMINI_API_KEY is not set, so screenshots cannot be read.');
    }
    if (!paidTierConfirmed()) {
      throw new ScreenshotReadError(
        'not_configured',
        'Gemini is configured but GEMINI_PAID_TIER is not "true". Google may use anything sent to the free tier to improve its products, and its terms say not to send confidential information there, so bank screenshots are not sent until the key is confirmed to belong to a billed project.',
      );
    }

    // Same budget as the other provider: two minutes, inside the route's 300.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key,
          'Api-Revision': API_REVISION,
        },
        body: JSON.stringify({
          model: geminiModel(),
          system_instruction: SYSTEM_PROMPT,
          // The text goes BEFORE the image: the image guide says to order them
          // this way when one image accompanies a prompt.
          input: [
            { type: 'text', text: 'Transcribe every transaction visible in this screenshot.' },
            {
              type: 'image',
              mime_type: image.mediaType,
              data: Buffer.from(image.data).toString('base64'),
            },
          ],
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: RESPONSE_SCHEMA,
          },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ScreenshotReadError('unavailable', 'Reading took too long. Try again, or take a shorter screenshot.');
      }
      throw new ScreenshotReadError('unavailable', 'Could not reach the reading service. Try again.');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // The error body is not documented, so the status decides the message
      // and the body is only quoted, never parsed for meaning.
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      if (response.status === 401 || response.status === 403) {
        throw new ScreenshotReadError('not_configured', 'GEMINI_API_KEY was refused. Check the key in the deployment settings.');
      }
      if (response.status === 429) {
        throw new ScreenshotReadError('rate_limited', 'The reading service is busy. Wait a minute and try this screenshot again.');
      }
      if (response.status === 400) {
        throw new ScreenshotReadError('rejected', `The screenshot was refused: ${detail}`);
      }
      throw new ScreenshotReadError('unavailable', `The reading service failed (${response.status}). Try again.`);
    }

    const body = (await response.json().catch(() => null)) as { steps?: InteractionStep[] } | null;
    const text = lastText(body?.steps);
    if (!text) {
      // A blocked or empty answer arrives as a 200 with no text block, exactly
      // as a refusal does on the other provider.
      throw new ScreenshotReadError('refused', 'This screenshot could not be read. Try a clearer or smaller capture.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Truncation is what usually produces unparseable JSON here: the model
      // ran out of room mid-array on a long statement.
      throw new ScreenshotReadError(
        'too_long',
        'This screenshot has more on it than can be read at once. Split it into shorter captures.',
      );
    }

    const reading = Reading.safeParse(parsed);
    if (!reading.success) {
      throw new ScreenshotReadError('unreadable', 'The screenshot could not be turned into transactions. Try again.');
    }

    return {
      reading: reading.data,
      model: geminiModel(),
      // Google does not document a usage field on this response, and a number
      // invented here would be worse than none.
      usage: null,
    };
  },
};

/**
 * The model's answer is the last text block of the last step.
 *
 * `steps` carries the whole interaction, user input included, so taking the
 * first text block would hand back the prompt.
 */
function lastText(steps: InteractionStep[] | undefined): string | null {
  if (!steps?.length) return null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const blocks = steps[i]?.content ?? [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block?.text?.trim()) return block.text;
    }
  }
  return null;
}
