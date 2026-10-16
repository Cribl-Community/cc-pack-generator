import{n as e,t}from"./main-u6RLtJSH.js";var n=`
  :root{--teal:#00b8b8;--teal-d:#006d6d;--ink:#1a1a2e;--grey:#4b5563;--mut:#8c94a0;--line:#e6e9ee;--bg:#f5f7fa;--ok:#237804;--warn:#d48806;--fail:#cf1322}
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;padding:26px}
  .page{max-width:920px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:32px 40px;box-shadow:0 4px 24px rgba(0,0,0,.05)}
  header{display:flex;align-items:center;gap:14px;border-bottom:2px solid var(--teal);padding-bottom:16px;margin-bottom:8px}
  h1{font-size:23px;font-weight:800}h1 span{color:var(--teal-d)}
  .sub{font-size:12.5px;color:var(--grey);margin-top:3px}
  .badge{margin-left:auto;background:linear-gradient(135deg,var(--teal),#0095a8);color:#fff;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:7px 13px;border-radius:20px;white-space:nowrap}
  .xref{font-size:12.5px;color:var(--grey);background:#f0fbfc;border:1px solid #cdeef0;border-radius:10px;padding:9px 14px;margin:14px 0 0}
  .xref a,p a,li a,td a{color:var(--teal-d);font-weight:600}
  .toc{background:#fbfdfe;border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:18px 0 4px}
  .toc b{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut)}
  .toc ol{margin:8px 0 0 20px}
  .toc li{font-size:13px;color:var(--teal-d);font-weight:600;margin-bottom:3px}
  .toc a{color:inherit;text-decoration:none;border-bottom:1px solid transparent}
  .toc a:hover,.toc a:focus{border-bottom-color:var(--teal);color:var(--teal)}
  .toc .fmts{list-style:none;margin:4px 0 6px 0;display:flex;flex-wrap:wrap;gap:5px}
  .toc .fmts li{margin:0;font-size:11px;font-weight:700}
  .toc .fmts a{display:inline-block;background:#f0fbfc;border:1px solid #cdeef0;border-radius:20px;padding:2px 9px}
  .toc .fmts a:hover{background:var(--teal);color:#fff;border-color:var(--teal)}
  .tools{display:none;gap:8px;margin-left:auto;align-items:center}
  .tools button{font-family:inherit;font-size:11.5px;font-weight:700;color:var(--teal-d);background:#fff;border:1px solid var(--teal);border-radius:20px;padding:6px 13px;cursor:pointer}
  .tools button:hover{background:var(--teal);color:#fff}
  .totop{position:fixed;right:18px;bottom:18px;background:var(--teal-d);color:#fff;text-decoration:none;font-size:11.5px;font-weight:700;padding:8px 13px;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.18);opacity:.85}
  .totop:hover{opacity:1}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:#fff;font-size:12.5px;padding:9px 16px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.25);display:none;max-width:90vw}
  .chap{margin-top:34px;padding-top:6px;scroll-margin-top:14px}
  h2,h3,[id]{scroll-margin-top:14px}
  .chap-h{display:flex;align-items:center;gap:12px;border-bottom:2px solid var(--line);padding-bottom:10px;margin-bottom:14px}
  .chap-n{flex:0 0 auto;width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--teal),#0095a8);color:#fff;font-size:17px;font-weight:800;display:flex;align-items:center;justify-content:center}
  .chap-t{font-size:18px;font-weight:800}
  h2{font-size:15px;font-weight:800;margin:24px 0 11px;display:flex;align-items:center;gap:9px}
  h2 .d{width:9px;height:9px;border-radius:50%;background:var(--teal)}
  h3{font-size:13px;font-weight:800;color:var(--teal-d);margin:16px 0 6px}
  p{font-size:13px;color:var(--grey);margin-bottom:10px}
  ul,ol.steps{margin:0 0 12px 20px}
  li{font-size:12.5px;color:var(--grey);margin-bottom:5px}
  code{background:#f0f3f6;border-radius:4px;padding:1px 5px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--teal-d)}
  kbd,.ui{font-family:inherit;font-size:11.5px;font-weight:700;color:var(--ink);background:#f0f3f6;border:1px solid #dde2e8;border-radius:5px;padding:0 5px;white-space:nowrap}
  .formula{background:var(--ink);color:#d4f5d4;border-radius:8px;padding:12px 16px;font-family:ui-monospace,Menlo,monospace;font-size:13px;margin:8px 0 14px;overflow-x:auto}
  .stages{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:6px 0 4px}
  .stage{border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .stage .sh{color:#fff;font-size:13px;font-weight:800;padding:9px 12px}
  .stage.ex .sh{background:#0095a8}.stage.mp .sh{background:#531dab}.stage.op .sh{background:#237804}
  .stage .sb{padding:11px 13px;font-size:11.5px;color:var(--grey)}
  .stage .sb b{color:var(--ink)}
  .flow{display:flex;align-items:stretch;gap:0;margin:10px 0 16px;flex-wrap:wrap}
  .flow .step{flex:1 1 0;min-width:120px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;position:relative;background:#fbfdfe}
  .flow .step .rank{font-size:10px;font-weight:800;color:var(--mut);letter-spacing:.5px}
  .flow .step .nm{font-size:13px;font-weight:800;color:var(--ink);margin:2px 0 3px}
  .flow .step .ds{font-size:11px;color:var(--grey)}
  .flow .arr{align-self:center;color:var(--mut);font-size:18px;padding:0 6px;font-weight:800}
  .bands{display:flex;gap:8px;margin:6px 0 14px;flex-wrap:wrap}
  .band{border-radius:20px;padding:4px 12px;font-size:11.5px;font-weight:700}
  .band.g{background:#f6ffed;color:var(--ok);border:1px solid #b7eb8f}
  .band.w{background:#fffbe6;color:var(--warn);border:1px solid #ffe58f}
  .band.f{background:#fff1f0;color:var(--fail);border:1px solid #ffccc7}
  .note{border:1px solid #ffe08a;background:#fffbe6;border-radius:12px;padding:13px 16px;font-size:12.5px;color:#6a5200;margin:12px 0}
  .note b{color:#8a6d00}
  .tip{border:1px solid #b7eb8f;background:#f6ffed;border-radius:12px;padding:13px 16px;font-size:12.5px;color:#2b5a10;margin:12px 0}
  .tip b{color:#237804}
  table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:12px}
  th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
  th{background:#fbfdfe;color:var(--teal-d);font-weight:700}
  dl{margin:0 0 12px}
  dt{font-size:12.5px;font-weight:800;color:var(--ink);margin-top:8px}
  dd{font-size:12.5px;color:var(--grey);margin:2px 0 0 16px}
  .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:10px 0 18px}
  .stat{border:1px solid var(--line);border-radius:12px;padding:14px 16px;text-align:center;background:linear-gradient(180deg,#fbfdfe,#fff)}
  .stat .n{font-size:30px;font-weight:800;color:var(--teal-d);line-height:1}
  .stat .l{font-size:11px;color:var(--grey);margin-top:6px;font-weight:600}
  .stat .s{font-size:10px;color:var(--mut);margin-top:2px}
  .rn li{font-size:12px}
  footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:#9aa2ad}
  @media print{body{background:#fff;padding:0}.page{border:0;box-shadow:none}h2,.stages,.note,.tip,table,.flow,.stat-grid{break-inside:avoid}.tools,.totop,.toast{display:none!important}}
  @media(max-width:720px){.stages,.stat-grid{grid-template-columns:1fr 1fr}.flow{flex-direction:column}.flow .arr{transform:rotate(90deg)}}
`;function r(t){return`<script>
  (function () {
    // Download / Print need script, so they stay hidden until this runs.
    var tools = document.getElementById('tools');
    if (tools) tools.style.display = 'flex';
    var dl = document.getElementById('dl');
    if (dl) dl.addEventListener('click', function () {
      // Serialize the live document: styles are inline and there are no external
      // assets, so the saved file is the whole document, offline and shareable.
      var html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
      var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = ${JSON.stringify(t)};
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url) }, 10000);
    });
    var pr = document.getElementById('pr');
    if (pr) pr.addEventListener('click', function () { window.print() });

    var toast = document.getElementById('toast');
    function say(msg) {
      if (!toast) return;
      toast.textContent = msg;
      toast.style.display = 'block';
      setTimeout(function () { toast.style.display = 'none' }, 4500);
    }
    var inApp = location.protocol === 'blob:';

    // In-page links scroll instead of navigating: a hash click on a blob: page can
    // be treated as a navigation by some browsers, and then the contents do nothing.
    document.addEventListener('click', function (e) {
      var t = e.target;
      var a = t && t.closest ? t.closest('a') : null;
      if (!a) return;
      var other = a.getAttribute('data-pg-doc');
      if (other) {
        if (!inApp) return; // a saved or generated copy: the href is the sibling file
        e.preventDefault();
        var opener = null;
        try { opener = window.opener && !window.opener.closed ? window.opener : null } catch (err) { opener = null }
        if (opener) {
          try {
            opener.postMessage({ type: ${JSON.stringify(e)}, doc: other, hash: a.getAttribute('data-pg-hash') || '' }, location.origin);
            return;
          } catch (err) { /* fall through to the hint */ }
        }
        say('Open it from Pack Generator: left rail → Documentation.');
        return;
      }
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;
      var id = href.slice(1);
      var el = id ? document.getElementById(decodeURIComponent(id)) : null;
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Opened at a section (the other document linked here): go there.
    if (location.hash.length > 1) {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) setTimeout(function () { target.scrollIntoView({ block: 'start' }) }, 0);
    }
  })();
<\/script>`}function i(e,n,r=``){return`<a href="${t[e]+(r?`#${r}`:``)}" data-pg-doc="${e}"${r?` data-pg-hash="#${r}"`:``}>${n}</a>`}export{i as n,r,n as t};