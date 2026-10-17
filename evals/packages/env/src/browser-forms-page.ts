/** Synthetic form shared by the browser journey and dedicated-guest diagnostics. */
export const browserFormsPage = `<!doctype html><meta charset="utf-8"><title>Application form</title>
<style>body{font:16px sans-serif;margin:16px}form{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:750px}label{display:block}input:not([type=checkbox]):not([type=radio]),select,textarea{display:block;width:90%;font:inherit}button{padding:8px}#status{min-height:24px}</style>
<h1>Application form</h1><p>Live updates: <span id="ticker">0</span></p>
<form id="application">
<div><span id="company-label">Company name</span><input name="company" aria-labelledby="company-label" value="Old company" required></div>
<label>Email<input name="email" type="email" value="old@example.test" required></label>
<label>Seats<input name="seats" type="number" value="7" min="1" required></label>
<label>Start date<input name="start" type="date" value="2026-01-01" required></label>
<label>Notes<textarea name="notes">Replace these notes</textarea></label>
<label>Country<select name="country"><option value="fr">France</option><option value="uk">United Kingdom</option><option value="blocked" disabled>Unavailable</option></select></label>
<label>Languages<select name="languages" multiple size="2"><option value="en">English</option><option value="fr">French</option></select></label>
<div><label><input name="business" type="checkbox">Business account</label><label id="tax-label" hidden>Tax reference<input name="tax"></label></div>
<div><label><input name="delivery" type="radio" value="standard" checked>Standard delivery</label><label><input name="delivery" type="radio" value="express">Express delivery</label></div>
<div role="switch" tabindex="0" aria-label="Email updates" aria-checked="false">Email updates</div>
<div role="combobox" tabindex="0" aria-label="Office" aria-expanded="false">London</div>
<label>Account reference<input value="Read only" readonly></label>
<label>Unavailable field<input disabled></label>
<label>Normalized code<input name="code" value="READY"></label>
<button type="submit">Submit application</button>
</form><p id="status" role="status">Not submitted</p>
<script>
let ticks=0;setInterval(()=>{document.querySelector('#ticker').textContent=String(++ticks)},40);
const form=document.querySelector('form');
const events={input:0,change:0,blur:0};
for(const type of Object.keys(events))form.addEventListener(type,()=>events[type]++,true);
form.elements.business.addEventListener('change',()=>{document.querySelector('#tax-label').hidden=!form.elements.business.checked;form.elements.tax.required=form.elements.business.checked});
form.elements.code.addEventListener('input',()=>{form.elements.code.value=form.elements.code.value.toUpperCase()});
const toggle=document.querySelector('[role=switch]');toggle.onclick=()=>toggle.setAttribute('aria-checked',String(toggle.getAttribute('aria-checked')!=='true'));
const office=document.querySelector('[role=combobox]');office.onkeydown=event=>{if(event.key==='ArrowDown'){office.textContent='Paris';office.setAttribute('aria-expanded','false');event.preventDefault()}};
form.addEventListener('submit',async event=>{
 event.preventDefault();
 const body={...Object.fromEntries(new FormData(form)),languages:new FormData(form).getAll('languages'),updates:toggle.getAttribute('aria-checked')==='true',office:office.textContent,events:{...events},ticks};
 const response=await fetch('/form-submit',{method:'POST',body:JSON.stringify(body)});
 if(response.ok){document.querySelector('#status').textContent='Application saved';form.querySelector('button').disabled=true}
});
</script>`;
