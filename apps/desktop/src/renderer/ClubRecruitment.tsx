import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import './club-recruitment.css';

const slides = [
  new URL('./assets/club-recruitment-cyan.webp', import.meta.url).href,
  new URL('./assets/club-recruitment-amber.webp', import.meta.url).href,
];
const caption = '北极星电竞-kook8866，大量招收三角洲打手';

export default function ClubRecruitment() {
  const container = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [paused, setPaused] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio >= 0.15), { threshold: [0, 0.15] });
    if (container.current) observer.observe(container.current);
    const onVisibility = () => setVisible(!document.hidden);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => { if (motion.matches) setPaused(true); };
    document.addEventListener('visibilitychange', onVisibility);
    motion.addEventListener('change', onMotion);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  const showing = inView && visible;
  useEffect(() => {
    if (!showing || paused || hovered || focused) return;
    const timer = window.setInterval(() => {
      setActive(value => (value + 1) % slides.length);
      setFailed(false);
    }, 6500);
    return () => window.clearInterval(timer);
  }, [showing, paused, hovered, focused]);

  function choose(index: number) {
    setActive((index + slides.length) % slides.length);
    setFailed(false);
    setPaused(true);
  }

  return <section className="club-recruitment" ref={container} aria-label="俱乐部招募广告" aria-roledescription="轮播"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="club-recruitment-heading"><h2>俱乐部招募</h2><span>广告</span></div>
    <a className="club-recruitment-banner" href="https://kook.vip/Uf1rPU" target="_blank" rel="noopener noreferrer" aria-label={`${caption}，打开 KOOK 频道（新窗口）`}>
      {showing && !failed
        ? <img key={active} src={slides[active]} alt={caption} width={1280} height={433} decoding="async" onError={() => setFailed(true)} />
        : <div className="club-recruitment-fallback"><strong>北极星电竞-kook8866</strong><span>大量招收三角洲打手</span></div>}
    </a>
    <div className="club-recruitment-toolbar">
      <a href="https://kook.vip/Uf1rPU" target="_blank" rel="noopener noreferrer">加入 KOOK 频道<ArrowUpRight size={15} aria-hidden="true" /></a>
      <div className="club-recruitment-controls">
        <button type="button" aria-label="上一张广告" onClick={() => choose(active - 1)}><ChevronLeft size={17} /></button>
        <span className="club-recruitment-count" aria-live={paused ? 'polite' : 'off'}>{active + 1} / {slides.length}</span>
        <button type="button" aria-label="下一张广告" onClick={() => choose(active + 1)}><ChevronRight size={17} /></button>
        <button type="button" aria-label={paused ? '播放广告轮播' : '暂停广告轮播'} onClick={() => setPaused(value => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>
      </div>
    </div>
  </section>;
}
