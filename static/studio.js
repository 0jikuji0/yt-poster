/* clipstudio — interactions de l'interface « Studio ».
   - shell : menu, sélecteur de chaîne, modale « Créer », onglets ;
   - graphiques : courbes SVG (vues / abonnés) rendues depuis [data-chart]. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---------------------------------------------------------------- shell
  var burger = $("#burger");
  if (burger) burger.addEventListener("click", function () {
    if (window.innerWidth <= 1000) document.body.classList.toggle("sb-open");
    else document.body.classList.toggle("sb-collapsed");
  });

  var sw = $("#chSwitch"), picker = $("#chPicker");
  if (sw && picker) {
    sw.addEventListener("click", function (e) { e.stopPropagation(); picker.classList.toggle("open"); });
    document.addEventListener("click", function (e) {
      if (!picker.contains(e.target)) picker.classList.remove("open");
    });
  }

  var modal = $("#createModal");
  function openModal() { if (modal) modal.classList.add("open"); }
  function closeModal() { if (modal) modal.classList.remove("open"); }
  var btnCreate = $("#btnCreate");
  if (btnCreate) btnCreate.addEventListener("click", openModal);
  // Lien direct « ?create=1 » : ouvre la fenêtre d'ajout au chargement.
  if (/[?&]create=1/.test(location.search)) openModal();
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-open-create]")) { e.preventDefault(); openModal(); }
    if (e.target.closest("[data-close]") || e.target === modal) closeModal();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  // Nom des fichiers choisis dans un champ « fichier ».
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute("data-files") && t.files) {
      var out = document.getElementById(t.getAttribute("data-files"));
      if (out) out.textContent = t.files.length
        ? t.files.length + " fichier(s) sélectionné(s)"
        : "＋ Sélectionner des fichiers vidéo (+ .json)";
    }
    if (t.hasAttribute && t.hasAttribute("data-autosubmit") && t.files && t.files.length) t.form.submit();
    if (t.hasAttribute && t.hasAttribute("data-submit")) t.form.submit();
  });

  // Confirmations (suppression de vidéo, de chaîne…).
  document.addEventListener("submit", function (e) {
    var msg = e.target.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Toasts : effacement doux.
  var fl = $("#flash");
  if (fl && fl.children.length) setTimeout(function () {
    fl.style.transition = "opacity .4s"; fl.style.opacity = "0";
  }, 4500);

  // Sélection multiple dans les tableaux de contenus.
  var all = $("#checkAll");
  if (all) all.addEventListener("change", function () {
    $$(".rowcheck").forEach(function (c) { c.checked = all.checked; });
    updateBulk();
  });
  document.addEventListener("change", function (e) {
    if (e.target.classList && e.target.classList.contains("rowcheck")) updateBulk();
  });
  function updateBulk() {
    var n = $$(".rowcheck:checked").length, bar = $("#bulkBar");
    if (bar) { bar.style.display = n ? "flex" : "none"; var c = $("#bulkCount"); if (c) c.textContent = n; }
  }

  // ------------------------------------------------------------ graphiques
  var COL = { views: "#62b8f6", subs: "#ffd166" };
  var MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  function grp(v) { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function frDate(iso) {
    var p = String(iso).split("-");
    if (p.length !== 3) return iso;
    return parseInt(p[2], 10) + " " + MOIS[parseInt(p[1], 10) - 1] + " " + p[0];
  }
  function niceCeil(v) {
    if (v <= 0) return 10;
    var pow = Math.pow(10, Math.floor(Math.log10(v))), r = v / pow, m;
    if (r <= 1) m = 1; else if (r <= 2) m = 2; else if (r <= 5) m = 5; else m = 10;
    return m * pow;
  }

  function renderChart(el) {
    var data;
    try { data = JSON.parse(el.getAttribute("data-chart") || "[]"); } catch (e) { data = []; }
    var key = el.getAttribute("data-key") || "views";
    var range = el.getAttribute("data-range") || "28";
    var cum = el.getAttribute("data-mode") === "cum";
    if (range !== "all") data = data.slice(-parseInt(range, 10));
    if (cum) {
      var acc = 0;
      data = data.map(function (d) { acc += d[key]; var o = {}; o.date = d.date; o[key] = acc; return o; });
    }
    if (!data.length) { el.innerHTML = '<div class="tiny muted" style="padding:20px 0;">Aucune donnée sur cette période.</div>'; return; }

    var w = el.clientWidth || 640, h = el.clientHeight || 200;
    var padL = 0, padR = 52, padT = 12, padB = 26;
    var iw = Math.max(10, w - padL - padR), ih = Math.max(10, h - padT - padB);
    var vals = data.map(function (d) { return d[key]; });
    var max = niceCeil(Math.max.apply(null, vals) || 1);
    var min = Math.min.apply(null, vals);
    var lo = min < 0 ? -niceCeil(-min) : 0;
    var span = (max - lo) || 1;
    var n = data.length;
    var x = function (i) { return padL + (n === 1 ? iw / 2 : iw * i / (n - 1)); };
    var y = function (v) { return padT + ih - ih * (v - lo) / span; };

    var line = data.map(function (d, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(d[key]).toFixed(1); }).join(" ");
    var area = line + " L" + x(n - 1).toFixed(1) + " " + y(lo).toFixed(1) + " L" + x(0).toFixed(1) + " " + y(lo).toFixed(1) + " Z";
    var col = COL[key] || COL.views;
    var uid = "g" + Math.random().toString(36).slice(2, 8);

    // grille horizontale + libellés à droite
    var grid = "", steps = 4;
    for (var s = 0; s <= steps; s++) {
      var v = lo + span * s / steps, gy = y(v);
      grid += '<line x1="0" x2="' + (padL + iw) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '" stroke="#2a2a2a" stroke-width="1"/>'
           + '<text x="' + (padL + iw + 8) + '" y="' + (gy + 4).toFixed(1) + '" fill="#aaa" font-size="11">' + grp(v) + "</text>";
    }
    // libellés de dates (début / milieu / fin)
    var xt = "";
    [0, Math.floor((n - 1) / 2), n - 1].filter(function (v, i, arr) { return arr.indexOf(v) === i; }).forEach(function (i) {
      var d = data[i].date.split("-");
      var anchor = i === 0 ? "start" : (i === n - 1 ? "end" : "middle");
      xt += '<text x="' + x(i).toFixed(1) + '" y="' + (h - 6) + '" fill="#aaa" font-size="11" text-anchor="' + anchor + '">'
          + (parseInt(d[2], 10) + " " + MOIS[parseInt(d[1], 10) - 1]) + "</text>";
    });

    var hits = data.map(function (d, i) {
      return '<rect x="' + (x(i) - iw / (2 * Math.max(1, n - 1))).toFixed(1) + '" y="0" width="'
        + Math.max(2, iw / Math.max(1, n - 1)).toFixed(1) + '" height="' + h + '" fill="transparent" data-i="' + i + '"/>';
    }).join("");

    el.innerHTML = '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" style="overflow:visible;display:block;">'
      + '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="' + col + '" stop-opacity=".28"/>'
      + '<stop offset="100%" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>'
      + grid + xt
      + '<path d="' + area + '" fill="url(#' + uid + ')"/>'
      + '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
      + '<line class="cross" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" stroke="#666" stroke-width="1" style="display:none"/>'
      + '<circle class="hl" r="4" fill="' + col + '" stroke="#0f0f0f" stroke-width="2" style="display:none"/>'
      + hits + "</svg>";

    el._pts = data.map(function (d, i) { return { cx: x(i), cy: y(d[key]), v: d[key], date: d.date }; });
    el._col = col;
    el._unit = key === "subs" ? "abonnés" : "vues";
  }

  var tip = document.createElement("div");
  tip.style.cssText = "position:fixed;z-index:80;pointer-events:none;display:none;background:#282828;border:1px solid #3f3f3f;" +
    "border-radius:8px;padding:8px 12px;box-shadow:0 6px 24px rgba(0,0,0,.6);font-size:12px;color:#f1f1f1;white-space:nowrap;";
  document.body.appendChild(tip);

  document.addEventListener("mousemove", function (e) {
    var host = e.target.closest ? e.target.closest("[data-chart]") : null;
    var hit = e.target.tagName === "rect" && e.target.hasAttribute("data-i") ? e.target : null;
    if (!host || !hit || !host._pts) { hideTip(); return; }
    var p = host._pts[+hit.getAttribute("data-i")];
    if (!p) { hideTip(); return; }
    var cross = host.querySelector(".cross"), hl = host.querySelector(".hl");
    if (cross) { cross.setAttribute("x1", p.cx); cross.setAttribute("x2", p.cx); cross.style.display = ""; }
    if (hl) { hl.setAttribute("cx", p.cx); hl.setAttribute("cy", p.cy); hl.style.display = ""; }
    tip.innerHTML = '<div style="color:#aaa;margin-bottom:3px;">' + frDate(p.date) + "</div>"
      + '<div><b style="color:' + host._col + ';">' + grp(p.v) + "</b> " + host._unit + "</div>";
    tip.style.display = "block";
    var lx = e.clientX + 14, ly = e.clientY + 14;
    if (lx + tip.offsetWidth > window.innerWidth - 8) lx = e.clientX - tip.offsetWidth - 14;
    if (ly + tip.offsetHeight > window.innerHeight - 8) ly = e.clientY - tip.offsetHeight - 14;
    tip.style.left = lx + "px"; tip.style.top = ly + "px";
  });
  function hideTip() {
    if (tip.style.display === "none") return;
    tip.style.display = "none";
    $$("[data-chart]").forEach(function (el) {
      var c = el.querySelector(".cross"), hl = el.querySelector(".hl");
      if (c) c.style.display = "none";
      if (hl) hl.style.display = "none";
    });
  }

  function renderAll() { $$("[data-chart]").forEach(renderChart); }
  renderAll();
  var rt;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(renderAll, 150); });

  // Sélecteurs de période / mode au-dessus des graphiques.
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-set-range], [data-set-mode]");
    if (!b) return;
    var group = b.closest("[data-charts]");
    var targets = group ? $$("[data-chart]", group.parentNode) : $$("[data-chart]");
    var attr = b.hasAttribute("data-set-range") ? "data-range" : "data-mode";
    var val = b.getAttribute(attr === "data-range" ? "data-set-range" : "data-set-mode");
    targets.forEach(function (el) { el.setAttribute(attr, val); renderChart(el); });
    $$("[" + (attr === "data-range" ? "data-set-range" : "data-set-mode") + "]", b.parentNode)
      .forEach(function (o) { o.classList.toggle("on", o === b); });
    var lbl = group && group.getAttribute("data-charts") ? document.getElementById(group.getAttribute("data-charts")) : null;
    if (lbl && attr === "data-range") lbl.textContent = b.textContent.trim();
  });
})();
