import { useEffect, useRef, useState } from 'react';
import { shareableUrl } from '../data/draftUrl';
import { useI18n } from '../i18n';
import { renderShareCard, type CardData, type CardFormat } from '../share/shareCard';

type Status = 'idle' | 'copied' | 'making' | 'saved' | 'failed';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    return ok;
  }
}

/** "Share": the draft link, or a draft card image (stories 1080×1920 / post
 *  1200×630). Phones get the system share sheet with the file; elsewhere the
 *  image downloads. */
export function ShareMenu({ card, align = 'right' }: { card: () => CardData; align?: 'left' | 'right' }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (status === 'idle' || status === 'making') return;
    const timer = window.setTimeout(() => setStatus('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function link() {
    setOpen(false);
    setStatus((await copyText(shareableUrl(window.location.href))) ? 'copied' : 'failed');
  }

  async function image(format: CardFormat) {
    setOpen(false);
    setStatus('making');
    try {
      const blob = await renderShareCard(format, card());
      const file = new File([blob], `lastpick-${format}.png`, { type: 'image/png' });
      const url = shareableUrl(window.location.href);
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.canShare?.({ files: [file] }) && window.matchMedia('(pointer: coarse)').matches) {
        try {
          await nav.share({ files: [file], title: 'LASTPICK', text: url });
          setStatus('idle');
          return;
        } catch (e) {
          if ((e as DOMException)?.name === 'AbortError') { setStatus('idle'); return; }
        }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setStatus('saved');
    } catch (e) {
      console.error(e);
      setStatus('failed');
    }
  }

  const text =
    status === 'copied' ? t('draft.copied')
      : status === 'making' ? t('share.making')
        : status === 'saved' ? t('share.saved')
          : status === 'failed' ? t('share.failed')
            : t('share.button');

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={status === 'making'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-live="polite"
        className={`btn btn-ghost btn-sm ${status === 'copied' || status === 'saved' ? '!text-accent' : ''}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
        </svg>
        {text}
      </button>
      {open && (
        <div className={`menu !w-[290px] ${align === 'left' ? '!left-0 !right-auto' : ''}`} role="menu">
          <button type="button" role="menuitem" className="menu-item" onClick={link}>{t('share.link')}</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => image('story')}>{t('share.story')}</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => image('post')}>{t('share.post')}</button>
        </div>
      )}
    </div>
  );
}
