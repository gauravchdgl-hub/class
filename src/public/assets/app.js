(function(){
  const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
  const role=document.body.dataset.role||'';
  $$('.nav a').forEach(a=>{ if(a.href===location.href || a.dataset.active===location.pathname.split('/').pop()) a.classList.add('active'); });
  const sidebar=$('.sidebar'), overlay=$('.mobile-overlay'), menu=$('.menu-btn');
  if(menu) menu.onclick=()=>{sidebar?.classList.add('open');overlay?.classList.add('show')};
  if(overlay) overlay.onclick=()=>{sidebar?.classList.remove('open');overlay?.classList.remove('show')};
  $$('.js-demo').forEach(b=>b.onclick=()=>toast(b.dataset.message||'Demo action completed.'));
  $$('.js-submit').forEach(f=>f.addEventListener('submit',e=>{e.preventDefault();toast(f.dataset.message||'Saved successfully.')}));
  const timerEl=$('[data-timer]');
  if(timerEl){let sec=Number(timerEl.dataset.timer)||7200; const tick=()=>{const h=String(Math.floor(sec/3600)).padStart(2,'0'); const m=String(Math.floor(sec%3600/60)).padStart(2,'0'); const s=String(sec%60).padStart(2,'0'); timerEl.textContent=`${h}:${m}:${s}`; if(sec>0)sec--;}; tick(); setInterval(tick,1000);}
  $$('.option input[type=radio]').forEach(r=>r.addEventListener('change',()=>r.closest('.question-card')?.setAttribute('data-answered','1')));
  const submitExam=$('[data-submit-exam]');
  if(submitExam) submitExam.onclick=()=>{toast('Exam submitted. MCQ result is available immediately. Written and essay answers are pending teacher review.');setTimeout(()=>location.href='student-results.html',900)};
  $$('.tab-btn').forEach(btn=>btn.onclick=()=>{ $$('.tab-btn').forEach(x=>x.classList.remove('active')); $$('.tab-pane').forEach(x=>x.style.display='none'); btn.classList.add('active'); const target=$('#'+btn.dataset.tab); if(target)target.style.display='block';});
  function toast(msg){const t=$('.toast'); if(!t)return; t.textContent=msg;t.style.display='block';clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.style.display='none',2600)}
  window.portalToast=toast;
})();
