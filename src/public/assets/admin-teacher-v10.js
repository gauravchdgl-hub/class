document.addEventListener('DOMContentLoaded',()=>{
 const $=(s,r=document)=>r.querySelector(s); const $$=(s,r=document)=>[...r.querySelectorAll(s)];
 const toast=(msg,type='')=>{const box=$('#toastStack');if(!box)return;const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;box.appendChild(t);setTimeout(()=>t.remove(),2600)};
 const backdrop=$('#modalBackdrop'), modalTitle=$('#modalTitle'), modalBody=$('#modalBody');
 const openModal=(title,body,foot='Close')=>{if(!backdrop)return;modalTitle.textContent=title;modalBody.innerHTML=body;backdrop.classList.add('open');};
 const closeModal=()=>backdrop&&backdrop.classList.remove('open');
 $('#modalClose')?.addEventListener('click',closeModal); $('#modalCancel')?.addEventListener('click',closeModal); backdrop?.addEventListener('click',e=>{if(e.target===backdrop)closeModal()});
 $$('.js-open').forEach(b=>b.addEventListener('click',()=>{const t=b.dataset.title||'Record details';openModal(t,`<div class="modal-info"><div><small>Status</small><b>Active / Ready</b></div><div><small>Updated</small><b>12 Sep 2026</b></div><div><small>Assigned</small><b>120 students</b></div><div><small>Owner</small><b>Sarah Anderson</b></div></div><p style="margin:14px 0 0">This static demo opens the same kind of detail view that can later be connected directly to your backend/API.</p>`);}));
 $$('.js-create').forEach(b=>b.addEventListener('click',()=>{openModal('Create new record',`<div class="form-grid"><label>Name<input value="New record"></label><label>Status<select><option>Active</option><option>Draft</option></select></label><label class="full">Notes<textarea placeholder="Add notes..."></textarea></label></div>`,`Save`);}));
 $$('.js-submit').forEach(b=>b.addEventListener('click',()=>{toast(b.textContent.trim()||'Saved successfully','success');if(b.closest('form'))b.closest('form').reset();}));
 $$('.js-export').forEach(b=>b.addEventListener('click',()=>toast('Demo export prepared. Backend export can be connected here.')));
 $$('[data-filter-table]').forEach(input=>input.addEventListener('input',()=>{const card=input.closest('.card');const q=input.value.toLowerCase();$$('tbody tr',card).forEach(tr=>tr.style.display=tr.textContent.toLowerCase().includes(q)?'':'none');}));
 $('#menuBtn')?.addEventListener('click',()=>{$('#sidebar')?.classList.toggle('open');$('#backdrop')?.classList.toggle('show')}); $('#backdrop')?.addEventListener('click',()=>{$('#sidebar')?.classList.remove('open');$('#backdrop')?.classList.remove('show')});
 $('.js-help')?.addEventListener('click',()=>openModal('Portal help','Use the left navigation to manage students, content, papers, assignments, submissions, reviews, results and payments.')); $('.js-notify')?.addEventListener('click',()=>openModal('Notifications','<ul><li>3 new submissions need review.</li><li>1 payment is pending verification.</li><li>2 new students registered today.</li></ul>')); $('.js-user')?.addEventListener('click',()=>openModal('Account','<p><b>Sarah Anderson</b><br>Admin / Teacher</p><button class="btn btn-light" onclick="location.href=\'admin-settings.html\'">Open Settings</button>'));
 const form=$('#loginForm');form?.addEventListener('submit',e=>{e.preventDefault();toast('Signed in. Opening dashboard…','success');setTimeout(()=>location.href='admin-dashboard.html',350)}); $('#togglePassword')?.addEventListener('click',()=>{const p=$('#loginPassword');if(!p)return;p.type=p.type==='password'?'text':'password';$('#togglePassword').textContent=p.type==='password'?'Show':'Hide'}); $('.js-forgot')?.addEventListener('click',e=>{e.preventDefault();toast('Password reset link demo opened.','warn')});
});

// Real tab switching for Settings page (General/Email/Payments/Appearance/User Roles/Security)
document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.settings-tab-btn');
  tabBtns.forEach(btn => btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById('tab-' + btn.dataset.tab);
    if (panel) panel.style.display = 'block';
  }));
});
