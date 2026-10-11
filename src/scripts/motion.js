// One-shot reveals + count-ups. Runs only when <head> set html.motion
// (IntersectionObserver present, Reduce Motion off); otherwise the static
// markup is already the final state.
const html = document.documentElement;
if (html.classList.contains('motion')) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.2 });
  document.querySelectorAll('.mo').forEach((el) => io.observe(el));

  // The final value is in the HTML; animate from 0 up to it (ease-out cubic).
  document.querySelectorAll('[data-count]').forEach((el) => {
    const raw = el.getAttribute('data-count');
    const target = parseFloat(raw);
    const dp = (raw.split('.')[1] || '').length;
    el.textContent = (0).toFixed(dp);
    setTimeout(() => {
      let start = 0;
      requestAnimationFrame(function step(ts) {
        start = start || ts;
        const p = Math.min(1, (ts - start) / 1400);
        el.textContent = (target * (1 - Math.pow(1 - p, 3))).toFixed(dp);
        if (p < 1) requestAnimationFrame(step);
      });
    }, +el.getAttribute('data-delay') || 0);
  });
}
