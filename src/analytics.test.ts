import { beforeEach, describe, expect, it } from 'vitest';
import { beforeSend, resetAnalyticsState } from './analytics';

const pv = (url: string) => beforeSend({ type: 'pageview', url });

describe('analytics beforeSend', () => {
  beforeEach(() => resetAnalyticsState());

  it('drops the draft query and sends one view per page per visit', () => {
    expect(pv('https://x.app/?lang=ru')).toEqual({ type: 'pageview', url: 'https://x.app/' });
    expect(pv('https://x.app/?enemy=1,2&pos=3')).toBeNull();
    expect(pv('https://x.app/?enemy=1,2,3&rank=divine')).toBeNull();
  });

  it('marks a visit that opened a shared draft link', () => {
    expect(pv('https://x.app/?enemy=13,29&lang=ru')).toEqual({ type: 'pageview', url: 'https://x.app/?via=draft-link' });
    expect(pv('https://x.app/?enemy=13,29,8')).toBeNull();
  });
});
