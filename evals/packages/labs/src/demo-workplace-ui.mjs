#!/usr/bin/env node
// Internal, fictional workplace browser for demo-atlassian.mjs. No build or dependencies.
// HOST=127.0.0.1 PORT=3992 ATLASSIAN_BASE_URL=http://127.0.0.1:3991 node demo-workplace-ui.mjs
// The upstream is operator-configured, never supplied by an HTTP caller. No real tokens are read.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3992);
const upstream = new URL(process.env.ATLASSIAN_BASE_URL || "http://127.0.0.1:3991");
if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") {
  throw new Error("ATLASSIAN_BASE_URL must be an HTTP origin without credentials, path, query, or fragment.");
}
const csrf = randomBytes(24).toString("hex");
const MAX_BODY = 1024 * 1024;

// Native controls intentionally replace framework primitives in this standalone eval fixture.
const css = `
:root{color-scheme:light;--background:#fafbfc;--surface:#f7f8fa;--ink:#172b4d;--muted:#626f86;--border:rgba(9,30,66,.14);--primary:#0c66e4;--accent:#011627;--radius:.45rem;--danger:#ae2e24;--space:16px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--background)}
*{box-sizing:border-box}body{margin:0}a{color:var(--primary);text-decoration:none}a:hover{text-decoration:underline}button,input,select,textarea{font:inherit;color:inherit}button,select,input,textarea{border:1px solid var(--border);border-radius:var(--radius);background:var(--background);padding:7px 10px}button{cursor:pointer;font-weight:500}button:hover{background:#e9edf3}button:disabled{opacity:.55;cursor:wait}.primary{background:var(--primary);color:#f7faff;border-color:transparent}.primary:hover{background:#0055cc}:focus-visible{outline:2px solid var(--primary);outline-offset:3px}header{height:58px;display:flex;align-items:center;gap:26px;padding:0 24px;border-bottom:1px solid var(--border);background:var(--background)}header a{color:var(--ink)}.brand{display:flex;align-items:center;gap:9px;font-size:19px;font-weight:650;letter-spacing:-.6px}.brand svg{width:25px;height:28px}header nav{display:flex;gap:24px;height:100%;align-items:center}header nav a[aria-current]{color:var(--primary);font-weight:600}.spacer{flex:1}.demo,.muted{color:var(--muted)}.demo{font-size:11px}.avatar{display:inline-grid;place-items:center;border-radius:50%;width:29px;height:29px;background:#dce8fc;color:#09326c;font-size:11px;font-weight:600}.layout{display:grid;grid-template-columns:238px minmax(0,1fr);min-height:calc(100vh - 58px)}aside{background:var(--surface);border-right:1px solid var(--border);padding:24px 14px}aside h2{font-size:13px;margin:0 10px 20px}aside a{display:block;padding:8px 10px;border-radius:4px;color:var(--ink);overflow-wrap:anywhere}aside a.selected{background:#e9f2ff;color:var(--primary);font-weight:600}aside details{margin:9px 0}aside summary{cursor:pointer;font-weight:600;padding:7px 8px}aside .tree a{font-size:12px;padding-top:6px;padding-bottom:6px}main{padding:28px 34px;min-width:0}.breadcrumb{color:var(--muted);margin-bottom:14px;font-size:12px}.titlebar,.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:22px}h1{font-size:20px;letter-spacing:-.4px;line-height:1.4;margin:0;font-weight:600}h2{font-size:15px;font-weight:600;margin:24px 0 12px}h3{font-size:14px}label{display:grid;gap:5px;font-weight:500}input[type=search]{width:280px}table{width:100%;border-collapse:collapse;text-align:left}th{color:var(--muted);font-size:12px;font-weight:600}th,td{padding:12px 10px;border-bottom:1px solid var(--border);vertical-align:top}tbody tr:hover{background:var(--surface)}td.summary{min-width:230px}td.nowrap{white-space:nowrap}.status{display:inline-block;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:650;background:#e4e7ec;color:#44546f;white-space:nowrap}.status.indeterminate{background:#e9f2ff;color:#0055cc}.status.done{background:#dcfff1;color:#216e4e}.tag{display:inline-block;background:#edf0f5;border-radius:3px;padding:2px 7px;margin:3px 5px 0 0;font-size:12px}.issue-grid{display:grid;grid-template-columns:minmax(0,1fr) 265px;gap:38px}.properties{padding-left:24px;border-left:1px solid var(--border)}.properties label{margin-bottom:18px}.properties select{width:100%}.copy{white-space:pre-wrap;line-height:1.75}.comment{border-top:1px solid var(--border);padding:16px 0}.comment p{margin:7px 0}.comment time{font-size:11px;color:var(--muted);margin-left:9px}textarea{width:100%;min-height:95px;resize:vertical}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}dialog{width:min(580px,95vw);border:0;border-radius:10px;padding:26px;background:var(--background);box-shadow:0 16px 48px rgba(9,30,66,.25);color:var(--ink)}dialog::backdrop{background:rgba(9,30,66,.42)}dialog h2{margin-top:0;font-size:20px}dialog label{margin-top:15px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:15px}.document{max-width:880px;font-size:14px;line-height:1.8;min-height:180px;overflow-wrap:anywhere}.document h1{font-size:20px;margin:22px 0 12px}.document h2{font-size:18px;margin-top:28px}.document h3{font-size:15px}.document p{margin:12px 0}.document table{margin:20px 0;font-size:13px}.document th,.document td{border:1px solid var(--border);padding:9px 12px}.document th{background:var(--surface);color:var(--ink)}.document blockquote{margin:16px 0;border-left:3px solid var(--border);padding-left:16px;color:var(--muted)}.document pre{background:var(--surface);padding:12px;white-space:pre-wrap}.document[contenteditable=true]{padding:18px;border:1px solid var(--primary);border-radius:var(--radius)}.metadata{color:var(--muted);margin-bottom:28px;font-size:12px}.page-list{max-width:880px}.page-row{display:block;border-bottom:1px solid var(--border);padding:17px 2px;font-weight:500}.page-row small{display:block;font-weight:400;color:var(--muted);margin-top:4px}#notice{position:sticky;top:0;padding:9px 24px;background:#fff3d5;color:#7f5f01;border-bottom:1px solid var(--border)}#notice:empty{display:none}.skeleton{height:15px;background:#e8ecf1;border-radius:3px;margin:15px 0;width:65%}.skeleton:nth-child(2n){width:90%}.empty{padding:30px 0;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}#edit-title{font-size:20px;width:100%;margin-bottom:16px}footer{margin-top:28px;color:var(--muted);font-size:11px}@media(max-width:900px){.layout{grid-template-columns:185px minmax(0,1fr)}main{padding:22px 18px}.issue-grid{grid-template-columns:1fr}.properties{border-left:0;padding-left:0}.table-wrap{overflow:auto}.demo{display:none}header{gap:18px;padding:0 16px}}@media(max-width:600px){.layout{display:block}aside{border-right:0;border-bottom:1px solid var(--border)}aside h2{margin-bottom:4px}header nav{gap:12px}.toolbar{flex-wrap:wrap}input[type=search]{width:100%}}
/* Atlassian-inspired internal fixture: semantic local tokens, no external assets. */
:root{--background:#ffffff;--surface:#f7f8f9;--hover:#f1f2f4;--selected:#e9f2ff;--success:#216e4e;--subtle:#dfe1e6;--control-height:32px;--row-height:44px;--sidebar-width:252px;--page-width:900px;--gap:12px;--small:12px;--shadow:0 8px 24px rgba(9,30,66,.18)}
body{background:var(--background)}header{height:56px;gap:28px;padding:0 22px}.brand{font-size:21px;letter-spacing:-.5px}.brand svg{width:25px;height:25px}header nav a{height:56px;display:flex;align-items:center;border-bottom:3px solid transparent;padding-top:3px}header nav a[aria-current]{border-bottom-color:var(--primary)}.layout{grid-template-columns:var(--sidebar-width) minmax(0,1fr);min-height:calc(100vh - 56px)}aside{padding:18px 12px}aside h2{margin:0 10px 18px;font-size:14px}.workspace-mark{display:flex;align-items:center;gap:10px;margin:0 8px 24px}.project-mark{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:5px;background:var(--selected);color:var(--primary);font-weight:700;flex-shrink:0}.workspace-mark small{display:block;color:var(--muted);font-weight:400;font-size:11px}.nav-label{font-size:11px;font-weight:600;color:var(--muted);margin:24px 10px 8px}aside a{display:flex;gap:10px;align-items:center;min-height:36px;padding:7px 10px;line-height:1.4}aside a:hover{background:var(--hover);text-decoration:none}aside a.selected{background:var(--selected)}.icon{width:16px;height:16px;flex:none;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.nav-project{overflow:hidden}.nav-project span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-project .project-mark{width:22px;height:22px;font-size:10px}main{padding:24px 32px}.breadcrumb{margin-bottom:18px;font-size:12px;display:flex;align-items:center;gap:8px}.titlebar{margin-bottom:20px;gap:10px}h1{font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.6px}h2{font-size:15px;font-weight:600;margin:26px 0 12px}.toolbar{gap:8px;flex-wrap:wrap;margin-bottom:18px}.toolbar input{width:220px}.toolbar select{max-width:180px}button,input,select{min-height:var(--control-height);padding:5px 9px;border-radius:4px}.tabs{display:flex;gap:22px;border-bottom:2px solid var(--hover);margin-bottom:20px}.tabs button{border:0;background:transparent;border-radius:0;padding:9px 2px;margin-bottom:-2px;border-bottom:2px solid transparent;color:var(--muted)}.tabs button[aria-pressed="true"]{border-bottom-color:var(--primary);color:var(--primary)}.table-wrap{border:0;border-top:1px solid var(--border);border-radius:0}table{font-size:13px}th{background:var(--background);color:var(--muted);font-size:12px;font-weight:600;height:40px}td{height:var(--row-height);padding:9px 12px}tr:hover td{background:var(--surface)}td.summary{min-width:220px}td.summary a{color:var(--ink)}.type-icon{display:inline-grid;place-items:center;width:15px;height:15px;border-radius:2px;background:var(--primary);color:var(--background);font-size:11px;font-weight:700;margin-right:8px}.type-icon.bug{background:var(--danger)}.type-icon.story{background:var(--success)}.type-icon.epic{background:#8270db}.status{border-radius:3px;font-size:11px;font-weight:650;padding:2px 6px;background:var(--hover);color:var(--ink);white-space:nowrap}.status.indeterminate{background:var(--selected);color:var(--primary)}.status.done{background:#dcfff1;color:var(--success)}.person{display:inline-flex;gap:7px;align-items:center;white-space:nowrap}.person .avatar{width:23px;height:23px;font-size:9px}.priority{display:inline-flex;align-items:center;gap:6px}.priority-mark{font-size:17px;color:var(--muted)}.priority-mark.high{color:var(--danger)}.board{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:16px;align-items:start}.board-column{background:var(--surface);border-radius:5px;padding:12px;min-height:240px}.board-column h2{display:flex;justify-content:space-between;font-size:12px;margin:0 0 14px;color:var(--muted)}.board-card{display:block;background:var(--background);border:1px solid var(--border);border-radius:4px;padding:12px;margin-bottom:8px;color:var(--ink)}.board-card:hover{border-color:var(--primary);text-decoration:none}.board-card footer{display:flex;align-items:center;gap:6px;margin-top:18px;font-size:11px}.board-card .avatar{margin-left:auto}.issue-grid{grid-template-columns:minmax(0,1fr) 310px;gap:40px}.properties{border:1px solid var(--border);padding:0;border-radius:4px;align-self:start}.properties h2{padding:12px 16px;margin:0;border-bottom:1px solid var(--border)}.properties label{display:grid;grid-template-columns:84px minmax(0,1fr);gap:12px;align-items:center;margin:0;padding:10px 16px;font-size:12px}.properties select{width:100%;background:var(--surface);border-color:transparent}.property-value{padding:10px 16px;display:grid;grid-template-columns:84px 1fr;gap:12px;font-size:12px}.issue-actions{display:flex;gap:8px;margin-bottom:22px}.issue-description{min-height:90px}.activity-heading{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);padding-bottom:12px}.activity-heading span{font-size:12px;color:var(--muted)}.comment{display:grid;grid-template-columns:30px 1fr;gap:10px;border:0;padding:14px 0}.comment time{font-size:11px;margin-left:9px;color:var(--muted)}.comment p{margin:6px 0}.comment-compose{display:flex;gap:10px}.comment-compose form{flex:1}.comment-compose textarea{min-height:85px;width:100%;resize:vertical;background:var(--background)}.metadata{font-size:12px;color:var(--muted)}.copy{white-space:pre-wrap;overflow-wrap:anywhere}.tag{background:var(--hover);border-radius:3px;font-size:11px;padding:2px 6px}.tree details{margin:0}.tree summary{display:flex;align-items:center;font-weight:400;padding:0;min-height:32px;list-style:none}.tree summary:before{content:'›';width:16px;flex:none;font-size:18px;text-align:center;transition:transform .15s ease-out}.tree details[open]>summary:before{transform:rotate(90deg)}.tree summary a{min-width:0;flex:1}.tree a{min-height:32px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.tree a svg{width:14px;height:14px}.tree a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.space-heading{display:flex;align-items:center;gap:8px}.space-count{margin-left:auto;font-weight:400;font-size:11px;color:var(--muted)}.page-row{display:flex;align-items:center;gap:14px;min-height:67px;padding:12px 8px;color:var(--ink);border-bottom:1px solid var(--border)}.page-row:hover{background:var(--surface);text-decoration:none}.page-row small{display:block;color:var(--muted);font-size:11px;margin-top:3px}.page-row .icon{color:var(--primary);width:20px;height:20px}.page-list{max-width:none}.document-shell{max-width:var(--page-width);margin:28px auto 0}.document-shell .titlebar{margin-bottom:16px}.document-shell h1{font-size:28px}.document-layout{display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:44px}.document{max-width:none;font-size:14px;line-height:1.75;padding:18px 0 32px}.document:not([contenteditable])>.document-title{display:none}.document h2{font-size:20px;margin:26px 0 10px}.document h3{font-size:16px;margin:24px 0 8px}.document table{font-size:13px}.document th,.document td{border:1px solid var(--border);padding:8px 12px}.document th{background:var(--surface)}.document ul{padding-left:24px}.document blockquote{border-left:3px solid var(--primary);padding:4px 16px;margin-left:0;background:var(--surface)}.page-outline{padding-top:25px;font-size:11px;color:var(--muted)}.page-outline strong{font-weight:600}.page-outline a{display:block;padding:5px 0;color:var(--muted);line-height:1.4}.page-outline a:hover{color:var(--primary)}#editor-controls{max-width:var(--page-width);margin:0 auto}#editor-controls input{width:100%;margin:8px 0 12px}.document[contenteditable]{padding:18px 14px;border:1px solid var(--primary);border-radius:4px;min-height:250px}.document[contenteditable]:focus{outline:2px solid var(--selected);outline-offset:2px}dialog{border:0;border-radius:6px;box-shadow:var(--shadow);width:640px;padding:28px}dialog::backdrop{background:rgba(9,30,66,.5)}dialog h2{font-size:20px;margin:0 0 22px}dialog label{display:block;font-size:12px;font-weight:600;margin:16px 0}dialog input,dialog select,dialog textarea{display:block;width:100%;margin-top:6px;background:var(--surface)}dialog textarea{min-height:100px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}#notice:empty{display:none}#notice:not(:empty){padding:10px 24px;background:#fff7d6;color:var(--ink);border-bottom:1px solid var(--border)}#sync-state{font-size:10px;color:var(--muted);margin-top:32px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:1050px){:root{--sidebar-width:220px}.issue-grid{grid-template-columns:minmax(0,1fr) 260px;gap:24px}.document-layout{grid-template-columns:1fr}.page-outline{display:none}main{padding:24px}.toolbar select{max-width:140px}}@media(max-width:760px){.layout{grid-template-columns:180px minmax(0,1fr)}.issue-grid,.board{grid-template-columns:1fr}.demo{display:none}header{gap:16px}header nav{gap:16px}.toolbar input{width:180px}.document-shell h1{font-size:24px}}@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
.jira-rich{white-space:normal}.jira-rich p{margin:0 0 var(--gap)}.jira-rich ul,.jira-rich ol{margin:0 0 var(--gap);padding-left:24px}.jira-rich li{margin:3px 0}.jira-rich h3{font-size:15px;margin:18px 0 var(--gap)}.jira-rich code{background:var(--hover);padding:1px 4px;border-radius:3px}
`;

function client() {
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function jiraMarkup(value) {
    // Escape first; the only markup emitted is this bounded Jira wiki subset.
    const inline = (text) => escape(text).replace(/\{\{([^{}]+)\}\}/g, '<code>$1</code>').replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    const html = []; let list = "", paragraph = [];
    const flush = () => { if (paragraph.length) { html.push(`<p>${paragraph.join("<br>")}</p>`); paragraph = []; } };
    const closeList = () => { if (list) { html.push(`</${list}>`); list = ""; } };
    for (const line of String(value ?? "").split(/\r?\n/)) {
      const item = /^(\*+|#+)\s+(.*)$/.exec(line);
      if (item) { flush(); const next = item[1][0] === "#" ? "ol" : "ul"; if (list !== next) { closeList(); html.push(`<${next}>`); list = next; } html.push(`<li>${inline(item[2])}</li>`); continue; }
      closeList();
      if (!line.trim()) { flush(); continue; }
      const heading = /^h[1-6]\.\s+(.*)$/.exec(line);
      if (heading) { flush(); html.push(`<h3>${inline(heading[1])}</h3>`); } else paragraph.push(inline(line));
    }
    flush(); closeList();
    return `<div class="jira-rich">${html.join("")}</div>`;
  }
  const options = (items, selected, value = "name", title = "name") => items.map((item) => `<option value="${escape(item[value])}" ${String(item[value]) === String(selected) ? "selected" : ""}>${escape(item[title])}</option>`).join("");
  const date = (value) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const issuePath = (key) => `/jira/browse/${encodeURIComponent(key)}`;
  const pagePath = (id) => `/confluence/pages/${encodeURIComponent(id)}`;
  const params = new URLSearchParams(location.search);
  let selectedProject = params.get("project") || "", view = params.get("view") === "board" ? "board" : "list";
  const selectedSpace = params.get("space") || "";
  const icons = { list: '<path d="M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01"/>', board: '<rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="12" rx="1"/>', page: '<path d="M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h6"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>', folder: '<path d="M3 7V4h6l3 3h9v13H3z"/>', edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/>', comment: '<path d="M21 16H8l-5 5V3h18z"/>' };
  const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.page}</svg>`;
  const initials = (name) => String(name || "Unassigned").split(/\s+/).map((part) => part[0]).slice(0, 2).join("");
  const avatar = (name) => `<span class="avatar" aria-hidden="true">${escape(initials(name))}</span>`;
  const typeIcon = (name) => `<span class="type-icon ${escape(String(name).toLowerCase())}" title="${escape(name)}" aria-label="${escape(name)}">${name === "Bug" ? "•" : name === "Story" ? "▰" : name === "Epic" ? "ϟ" : "✓"}</span>`;
  const priority = (name) => `<span class="priority"><span class="priority-mark ${/high|critical|highest/i.test(name) ? "high" : ""}" aria-hidden="true">${/high|critical|highest/i.test(name) ? "↑" : /low/i.test(name) ? "↓" : "="}</span>${escape(name || "None")}</span>`;
  const jira = "/jira/rest/api/2";
  const confluence = "/confluence/rest/api";
  let projects = [], people = [], priorities = [], pages = [], spaces = [], issues = [];
  let currentPage, editingVersion, busy = false, refreshing = false, lastVerified = "";
  const isJira = location.pathname.startsWith("/jira");
  const key = isJira ? decodeURIComponent(location.pathname.split("/")[3] || "") : "";
  const pageId = !isJira ? decodeURIComponent(location.pathname.split("/")[3] || "") : "";
  const notice = (message) => {
    $("notice").textContent = message;
    if ($("create-error")) $("create-error").textContent = $("create-dialog").open ? message : "";
    if ($("edit-issue-error")) $("edit-issue-error").textContent = $("edit-issue-dialog").open ? message : "";
  };
  function patch(id, html) {
    const node = $(id);
    if (node && node.innerHTML !== html && !node.contains(document.activeElement)) node.innerHTML = html;
  }
  async function api(path, method = "GET", body) {
    const response = await fetch("/api/atlassian" + path, {
      method, headers: { "Content-Type": "application/json", "X-Demo-CSRF": document.querySelector('meta[name="demo-csrf"]').content },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.message || data?.errorMessages?.join("; ") || `Request failed (${response.status}).`);
    return data;
  }
  async function mutate(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button[type="submit"], .properties select').forEach((control) => { control.disabled = true; });
    try { await action(); notice(""); await refresh(); }
    catch (error) { notice(`${error.message} Your changes are kept. Try again.`); }
    finally { busy = false; document.querySelectorAll('button[type="submit"], .properties select').forEach((control) => { control.disabled = false; }); }
  }
  // Rebuild allowed markup, never reuse source nodes/attributes. Scripts, SVG, embeds,
  // styles, event handlers, remote media and non-workplace links cannot enter the live DOM.
  function safeStorage(storage) {
    const source = new DOMParser().parseFromString(String(storage || ""), "text/html");
    const allowed = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "BLOCKQUOTE", "PRE", "CODE", "BR", "HR"]);
    const discarded = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "IMG", "LINK", "META", "FORM", "INPUT", "BUTTON"]);
    function localLink(href) {
      if (!href) return null;
      try {
        const url = new URL(href, location.origin);
        const issue = /^(?:\/jira)?\/browse\/([A-Z][A-Z0-9_]*-\d+)$/.exec(url.pathname);
        if (issue) return issuePath(issue[1]);
        const page = /^\/confluence\/pages\/(\d+)$/.exec(url.pathname);
        if (page) return pagePath(page[1]);
        if (/\/(?:pages\/)?viewpage\.action$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get("pageId") || "")) return pagePath(url.searchParams.get("pageId"));
      } catch { /* Non-workplace links are plain text. */ }
      return null;
    }
    function copy(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || discarded.has(node.tagName)) return;
      let target = parent;
      const href = node.tagName === "A" ? localLink(node.getAttribute("href")) : null;
      if (allowed.has(node.tagName) || href) {
        target = document.createElement(href ? "a" : node.tagName.toLowerCase());
        if (href) target.setAttribute("href", href);
        parent.append(target);
      }
      for (const child of node.childNodes) copy(child, target);
    }
    const result = document.createElement("div");
    for (const node of source.body.childNodes) copy(node, result);
    return result.innerHTML;
  }
  function status(value) { return `<span class="status ${escape(value?.statusCategory?.key || "")}">${escape(value?.name)}</span>`; }
  function renderIssues() {
    const query = $("search").value.toLowerCase();
    const project = $("project-filter").value;
    selectedProject = project;
    const statusFilter = $("status-filter").value, assigneeFilter = $("assignee-filter").value;
    const filtered = issues.filter((issue) => (!project || issue.fields.project.key === project) && (!statusFilter || issue.fields.status.statusCategory.key === statusFilter) && (!assigneeFilter || (assigneeFilter === "unassigned" ? !issue.fields.assignee : issue.fields.assignee?.name === assigneeFilter)) && `${issue.key} ${issue.fields.summary} ${issue.fields.description || ""} ${(issue.fields.labels || []).join(" ")}`.toLowerCase().includes(query));
    filtered.sort((a, b) => $("sort-issues").value === "key" ? a.key.localeCompare(b.key, undefined, { numeric: true }) : new Date(b.fields.updated) - new Date(a.fields.updated));
    const projectData = projects.find((p) => p.key === project);
    $("list-title").textContent = projectData?.name || "All issues";
    document.querySelectorAll("[data-project]").forEach((node) => { node.classList.toggle("selected", node.dataset.project === project); });
    $("issue-table").hidden = view !== "list";
    $("issue-board").hidden = view !== "board";
    document.querySelectorAll("[data-view]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.view === view)));
    const url = new URL(location.href); project ? url.searchParams.set("project", project) : url.searchParams.delete("project"); view === "board" ? url.searchParams.set("view", view) : url.searchParams.delete("view"); history.replaceState(null, "", url);
    patch("issue-board", [ ["new", "To do"], ["indeterminate", "In progress"], ["done", "Done"] ].map(([category, label]) => { const cards = filtered.filter((i) => i.fields.status.statusCategory.key === category); return `<section class="board-column"><h2>${label}<span>${cards.length}</span></h2>${cards.map((i) => `<a class="board-card" href="${issuePath(i.key)}">${escape(i.fields.summary)}<footer>${typeIcon(i.fields.issuetype?.name)}<span>${escape(i.key)}</span>${avatar(i.fields.assignee?.displayName)}</footer></a>`).join("") || '<p class="muted">No issues</p>'}</section>`; }).join(""));
    patch("issue-count", `${filtered.length} issues`);
    patch("issue-rows", filtered.length ? filtered.map((issue) => {
      const f = issue.fields;
      return `<tr><td class="nowrap">${typeIcon(f.issuetype?.name)}<a href="${issuePath(issue.key)}">${escape(issue.key)}</a></td><td class="summary"><a href="${issuePath(issue.key)}">${escape(f.summary)}</a></td><td>${escape(f.issuetype?.name)}</td><td>${status(f.status)}</td><td>${priority(f.priority?.name)}</td><td class="nowrap"><span class="person">${avatar(f.assignee?.displayName)}${escape(f.assignee?.displayName || "Unassigned")}</span></td><td class="nowrap muted">${escape(date(f.updated))}</td></tr>`;
    }).join("") : '<tr><td colspan="7" class="empty">No matching issues. Change your filters or create an issue.</td></tr>');
  }
  function renderTree() {
    const open = new Map([...document.querySelectorAll("#space-tree details")].map((node) => [node.dataset.branch, node.open]));
    function branch(parent, list, depth = 0, visited = new Set()) {
      if (depth > 15 || visited.has(parent)) return "";
      const seen = new Set(visited).add(parent);
      return list.filter((p) => (p.ancestors?.at(-1)?.id || "") === parent).map((p) => {
        const children = branch(p.id, list, depth + 1, seen);
        const link = `<a href="${pagePath(p.id)}" class="${p.id === pageId ? "selected" : ""}" ${p.id === pageId ? 'aria-current="page"' : ""}>${icon("page")}<span>${escape(p.title)}</span></a>`;
        const expanded = open.get(p.id) ?? true;
        return children ? `<details data-branch="${escape(p.id)}" ${expanded ? "open" : ""}><summary>${link}</summary><div style="padding-left:14px">${children}</div></details>` : `<div style="padding-left:16px">${link}</div>`;
      }).join("");
    }
    patch("space-tree", spaces.map((s) => `<details data-space="${escape(s.key)}" data-branch="space-${escape(s.key)}" ${(open.get("space-" + s.key) ?? (s.key === (pages.find((p) => p.id === pageId)?.space?.key || selectedSpace || spaces[0]?.key))) ? "open" : ""}><summary class="space-heading"><span class="project-mark">${escape(s.key.slice(0, 2))}</span>${escape(s.name)}<span class="space-count">${pages.filter((p) => p.space?.key === s.key).length}</span></summary><div class="tree">${branch("", pages.filter((p) => p.space?.key === s.key))}</div></details>`).join(""));
    if ($("space-filter")) { patch("space-filter", '<option value="">All spaces</option>' + options(spaces, $("space-filter").dataset.initialized ? $("space-filter").value : selectedSpace, "key")); $("space-filter").dataset.initialized = "true"; }
  }
  function renderPages() {
    const query = $("search").value.toLowerCase();
    const space = $("space-filter").value;
    const matches = pages.filter((p) => (!space || p.space?.key === space) && `${p.title} ${p.space?.name} ${p.body?.storage?.value?.replace(/<[^>]*>/g, " ") || ""}`.toLowerCase().includes(query));
    patch("page-count", `${matches.length} pages`);
    patch("page-results", matches.length ? matches.map((p) => `<a class="page-row" href="${pagePath(p.id)}">${icon("page")}<span><strong>${escape(p.title)}</strong><small>${escape(p.space?.name)} · Updated by ${escape(p.version?.by?.displayName || "")} · ${escape(date(p.version?.when))}</small></span><span class="spacer"></span><span class="muted">Version ${escape(p.version?.number)}</span></a>`).join("") : '<p class="empty">No matching pages. Try another search.</p>');
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      if (isJira) {
        if (key) {
          const [issue, transitions] = await Promise.all([api(`${jira}/issue/${encodeURIComponent(key)}?fields=*all`), api(`${jira}/issue/${encodeURIComponent(key)}/transitions`)]);
          const f = issue.fields;
          $("issue-title").textContent = f.summary;
          patch("issue-description", jiraMarkup(f.description || "No description yet."));
          patch("issue-labels", (f.labels || []).map((label) => `<span class="tag">${escape(label)}</span>`).join(""));
          patch("issue-meta", `${escape(f.issuetype?.name)} · Reported by ${escape(f.reporter?.displayName || "Unknown")} · Updated ${escape(date(f.updated))}`);
          patch("service-request-fields", `${f.customfield_10010?.requestType?.name ? `<p>Request type<br><strong>${escape(f.customfield_10010.requestType.name)}</strong></p>` : ""}${f.customfield_10500?.value ? `<p>Application<br><strong>${escape(f.customfield_10500.value)}</strong></p>` : ""}${f.customfield_10501?.value ? `<p>Hardware<br><strong>${escape(f.customfield_10501.value)}</strong></p>` : ""}`);
          patch("issue-status", `<option value="">${escape(f.status.name)}</option>${options(transitions.transitions.filter((t) => t.to.name !== f.status.name), null, "id")}`);
          patch("issue-priority", options(priorities, f.priority?.name));
          patch("issue-assignee", `<option value="">Unassigned</option>${options(people, f.assignee?.name, "name", "displayName")}`);
          patch("issue-comments", (f.comment?.comments || []).map((c) => `<article class="comment">${avatar(c.author?.displayName)}<div><strong>${escape(c.author?.displayName)}</strong><time>${escape(date(c.created))}</time><div class="copy">${jiraMarkup(c.body)}</div></div></article>`).join("") || '<p class="muted">No comments yet.</p>');
          if (!$("edit-issue-dialog").open) { $("edit-issue-summary").value = f.summary; $("edit-issue-description").value = f.description || ""; }
          document.querySelectorAll("[data-project]").forEach((node) => node.classList.toggle("selected", node.dataset.project === f.project.key));
        } else {
          const result = await api(`${jira}/search?jql=${encodeURIComponent("ORDER BY updated DESC")}&maxResults=1000&fields=*all`);
          issues = result.issues; renderIssues();
        }
      } else {
        const [spaceResult, pageResult] = await Promise.all([api(`${confluence}/space?limit=500`), api(`${confluence}/content?type=page&limit=500&expand=space,ancestors,body.storage,version,metadata.labels`)]);
        spaces = spaceResult.results; pages = pageResult.results; renderTree();
        if (pageId) {
          currentPage = await api(`${confluence}/content/${encodeURIComponent(pageId)}?expand=space,ancestors,body.storage,version,history,metadata.labels`);
          const p = currentPage;
          patch("page-breadcrumb", `<a href="/confluence">Spaces</a> / <a href="/confluence?space=${encodeURIComponent(p.space?.key || "")}">${escape(p.space?.name)}</a>${(p.ancestors || []).map((a) => ` / <a href="${pagePath(a.id)}">${escape(a.title)}</a>`).join("")}`);
          $("page-title").textContent = p.title;
          patch("page-meta", `Edited by ${escape(p.version?.by?.displayName)} · ${escape(date(p.version?.when))} · Version ${escape(p.version?.number)}`);
          patch("page-labels", (p.metadata?.labels?.results || []).map((label) => `<span class="tag">${escape(label.name)}</span>`).join(""));
          if (!editingVersion) {
            const content = document.createElement("div"); content.innerHTML = safeStorage(p.body?.storage?.value);
            if (content.firstElementChild?.tagName === "H1" && content.firstElementChild.textContent.trim() === p.title.trim()) content.firstElementChild.classList.add("document-title");
            const headings = [...content.querySelectorAll("h2,h3")];
            headings.forEach((heading, index) => { heading.id = `section-${index}`; });
            patch("document", content.innerHTML);
            patch("page-outline", headings.length ? `<strong>On this page</strong>${headings.map((heading, index) => `<a href="#section-${index}">${escape(heading.textContent)}</a>`).join("")}` : "");
          }
          else if (p.version.number !== editingVersion) notice("This page changed while you were editing. Copy your draft, cancel, and edit the latest version before saving.");
          $("edit-page").disabled = false;
        } else renderPages();
      }
      lastVerified = new Date().toLocaleTimeString();
      $("sync-state").textContent = `Live · Last synced ${lastVerified}`;
      if ($("notice").textContent.startsWith("Couldn't sync")) notice("");
    } catch (error) { notice(`Couldn't sync: ${error.message} Last verified ${lastVerified || "not yet"}. Retrying automatically.`); }
    finally { refreshing = false; }
  }
  function shell() {
    if (isJira) {
      $("sidebar").innerHTML = `<div class="workspace-mark"><span class="project-mark">AR</span><strong>Acme Robotics<small>Jira workspace</small></strong></div><a data-project="" href="/jira">${icon("list")}All issues</a><div class="nav-label">Projects</div>${projects.map((p) => `<a class="nav-project" data-project="${escape(p.key)}" href="/jira?project=${encodeURIComponent(p.key)}"><span class="project-mark">${escape(p.key.slice(0, 2))}</span><span>${escape(p.name)}</span></a>`).join("")}<div class="nav-label">Connected workspace</div><a href="/confluence">${icon("page")}Team knowledge</a>`;
      $("main").innerHTML = key ? `<div class="breadcrumb"><a href="/jira">Issues</a> / ${escape(key)}</div><div class="titlebar"><h1 id="issue-title">${escape(key)}</h1></div><div class="issue-actions"><button id="edit-issue">${icon("edit")} Edit issue</button><button id="add-comment">${icon("comment")} Add comment</button></div><div class="issue-grid"><section><h2>Description</h2><div id="issue-description" class="copy issue-description"><div class="skeleton"></div></div><div id="issue-labels"></div><h2 class="activity-heading">Activity <span>Comments</span></h2><div id="issue-comments"></div><div class="comment-compose">${avatar("Alex Chen")}<form id="comment-form"><label for="comment-body">Add a comment</label><textarea id="comment-body" required placeholder="Write a comment…"></textarea><div class="actions"><button type="submit" class="primary">Post comment</button></div></form></div><div id="issue-meta" class="metadata"></div></section><section class="properties" aria-label="Issue details"><h2>Details</h2><label><span id="issue-status-label">Status</span><select id="issue-status" aria-labelledby="issue-status-label"></select></label><label><span id="issue-priority-label">Priority</span><select id="issue-priority" aria-labelledby="issue-priority-label"></select></label><label><span id="issue-assignee-label">Assignee</span><select id="issue-assignee" aria-labelledby="issue-assignee-label"></select></label><div id="service-request-fields"></div></section></div>` : `<div class="breadcrumb"><a href="/jira">Projects</a> / Acme Robotics</div><div class="titlebar"><h1 id="list-title">All issues</h1><span class="spacer"></span><button class="primary" id="create-issue">Create issue</button></div><div class="tabs" aria-label="Project views"><button type="button" data-view="list" aria-pressed="true">${icon("list")} List</button><button type="button" data-view="board" aria-pressed="false">${icon("board")} Board</button></div><div class="toolbar"><label><span class="sr-only">Search issues</span><input type="search" id="search" placeholder="Search issues"></label><label><span class="sr-only">Project</span><select id="project-filter"><option value="">All projects</option>${options(projects, selectedProject, "key")}</select></label><label><span class="sr-only">Status</span><select id="status-filter"><option value="">All statuses</option><option value="new">To do</option><option value="indeterminate">In progress</option><option value="done">Done</option></select></label><label><span class="sr-only">Assignee</span><select id="assignee-filter"><option value="">All assignees</option><option value="unassigned">Unassigned</option>${options(people, null, "name", "displayName")}</select></label><span class="spacer"></span><span id="issue-count" class="muted"></span><label><span class="sr-only">Sort issues</span><select id="sort-issues"><option value="updated">Recently updated</option><option value="key">Issue key</option></select></label></div><div id="issue-board" class="board" hidden></div><div id="issue-table" class="table-wrap"><table><thead><tr><th>Key</th><th>Summary</th><th>Type</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Updated</th></tr></thead><tbody id="issue-rows"><tr><td colspan="7"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></td></tr></tbody></table></div>`;
      if (key) {
        $("main").insertAdjacentHTML("beforeend", '<dialog id="edit-issue-dialog" aria-labelledby="edit-issue-heading"><form id="edit-issue-form"><h2 id="edit-issue-heading">Edit issue</h2><label>Summary<input id="edit-issue-summary" required maxlength="255"></label><label>Description<textarea id="edit-issue-description"></textarea></label><p id="edit-issue-error" role="alert"></p><div class="actions"><button id="cancel-issue-edit" type="button">Cancel</button><button type="submit" class="primary">Save changes</button></div></form></dialog>');
        $("edit-issue").onclick = () => $("edit-issue-dialog").showModal();
        $("cancel-issue-edit").onclick = () => $("edit-issue-dialog").close();
        $("add-comment").onclick = () => $("comment-body").focus();
        $("edit-issue-form").onsubmit = (event) => { event.preventDefault(); if (!$("edit-issue-summary").value.trim()) return; mutate(async () => { await api(`${jira}/issue/${encodeURIComponent(key)}`, "PUT", { fields: { summary: $("edit-issue-summary").value.trim(), description: $("edit-issue-description").value } }); $("edit-issue-dialog").close(); }); };
        $("issue-status").onchange = (event) => { const value = event.target.value; if (value) mutate(() => api(`${jira}/issue/${encodeURIComponent(key)}/transitions`, "POST", { transition: { id: value } })); };
        for (const field of ["priority", "assignee"]) $("issue-" + field).onchange = (event) => {
          const value = event.target.value;
          mutate(() => api(`${jira}/issue/${encodeURIComponent(key)}`, "PUT", { fields: { [field]: value ? { name: value } : null } }));
        };
        $("comment-form").onsubmit = (event) => { event.preventDefault(); const value = $("comment-body").value; if (!value.trim()) return; mutate(async () => { await api(`${jira}/issue/${encodeURIComponent(key)}/comment`, "POST", { body: value }); $("comment-body").value = ""; }); };
      } else {
        $("search").oninput = renderIssues;
        for (const id of ["project-filter", "status-filter", "assignee-filter", "sort-issues"]) $(id).onchange = renderIssues;
        document.querySelectorAll("[data-view]").forEach((node) => { node.onclick = () => { view = node.dataset.view; renderIssues(); }; });
        $("create-issue").onclick = () => { $("create-error").textContent = ""; if (selectedProject) { $("new-project").value = selectedProject; $("new-project").dispatchEvent(new Event("change")); } $("create-dialog").showModal(); };
      }
    } else {
      $("sidebar").innerHTML = `<div class="workspace-mark"><span class="project-mark">AR</span><strong>Acme Robotics<small>Knowledge workspace</small></strong></div><a href="/confluence">${icon("page")}All pages</a><a href="/jira">${icon("list")}Jira issues</a><div class="nav-label">Spaces</div><div id="space-tree"></div>`;
      $("main").innerHTML = pageId ? '<div id="page-breadcrumb" class="breadcrumb">Spaces</div><div class="document-shell"><div class="titlebar"><h1 id="page-title">Page</h1><span class="spacer"></span><button id="edit-page" disabled>Edit page</button></div><div id="page-meta" class="metadata"></div><div id="editor-controls" hidden><label for="edit-title">Page title</label><input id="edit-title" required><div class="toolbar"><button id="save-page" class="primary">Save changes</button><button id="cancel-edit">Cancel</button><span class="muted">Rich text · formatting is preserved</span></div></div><div class="document-layout"><article id="document" class="document"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></article><nav id="page-outline" class="page-outline" aria-label="On this page"></nav></div><div id="page-labels"></div></div>' : '<div class="breadcrumb">Acme Robotics / Knowledge</div><div class="titlebar"><h1>Pages</h1></div><div class="toolbar"><label><span class="sr-only">Search pages</span><input id="search" type="search" placeholder="Search pages and spaces"></label><label><span class="sr-only">Space</span><select id="space-filter"><option value="">All spaces</option></select></label><span class="spacer"></span><span id="page-count" class="muted"></span></div><div id="page-results" class="page-list"><div class="skeleton"></div><div class="skeleton"></div></div>';
      if (!pageId) { $("search").oninput = renderPages; $("space-filter").onchange = renderPages; }
      else {
        function endEditing() {
          editingVersion = null; $("document").removeAttribute("contenteditable"); $("document").removeAttribute("role"); $("document").removeAttribute("aria-label");
          $("editor-controls").hidden = true; $("edit-page").hidden = false;
        }
        $("edit-page").onclick = () => {
          editingVersion = currentPage.version.number; $("edit-title").value = currentPage.title;
          $("editor-controls").hidden = false; $("edit-page").hidden = true;
          $("document").contentEditable = "true"; $("document").setAttribute("role", "textbox"); $("document").setAttribute("aria-label", "Page body"); $("document").setAttribute("aria-multiline", "true"); $("document").focus();
        };
        $("document").addEventListener("paste", (event) => {
          if (!editingVersion) return;
          event.preventDefault();
          const selection = window.getSelection();
          if (!selection.rangeCount) return;
          const range = selection.getRangeAt(0); range.deleteContents();
          const fragment = range.createContextualFragment(event.clipboardData.getData("text/html") ? safeStorage(event.clipboardData.getData("text/html")) : escape(event.clipboardData.getData("text/plain")).replace(/\n/g, "<br>"));
          const last = fragment.lastChild; range.insertNode(fragment); if (last) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
        });
        $("document").addEventListener("drop", (event) => { if (editingVersion) event.preventDefault(); });
        $("cancel-edit").onclick = () => { endEditing(); notice(""); patch("document", safeStorage(currentPage.body?.storage?.value)); $("edit-page").focus(); };
        $("save-page").onclick = () => {
          if (!$("edit-title").reportValidity()) return;
          const title = $("edit-title").value.trim(); if (!title) return;
          const body = safeStorage($("document").innerHTML);
          mutate(async () => {
            $("save-page").disabled = true;
            try { await api(`${confluence}/content/${encodeURIComponent(pageId)}`, "PUT", { id: pageId, type: "page", title, version: { number: editingVersion + 1 }, body: { storage: { value: body, representation: "storage" } } }); endEditing(); $("edit-page").focus(); }
            finally { $("save-page").disabled = false; }
          });
        };
      }
    }
  }
  async function start() {
    if (isJira) {
      try { [projects, people, priorities] = await Promise.all([api(`${jira}/project`), api(`${jira}/user/search?username=&maxResults=1000`), api(`${jira}/priority`)]); }
      catch (error) { notice(`Couldn't load issue controls: ${error.message} Reload after starting the demo backend.`); }
    }
    shell();
    $("new-project").innerHTML = options(projects, projects[0]?.key, "key");
    $("new-priority").innerHTML = options(priorities, "Medium");
    $("new-assignee").innerHTML = '<option value="">Unassigned</option>' + options(people, null, "name", "displayName");
    function updateTypes() {
      const project = projects.find((p) => p.key === $("new-project").value);
      const names = project?.projectTypeKey === "service_desk" ? ["IT Help", "Service Request", "Incident", "Task"] : project?.projectTypeKey === "business" ? ["Task"] : ["Task", "Story", "Bug", "Epic"];
      $("new-type").innerHTML = options(names.map((name) => ({ name })), "Task");
    }
    $("new-project").onchange = updateTypes; updateTypes();
    $("cancel-create").onclick = () => $("create-dialog").close();
    $("create-form").onsubmit = (event) => {
      event.preventDefault();
      mutate(async () => {
        const assignee = $("new-assignee").value;
        const created = await api(`${jira}/issue`, "POST", { fields: { project: { key: $("new-project").value }, summary: $("new-summary").value.trim(), description: $("new-description").value, issuetype: { name: $("new-type").value }, priority: { name: $("new-priority").value }, assignee: assignee ? { name: assignee } : null } });
        $("create-dialog").close(); location.assign(issuePath(created.key));
      });
    };
    await refresh();
    setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 2000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  }
  void start();
}

// Official Atlassian product marks; source URLs are recorded in worlds/atlassian-ui-references.md.
const jiraLogo = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#1868db" d="M16.5504 32.6743H13.2216C8.20121 32.6743 4.59961 29.5992 4.59961 25.0964H22.4984C23.4261 25.0964 24.0264 25.7554 24.0264 26.6889V44.7C19.5517 44.7 16.5504 41.0758 16.5504 36.0239V32.6743ZM25.3906 23.7236H22.0619C17.0415 23.7236 13.4399 20.7034 13.4399 16.2007H31.3387C32.2664 16.2007 32.9213 16.8047 32.9213 17.7382V35.7493C28.4465 35.7493 25.3906 32.1251 25.3906 27.0732V23.7236ZM34.2855 14.8279H30.9567C25.9363 14.8279 22.3347 11.7528 22.3347 7.25H40.2336C41.1613 7.25 41.7615 7.90894 41.7615 8.78754V26.7987C37.2868 26.7987 34.2855 23.1745 34.2855 18.1226V14.8279Z"/></svg>';
const confluenceLogo = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#1868db" d="M38.6528 30.0401C28.7772 25.265 25.8922 24.5514 21.7311 24.5514C16.8488 24.5514 12.6878 26.5822 8.97058 32.2905L8.36029 33.2236C7.86096 33.992 7.75 34.2664 7.75 34.5957C7.75 34.9251 7.91644 35.1995 8.52673 35.5837L14.7961 39.4807C15.1289 39.7002 15.4063 39.81 15.6837 39.81C16.0166 39.81 16.2386 39.6453 16.5714 39.1514L17.5701 37.6145C19.1236 35.2544 20.5106 34.486 22.286 34.486C23.8394 34.486 25.6703 34.9251 27.945 36.0228L34.4917 39.0965C35.1575 39.4258 35.8787 39.2611 36.2116 38.4927L39.3185 31.6867C39.6514 30.9183 39.4295 30.4243 38.6528 30.0401ZM9.85827 18.0199C19.7338 22.795 22.6188 23.5086 26.7799 23.5086C31.6622 23.5086 35.8233 21.4778 39.5405 15.7695L40.1507 14.8364C40.6501 14.068 40.761 13.7936 40.761 13.4643C40.761 13.1349 40.5946 12.8605 39.9843 12.4763L33.715 8.57932C33.3821 8.35977 33.1047 8.25 32.8273 8.25C32.4944 8.25 32.2725 8.41466 31.9396 8.90864L30.9409 10.4455C29.3875 12.8056 28.0005 13.574 26.2251 13.574C24.6716 13.574 22.8408 13.1349 20.566 12.0372L14.0193 8.96353C13.3536 8.63421 12.6323 8.79887 12.2994 9.56729L9.1925 16.3733C8.85961 17.1417 9.08154 17.6357 9.85827 18.0199Z"/></svg>';
function html(isJira) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="demo-csrf" content="${csrf}"><title>${isJira ? "Jira" : "Confluence"} · Acme Robotics demo</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head><body><header><a class="brand" href="${isJira ? "/jira" : "/confluence"}">${isJira ? jiraLogo + "Jira" : confluenceLogo + "Confluence"}</a><nav aria-label="Workplace"><a href="/jira" ${isJira ? 'aria-current="page"' : ""}>Projects</a><a href="/confluence" ${!isJira ? 'aria-current="page"' : ""}>Spaces</a></nav><span class="spacer"></span><span class="demo">Demo · fictional workspace</span><span class="avatar" title="Alex Chen" aria-label="Alex Chen">AC</span></header><div id="notice" role="status" aria-live="polite"></div><div class="layout"><aside id="sidebar" aria-label="${isJira ? "Projects" : "Spaces and pages"}"></aside><main><div id="main"><div class="skeleton"></div><div class="skeleton"></div></div><footer id="sync-state">Not synced yet</footer></main></div><dialog id="create-dialog" aria-labelledby="create-heading"><form id="create-form"><h2 id="create-heading">Create issue</h2><p id="create-error" role="alert"></p><div class="columns"><label>Project<select id="new-project" required></select></label><label>Issue type<select id="new-type" required></select></label></div><label>Summary<input id="new-summary" required maxlength="255"></label><label>Description<textarea id="new-description"></textarea></label><div class="columns"><label>Priority<select id="new-priority"></select></label><label>Assignee<select id="new-assignee"></select></label></div><div class="actions"><button type="button" id="cancel-create">Cancel</button><button type="submit" class="primary">Create issue</button></div></form></dialog></body></html>`;
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://demo.local");
    if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, service: "demo-workplace-ui", fictional: true });
    if (url.pathname.startsWith("/api/atlassian/")) {
      const path = url.pathname.slice("/api/atlassian".length);
      if (!/^\/(jira\/rest\/(api\/2|servicedeskapi)|confluence\/rest\/api)(\/|$)/.test(path) || /%2f|%5c|%2e/i.test(path) || path.includes("\\")) return send(res, 400, { message: "Only demo Jira and Confluence REST paths are allowed." });
      if (!["GET", "POST", "PUT", "DELETE"].includes(req.method)) return send(res, 405, { message: "Method not allowed." });
      if (req.method !== "GET" && req.headers["x-demo-csrf"] !== csrf) return send(res, 403, { message: "Open the demo page before making changes." });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(res, 413, { message: "Request exceeds the demo's 1 MB limit." });
        chunks.push(chunk);
      }
      const destination = new URL(upstream.origin + path + url.search);
      if (destination.origin !== upstream.origin) return send(res, 400, { message: "Invalid demo destination." });
      const response = await fetch(destination, {
        method: req.method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: "Bearer demo-pat", "Content-Type": "application/json", Accept: "application/json" },
        ...(size ? { body: Buffer.concat(chunks) } : {}),
      });
      const body = await response.text();
      if (response.status === 204) { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); }
      // Never reflect executable upstream content or forward cookies/auth headers.
      let data;
      try { data = JSON.parse(body); } catch { return send(res, 502, { message: "The demo backend returned an invalid response." }); }
      return send(res, response.status, data);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "Method not allowed." });
    if (url.pathname === "/") { res.writeHead(302, { Location: "/jira" }); return res.end(); }
    // The real Atlassian MCP returns these Data Center browse links. Keep them clickable in the demo.
    if (url.pathname === "/confluence/pages/viewpage.action" && /^\d+$/.test(url.searchParams.get("pageId") || "")) {
      res.writeHead(302, { Location: `/confluence/pages/${url.searchParams.get("pageId")}` }); return res.end();
    }
    if (url.pathname === "/app.js") return send(res, 200, `(${client.toString()})();`, "text/javascript");
    if (url.pathname === "/styles.css") return send(res, 200, css, "text/css");
    if (/^\/jira(?:\/browse\/[A-Z][A-Z0-9_]*-\d+)?\/?$/.test(url.pathname) || /^\/confluence(?:\/pages\/\d+)?\/?$/.test(url.pathname)) return send(res, 200, html(url.pathname.startsWith("/jira")), "text/html");
    return send(res, 404, { message: "Page not found. Open /jira or /confluence." });
  } catch {
    return send(res, 502, { message: "The demo backend is unavailable. Start demo-atlassian.mjs and retry." });
  }
});
server.listen(PORT, HOST, () => console.log(`Demo workplace UI: http://${HOST}:${PORT}/jira (fictional workspace)`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
