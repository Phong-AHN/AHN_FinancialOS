import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  Reading,
  ScreenshotReadError,
  SYSTEM_PROMPT,
  type ScreenshotImage,
  type ScreenshotProvider,
  type ScreenshotRead,
} from '@/lib/image-import/reading-contract';

/**
 * Claude reading a banking-app screenshot.
 *
 * The original reader, now one of two. Its distinguishing feature is the
 * server-side fallback: a safety classifier that declines a legitimate bank
 * screenshot is retried on Anthropic's fallback model inside the same call,
 * rather than failing in front of somebody holding a phone.
 */

export const ANTHROPIC_MODEL = 'claude-opus-5';

export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const anthropicProvider: ScreenshotProvider = {
  name: 'anthropic',
  model: ANTHROPIC_MODEL,

  async read(image: ScreenshotImage): Promise<ScreenshotRead> {
    if (!anthropicConfigured()) {
      throw new ScreenshotReadError('not_configured', 'ANTHROPIC_API_KEY is not set, so screenshots cannot be read.');
    }

    // Bounded by the route's 300-second limit (Vercel's maximum on every plan
    // with fluid compute): two attempts of up to two minutes each fit inside
    // it. An earlier version allowed 55 seconds and no retry, so a dense
    // screenshot read at full effort failed as "could not reach the service"
    // when nothing was wrong but the time allowed.
    const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });

    let response;
    try {
      response = await client.beta.messages.parse({
        model: ANTHROPIC_MODEL,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: betaZodOutputFormat(Reading) },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: Buffer.from(image.data).toString('base64'),
                },
              },
              { type: 'text', text: 'Transcribe every transaction visible in this screenshot.' },
            ],
          },
        ],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new ScreenshotReadError('rate_limited', 'The reading service is busy. Wait a minute and try this screenshot again.');
      }
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ScreenshotReadError('not_configured', 'ANTHROPIC_API_KEY was refused. Check the key in the deployment settings.');
      }
      if (err instanceof Anthropic.BadRequestError) {
        throw new ScreenshotReadError('rejected', `The screenshot was refused: ${err.message}`);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new ScreenshotReadError('unavailable', 'Could not reach the reading service. Try again.');
      }
      if (err instanceof Anthropic.APIError) {
        throw new ScreenshotReadError('unavailable', `The reading service failed (${err.status ?? 'no status'}). Try again.`);
      }
      throw err;
    }

    // Always the stop reason first: a refusal arrives as a 200 with no content.
    if (response.stop_reason === 'refusal') {
      throw new ScreenshotReadError('refused', 'This screenshot could not be read. Try a clearer or smaller capture.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ScreenshotReadError('too_long', 'This screenshot has more on it than can be read at once. Split it into shorter captures.');
    }
    const reading = response.parsed_output;
    if (!reading) {
      throw new ScreenshotReadError('unreadable', 'The screenshot could not be turned into transactions. Try again.');
    }

    return {
      reading,
      model: response.model,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  },
};
