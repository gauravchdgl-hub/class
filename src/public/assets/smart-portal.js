
document.addEventListener("DOMContentLoaded",()=>{
 const sidebar=document.querySelector(".sidebar"), overlay=document.querySelector(".mobile-overlay");
 document.querySelector(".hamb")?.addEventListener("click",()=>{sidebar?.classList.toggle("open");overlay?.classList.toggle("show")});
 overlay?.addEventListener("click",()=>{sidebar?.classList.remove("open");overlay?.classList.remove("show")});
 document.querySelectorAll(".nav a.locked").forEach(a=>a.addEventListener("click",e=>{e.preventDefault(); const t=document.querySelector(".toast"); if(t){t.textContent=a.dataset.reason||"Access is waiting for teacher assignment.";t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}}));
 document.querySelectorAll("[data-demo]").forEach(el=>el.addEventListener("click",()=>{const t=document.querySelector(".toast"); if(t){t.textContent=el.dataset.demo;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)}}));
});

document.addEventListener("DOMContentLoaded",()=>{
 document.querySelectorAll(".nav-group > .nav-parent").forEach(p=>{
   p.addEventListener("click",()=>{
     const grp=p.parentElement;
     const willOpen=!grp.classList.contains("expanded");
     document.querySelectorAll(".nav-group.expanded").forEach(g=>{ if(g!==grp) g.classList.remove("expanded"); });
     grp.classList.toggle("expanded", willOpen);
   });
 });
});

// Exam timer — driven by a server-issued expires_at timestamp (not a fixed
// countdown from page-load), so a refresh or reopened tab always shows the
// TRUE remaining time. When it hits zero, the exam form is auto-submitted.
// The server independently re-checks expiry on every load as a backstop, so
// even if this script never runs (JS disabled, tab closed), the exam still
// gets force-submitted the next time the page is requested.
document.addEventListener("DOMContentLoaded",()=>{
  const timerEl = document.querySelector('[data-expires-at]');
  if (!timerEl) return;
  const expiresAt = new Date(timerEl.dataset.expiresAt).getTime();
  let submitted = false;

  function tick() {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      timerEl.textContent = '00:00:00';
      if (!submitted) {
        submitted = true;
        const form = document.getElementById('exam-take-form');
        if (form) form.submit();
      }
      return;
    }
    const sec = Math.floor(remainingMs / 1000);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    timerEl.textContent = `${h}:${m}:${s}`;
  }
  tick();
  setInterval(tick, 1000);
});
