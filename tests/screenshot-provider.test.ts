import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeProvider,
  screenshotConfigProblems,
  screenshotImportConfigured,
  screenshotModel,
} from '@/lib/image-import/read-screenshot';

/**
 * Which service a screenshot goes to, and — more importantly — which one it
 * never goes to by accident.
 *
 * The choice is made from environment variables, so these tests set them
 * directly. The one that matters most is the last block: Google's free tier
 * may use submitted content to improve its products and have people read it,
 * and its terms say not to send confidential information there. A company's
 * bank statements must not reach it because somebody pasted a key.
 */

const KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_PAID_TIER', 'SCREENSHOT_PROVIDER', 'GEMINI_SCREENSHOT_MODEL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('with nothing configured', () => {
  it('reads no screenshots, and says why', () => {
    expect(screenshotImportConfigured()).toBe(false);
    expect(activeProvider()).toBeNull();
    expect(screenshotConfigProblems()[0]).toMatch(/Neither ANTHROPIC_API_KEY nor a confirmed GEMINI_API_KEY/);
  });

  it('still names a model, because callers use it as a label', () => {
    expect(screenshotModel()).toBe('claude-opus-5');
  });
});

describe('choosing between the two', () => {
  it('uses Anthropic when only its key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(activeProvider()?.name).toBe('anthropic');
    expect(screenshotModel()).toBe('claude-opus-5');
  });

  it('uses Gemini when only its key is set and the tier is confirmed', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_PAID_TIER = 'true';
    expect(activeProvider()?.name).toBe('gemini');
    expect(screenshotModel()).toBe('gemini-3.8-flash');
  });

  it('prefers Anthropic when both are available and neither is named', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_PAID_TIER = 'true';
    expect(activeProvider()?.name).toBe('anthropic');
  });

  it('obeys SCREENSHOT_PROVIDER over the key that happens to be there', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_PAID_TIER = 'true';
    process.env.SCREENSHOT_PROVIDER = 'gemini';
    expect(activeProvider()?.name).toBe('gemini');
  });

  it('does not silently fall back when the named provider has no key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.SCREENSHOT_PROVIDER = 'gemini';
    // Falling back to Anthropic here would send the image somewhere the
    // operator did not choose.
    expect(activeProvider()).toBeNull();
    expect(screenshotImportConfigured()).toBe(false);
  });

  it('names an unknown provider rather than guessing', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.SCREENSHOT_PROVIDER = 'openai';
    expect(activeProvider()).toBeNull();
    expect(screenshotConfigProblems()[0]).toContain('"openai"');
  });

  it('lets a deployment pin a different Gemini model', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_PAID_TIER = 'true';
    process.env.GEMINI_SCREENSHOT_MODEL = 'gemini-4-argon';
    expect(screenshotModel()).toBe('gemini-4-argon');
  });
});

describe('the free tier is never used', () => {
  it('refuses a Gemini key whose tier has not been confirmed', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(activeProvider()).toBeNull();
    expect(screenshotImportConfigured()).toBe(false);
  });

  it.each(['false', 'yes', '1', 'TRUE ', ''])('does not accept GEMINI_PAID_TIER=%o as confirmation', (value) => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_PAID_TIER = value;
    process.env.SCREENSHOT_PROVIDER = 'gemini';
    // "TRUE " with a space is the one that should pass — it is trimmed and
    // lower-cased — and "1" and "yes" are the ones a person types when they
    // have not read what the flag is for.
    const expected = value.trim().toLowerCase() === 'true';
    expect(activeProvider() !== null).toBe(expected);
  });

  it('explains the refusal in terms of what Google would do with the image', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.SCREENSHOT_PROVIDER = 'gemini';
    const problem = screenshotConfigProblems()[0] ?? '';
    expect(problem).toContain('GEMINI_PAID_TIER');
    expect(problem).toMatch(/free tier/i);
  });
});
