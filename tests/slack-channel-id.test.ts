import { describe, expect, it } from 'vitest';
import { looksLikeChannelId } from '@/lib/alerts/channels';

describe('looksLikeChannelId', () => {
  it('recognises the channel IDs Slack actually issues', () => {
    // Real IDs from this workspace's routed channels.
    for (const id of ['C0BSVU967DF', 'C0BSS3P8JR4', 'C0BSU1BTRAN', 'C0BTNCSJ4AU']) {
      expect(looksLikeChannelId(id), id).toBe(true);
    }
    expect(looksLikeChannelId('G01ABCDEFGH')).toBe(true); // private channel
    expect(looksLikeChannelId('D01ABCDEFGH')).toBe(true); // DM
  });

  it('rejects channel names, which conversations.join cannot use', () => {
    // Passing a name to conversations.join returns channel_not_found, so the
    // auto-join path must not fire for one.
    for (const name of ['#ahn-finance-alerts', 'ahn-finance-alerts', '#general', '']) {
      expect(looksLikeChannelId(name), name).toBe(false);
    }
  });

  it('rejects lookalikes that are not IDs', () => {
    expect(looksLikeChannelId('C123')).toBe(false); // too short
    expect(looksLikeChannelId('c0bsvu967df')).toBe(false); // IDs are uppercase
    expect(looksLikeChannelId('XABCDEFGHIJ')).toBe(false); // wrong prefix
  });
});
