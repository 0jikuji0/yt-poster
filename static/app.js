/* clipstudio — SPA front.
   - État client : view ('global'|id), range (7|28|60|'all'), mode ('day'|'cum').
   - Données stats : par jour via YouTube Analytics (champ `daily`) + totaux courants
     (`totals`). Graphes/navigation/sélecteurs = 100% client.
   - Actions persistantes (réglages, dépôt, OAuth, renommage, sync) = <form> vers Flask. */
(function () {
  "use strict";
  var DATA = window.__DATA__ || { channels: [], hasSecrets: false, initialView: "global" };
  var channels = DATA.channels;
  var COL = { chart: "#ff4d8d", subs: "#29d4c5", pos: "#2ecf76", neg2: "#ff5c61" };
  var CHARTS = {}, chartSeq = 0;   // registre des courbes pour l'info-bulle au survol

  var view = DATA.initialView || "global";
  var range = 28;
  var mode = "day"; // 'day' (par jour) | 'cum' (cumulé)

  // ---- helpers ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function enc(s) { return encodeURIComponent(s); }
  function curIdx() {
    if (view === "global") return 0;
    var i = channels.findIndex(function (c) { return c.id === view; });
    return i < 0 ? 0 : i;
  }
  function isGlobal() { return view === "global"; }
  function round(n) { return Math.round(n * 10) / 10; }
  function shortD(d) { var p = String(d).split("-"); return p.length === 3 ? p[2] + "/" + p[1] : d; }
  function niceCeil(v) {
    if (v <= 0) return 10;
    var pow = Math.pow(10, Math.floor(Math.log10(v))), r = v / pow, m;
    if (r <= 1) m = 1; else if (r <= 2) m = 2; else if (r <= 5) m = 5; else m = 10;
    return m * pow;
  }
  function sortedChannels() {
    // Tri : chaînes connectées d'abord, puis celles dont le planificateur est actif,
    // l'ordre d'insertion départageant les ex æquo (tri stable).
    function score(c) { return (c.connected ? 2 : 0) + (c.settings.active ? 1 : 0); }
    return channels.slice().sort(function (a, b) { return score(b) - score(a); });
  }
  var PRIV = [["public", "Publique"], ["unlisted", "Non répertoriée"], ["private", "Privée"]];

  // ---- séries de données ----
  function filterRange(arr) {
    if (range === "all" || arr.length === 0) return arr;
    var maxD = arr[arr.length - 1].date;
    var p = maxD.split("-").map(Number);
    var ref = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    ref.setUTCDate(ref.getUTCDate() - range);
    var startIso = ref.toISOString().slice(0, 10);
    return arr.filter(function (r) { return r.date >= startIso; });
  }
  // Cumul ancré sur les totaux courants (pour finir sur le vrai total de la chaîne)
  function cumulative(daily, totals) {
    var sv = 0, ss = 0;
    daily.forEach(function (d) { sv += d.views; ss += d.subs; });
    var bv = totals ? Math.max(0, totals.views - sv) : 0;
    var bs = totals ? Math.max(0, totals.subs - ss) : 0;
    var cv = bv, cs = bs, out = [];
    daily.forEach(function (d) { cv += d.views; cs += d.subs; out.push({ date: d.date, views: cv, subs: cs }); });
    return out;
  }
  function globalDaily() {
    var map = {};
    channels.forEach(function (c) {
      (c.daily || []).forEach(function (d) {
        if (!map[d.date]) map[d.date] = { views: 0, subs: 0 };
        map[d.date].views += d.views; map[d.date].subs += d.subs;
      });
    });
    return Object.keys(map).sort().map(function (dt) { return { date: dt, views: map[dt].views, subs: map[dt].subs }; });
  }
  function globalTotals() {
    var v = 0, s = 0, vid = 0, any = false;
    channels.forEach(function (c) { if (c.totals) { v += c.totals.views; s += c.totals.subs; vid += c.totals.videos || 0; any = true; } });
    return any ? { views: v, subs: s, videos: vid } : null;
  }
  // Moyennes : vues par short (vues totales / nb vidéos) et vues par jour (sur la période)
  function avgPerShort(totals) { return totals && totals.videos ? Math.round(totals.views / totals.videos) : null; }
  function avgPerDay(daily) { var f = filterRange(daily); return f.length ? Math.round(f.reduce(function (a, b) { return a + b.views; }, 0) / f.length) : null; }
  function avgLine(totals, daily) {
    return '<div style="font-family:\'IBM Plex Mono\';font-size:12px;color:#8a8a8a;margin:14px 0 0;">' +
      'Moyenne : <b style="color:#ededed;">' + num(avgPerShort(totals)) + '</b> vues / short · ' +
      '<b style="color:#ededed;">' + num(avgPerDay(daily)) + '</b> vues / jour (' + rangeLabel() + ')</div>';
  }
  function seriesChannel(c) { var d = c.daily || []; return mode === "cum" ? cumulative(d, c.totals) : d.slice(); }
  function seriesGlobal() { var d = globalDaily(); return mode === "cum" ? cumulative(d, globalTotals()) : d; }
  function sumRange(daily, key) { return filterRange(daily).reduce(function (a, b) { return a + b[key]; }, 0); }
  // Série globale = somme des chaînes, en gardant le détail par chaîne (pour l'info-bulle).
  function globalSeriesParts() {
    var map = {};
    channels.forEach(function (c) {
      var title = (c.ytTitle && c.ytTitle !== "—") ? c.ytTitle : c.id;
      seriesChannel(c).forEach(function (d) {
        if (!map[d.date]) map[d.date] = { date: d.date, views: 0, subs: 0, parts: [] };
        map[d.date].views += d.views; map[d.date].subs += d.subs;
        map[d.date].parts.push({ title: title, views: d.views, subs: d.subs });
      });
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }
  // Format « 1 234 » (espace fine insécable comme séparateur de milliers).
  function grp(v) { return v == null ? "—" : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function frDate(d) {
    var M = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
    var p = String(d).split("-");
    return p.length === 3 ? parseInt(p[2], 10) + " " + (M[parseInt(p[1], 10) - 1] || "") + " " + p[0] : d;
  }
  // Contenu HTML d'une info-bulle de point (jour + valeur exacte + détail par chaîne si dispo).
  function tipHTML(p, key, unit) {
    var head = '<div style="color:#9a9a9a;font-size:10px;letter-spacing:.05em;margin-bottom:3px;">' + frDate(p.date) + "</div>";
    var main = '<div style="color:#ededed;font-size:14px;font-weight:600;">' + grp(p.val) + " " + unit + "</div>";
    var extra = "";
    if (p.parts && p.parts.length) {
      var rows = p.parts.filter(function (x) { return x[key] > 0; })
        .sort(function (a, b) { return b[key] - a[key]; })
        .map(function (x) {
          return '<div style="display:flex;justify-content:space-between;gap:14px;color:#c8c8c8;font-size:11px;margin-top:3px;">' +
            '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;">' + esc(x.title) + "</span>" +
            '<span style="color:#ededed;">' + grp(x[key]) + "</span></div>";
        }).join("");
      if (rows) extra = '<div style="margin-top:7px;padding-top:6px;border-top:1px solid #333;">' + rows + "</div>";
    }
    return head + main + extra;
  }

  function computeChart(series, key) {
    var n = series.length;
    if (n < 2) return { ready: false };
    var padL = 46, padR = 18, padT = 16, padB = 28, W = 760, H = 220;
    var innerW = W - padL - padR, innerH = H - padT - padB, baseY = padT + innerH;
    var vals = series.map(function (s) { return s[key]; });
    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    // En mode « par jour » l'axe démarre à 0 ; en cumulé on reste à 0 aussi (valeurs croissantes).
    var lo = 0, niceMax = niceCeil(Math.max(maxV, 1));
    var X = function (i) { return round(padL + innerW * (i / (n - 1))); };
    var Y = function (v) { return round(padT + innerH * (1 - (v - lo) / (niceMax - lo))); };
    var showVals = n <= 8, rad = n <= 8 ? 4.5 : 3;
    var pts = series.map(function (s, i) {
      return { cx: X(i), cy: Y(s[key]), ty: Y(s[key]) - 11, r: rad, label: showVals ? String(s[key]) : "",
        date: s.date, val: s[key], parts: s.parts || null };
    });
    var line = pts.map(function (p) { return p.cx + "," + p.cy; }).join(" ");
    var area = "M " + pts[0].cx + "," + baseY + " " + pts.map(function (p) { return "L " + p.cx + "," + p.cy; }).join(" ") + " L " + pts[n - 1].cx + "," + baseY + " Z";
    var ticks = [1, 0.5, 0].map(function (f) { var y = round(padT + innerH * (1 - f)); return { y: y, ty: y + 4, label: Math.round(lo + (niceMax - lo) * f) }; });
    var stepIdx = Math.max(1, Math.ceil(n / 6)), labels = [];
    series.forEach(function (s, i) { if (i % stepIdx === 0 || i === n - 1) labels.push({ x: X(i), label: shortD(s.date) }); });
    return { ready: true, line: line, area: area, pts: pts, ticks: ticks, labels: labels,
      top: padT, bottom: baseY, band: n > 1 ? innerW / (n - 1) : innerW };
  }

  function chartSVG(cd, color, opts) {
    if (!cd.ready) {
      return '<div style="border:1px dashed #333333;border-radius:10px;height:160px;display:flex;align-items:center;justify-content:center;text-align:center;color:#777777;font-size:13px;background:repeating-linear-gradient(45deg,#161616,#161616 10px,#1a1a1a 10px,#1a1a1a 20px);">Pas assez de données sur cette période.</div>';
    }
    opts = opts || {};
    var key = opts.key || "views", unit = opts.unit || "";
    var fill = color + "2e";
    var ticks = cd.ticks.map(function (t) {
      return '<g><line x1="46" y1="' + t.y + '" x2="742" y2="' + t.y + '" stroke="#2a2a2a" stroke-width="1"></line><text x="38" y="' + t.ty + '" text-anchor="end" font-size="11" fill="#777777">' + t.label + "</text></g>";
    }).join("");
    var pts = cd.pts.map(function (p) {
      return '<g><circle cx="' + p.cx + '" cy="' + p.cy + '" r="' + p.r + '" fill="#1a1a1a" stroke="' + color + '" stroke-width="2.5"></circle>' +
        (p.label ? '<text x="' + p.cx + '" y="' + p.ty + '" text-anchor="middle" font-size="11" font-weight="600" fill="#cfcfcf">' + p.label + "</text>" : "") + "</g>";
    }).join("");
    var labels = cd.labels.map(function (l) {
      return '<text x="' + l.x + '" y="212" text-anchor="middle" font-size="11" fill="#8a8a8a">' + l.label + "</text>";
    }).join("");
    // Couche interactive : trait vertical + point surligné + zones de survol invisibles.
    var id = "ch" + (++chartSeq), reg = { x: id + "-x", h: id + "-h", pts: [] };
    var hot = cd.pts.map(function (p, i) {
      reg.pts.push({ cx: p.cx, cy: p.cy, tip: tipHTML(p, key, unit) });
      var w = cd.band, x = round(p.cx - w / 2);
      return '<rect data-tip="' + id + '" data-i="' + i + '" x="' + x + '" y="' + cd.top + '" width="' + round(w) +
        '" height="' + round(cd.bottom - cd.top) + '" fill="transparent" pointer-events="all" style="cursor:crosshair;"></rect>';
    }).join("");
    CHARTS[id] = reg;
    var cross = '<line id="' + id + '-x" x1="0" y1="' + cd.top + '" x2="0" y2="' + cd.bottom + '" stroke="#5a5a5a" stroke-width="1" stroke-dasharray="3 3" pointer-events="none" style="display:none;"></line>';
    var hl = '<circle id="' + id + '-h" r="5" fill="' + color + '" stroke="#fff" stroke-width="2" pointer-events="none" style="display:none;"></circle>';
    return '<svg viewBox="0 0 760 220" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;font-family:\'IBM Plex Mono\';animation:dpop .35s ease;">' +
      ticks + '<path d="' + cd.area + '" fill="' + fill + '" stroke="none"></path>' +
      '<polyline points="' + cd.line + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
      pts + labels + cross + hl + hot + "</svg>";
  }

  // styles partagés
  var S = {
    panel: "background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:22px 24px;box-shadow:0 1px 2px rgba(0,0,0,0.3);",
    kpi: "border:1px solid #2c2c2c;background:#202020;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:7px;",
    kpiLabel: "font-family:'IBM Plex Mono';font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;",
    kpiNum: "font-family:'IBM Plex Mono';font-size:27px;font-weight:600;line-height:1;",
    h2: "margin:0;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#f5f5f5;",
    field: "font-family:'IBM Plex Mono';font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;",
    input: "border:1px solid #3a3a3a;background:#1c1c1c;border-radius:8px;padding:9px 11px;font-size:13px;font-family:'IBM Plex Mono';color:#ededed;outline:none;color-scheme:dark;",
    inputSans: "border:1px solid #3a3a3a;background:#1c1c1c;border-radius:8px;padding:9px 11px;font-size:13px;color:#ededed;outline:none;",
    cta: "border:1px solid #ff4d8d;background:#ff4d8d;color:#111111;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;",
    ghost: "border:1px solid #3a3a3a;background:#1c1c1c;color:#ededed;padding:9px 15px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;",
    seg: "display:inline-flex;background:#1c1c1c;border:1px solid #3a3a3a;border-radius:9px;padding:3px;gap:3px;flex:none;",
  };
  function gainLabel(g) { return g == null ? "—" : (g >= 0 ? "+" + g : String(g)); }
  function gainColor(g) { return g == null ? "#8a8a8a" : (g >= 0 ? COL.pos : COL.neg2); }
  function num(v) { return v == null ? "—" : String(v); }

  function kpi(label, val, color) {
    return '<div style="' + S.kpi + '"><span style="' + S.kpiLabel + '">' + label + '</span><span style="' + S.kpiNum + "color:" + color + ';">' + esc(val) + "</span></div>";
  }
  function segmented(attr, defs) {
    return '<div style="' + S.seg + '">' + defs.map(function (o) {
      var on = o[2];
      return '<button data-' + attr + '="' + o[1] + '" style="border:none;cursor:pointer;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:500;font-family:\'IBM Plex Mono\';background:' +
        (on ? "#ff4d8d" : "transparent") + ";color:" + (on ? "#111111" : "#cfcfcf") + ';">' + o[0] + "</button>";
    }).join("") + "</div>";
  }
  function rangeSelector() {
    return segmented("range", [["7 j", 7, range === 7], ["28 j", 28, range === 28], ["2 mois", 60, range === 60], ["Tout", "all", range === "all"]]);
  }
  function modeSelector() {
    return segmented("mode", [["Par jour", "day", mode === "day"], ["Cumulé", "cum", mode === "cum"]]);
  }
  function selectors() {
    return '<div style="display:flex;gap:8px;flex:none;flex-wrap:wrap;">' + modeSelector() + rangeSelector() + "</div>";
  }
  function rangeLabel() {
    var m = { 7: "7 j", 28: "28 j", 60: "2 mois" };
    return range === "all" ? "tout" : (m[range] || (range + " j"));
  }
  function chartTitle(color, txt) {
    var suffix = mode === "cum" ? " (cumulé)" : " (par jour)";
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;"><span style="width:10px;height:3px;border-radius:2px;background:' + color + ';"></span><h3 style="margin:0;font-size:13px;font-weight:600;color:#ededed;">' + txt + suffix + "</h3></div>";
  }

  // ---- page : vue d'ensemble ----
  function globalPage() {
    var gt = globalTotals();
    var series = filterRange(globalSeriesParts());
    var gd = globalDaily();
    var cV = computeChart(series, "views"), cS = computeChart(series, "subs");
    var vg = sumRange(gd, "views"), sg = sumRange(gd, "subs");

    var cards = sortedChannels().map(function (c) {
      var csg = sumRange(c.daily || [], "subs");
      return '<button data-navch="' + esc(c.id) + '" class="hov-card" style="min-width:0;text-align:left;cursor:pointer;border:1px solid #2c2c2c;background:#202020;border-radius:10px;padding:14px 15px;display:flex;flex-direction:column;gap:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
          '<span style="display:flex;align-items:center;gap:8px;min-width:0;"><span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + (c.connected ? COL.pos : "#8a8a8a") + ';"></span>' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.id) + "</span></span>" +
          '<span style="font-size:10px;font-family:\'IBM Plex Mono\';color:' + (c.settings.active ? COL.pos : "#777777") + ';white-space:nowrap;">' + (c.settings.active ? "auto actif" : "en pause") + "</span></div>" +
        '<div style="display:flex;gap:18px;">' +
          '<div style="display:flex;flex-direction:column;gap:3px;"><span style="font-family:\'IBM Plex Mono\';font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#777;">vues</span><span style="font-family:\'IBM Plex Mono\';font-size:21px;font-weight:600;line-height:1;color:' + COL.chart + ';">' + num(c.totals ? c.totals.views : null) + "</span></div>" +
          '<div style="display:flex;flex-direction:column;gap:3px;"><span style="font-family:\'IBM Plex Mono\';font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#777;">abonnés</span><span style="font-family:\'IBM Plex Mono\';font-size:21px;font-weight:600;line-height:1;color:' + COL.subs + ';">' + num(c.totals ? c.totals.subs : null) + "</span></div></div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;font-family:\'IBM Plex Mono\';font-size:11px;color:#8a8a8a;border-top:1px solid #2a2a2a;padding-top:10px;">' +
          '<span style="color:' + gainColor(csg) + ';">' + gainLabel(csg) + " ab. · " + rangeLabel() + "</span>" +
          "<span>" + (c.settings.active ? c.slots.length + " créneaux/j" : "— créneau") + "</span></div></button>";
    }).join("");

    return '<div style="animation:dpop .3s ease;">' +
      '<header style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap;">' +
        '<div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<h1 style="margin:0;font-size:27px;font-weight:700;letter-spacing:-0.015em;color:#f5f5f5;white-space:nowrap;">Vue d\'ensemble</h1>' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:11px;color:#ff4d8d;background:rgba(255,77,141,0.1);border:1px solid rgba(255,77,141,0.3);padding:4px 10px;border-radius:999px;">cumul · ' + channels.length + " chaînes</span></div>" +
          '<div style="font-family:\'IBM Plex Mono\';font-size:12px;color:#8a8a8a;margin-top:8px;">Toutes chaînes confondues — saison 2026</div></div>' +
        selectors() + "</header>" +
      '<section style="' + S.panel + 'margin-bottom:18px;">' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">' +
          kpi("Vues totales", num(gt ? gt.views : null), COL.chart) +
          kpi("Abonnés", num(gt ? gt.subs : null), COL.subs) +
          kpi("Vues gagnées · " + rangeLabel(), gainLabel(vg), gainColor(vg)) +
          kpi("Abonnés gagnés · " + rangeLabel(), gainLabel(sg), gainColor(sg)) + "</div>" +
        avgLine(gt, gd) +
        '<div style="margin-top:22px;padding-top:20px;border-top:1px solid #262626;">' +
          chartTitle(COL.chart, "Vues") + chartSVG(cV, COL.chart, { key: "views", unit: "vues" }) +
          '<div style="margin:22px 0 0;">' + chartTitle(COL.subs, "Abonnés") + chartSVG(cS, COL.subs, { key: "subs", unit: "abonnés" }) + "</div></div></section>" +
      '<section style="' + S.panel + '">' +
        '<h2 style="' + S.h2 + '">Détail par chaîne</h2>' +
        '<p style="margin:4px 0 16px;color:#8a8a8a;font-size:13px;">Clique une chaîne pour ouvrir sa page de stats.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(' + Math.max(1, channels.length) + ',1fr);gap:12px;">' + cards + "</div></section></div>";
  }

  // panneau « meilleures heures de publication »
  function bestHoursPanel(c) {
    var hrs = c.hours, inner;
    if (hrs == null) {
      inner = '<div style="color:#777;font-size:13px;">Reconnecte la chaîne pour analyser les heures.</div>';
    } else if (!hrs.length) {
      inner = '<div style="color:#777;font-size:13px;">Pas encore assez de vidéos postées (avec vues) pour analyser. Publie à plusieurs heures différentes, puis reviens ici.</div>';
    } else {
      var max = Math.max.apply(null, hrs.map(function (h) { return h.avgPerDay; })) || 1;
      var best = hrs.reduce(function (a, b) { return b.avgPerDay > a.avgPerDay ? b : a; });
      var hh = function (h) { return (h < 10 ? "0" + h : "" + h) + "h"; };
      var rows = hrs.slice().sort(function (a, b) { return b.avgPerDay - a.avgPerDay; }).map(function (h) {
        var w = Math.max(2, Math.round(100 * h.avgPerDay / max));
        var isBest = h.hour === best.hour;
        return '<div style="display:grid;grid-template-columns:42px 1fr auto;align-items:center;gap:12px;margin:8px 0;font-family:\'IBM Plex Mono\';font-size:12px;">' +
          '<span style="color:' + (isBest ? "#fff" : "#cfcfcf") + ';">' + hh(h.hour) + "</span>" +
          '<span style="height:12px;background:#202020;border-radius:6px;overflow:hidden;display:block;"><span style="display:block;height:100%;width:' + w + '%;background:' + (isBest ? COL.chart : "rgba(255,77,141,0.32)") + ';border-radius:6px;"></span></span>' +
          '<span style="color:#8a8a8a;white-space:nowrap;"><b style="color:#ededed;">' + h.avgPerDay + "</b> v/j · " + h.count + " vid.</span></div>";
      }).join("");
      inner = '<p style="margin:0 0 14px;color:#ededed;font-size:13px;">Meilleure heure : <b style="color:' + COL.chart + ';">' + hh(best.hour) + "</b> — " + best.avgPerDay + " vues/jour en moyenne (" + best.count + " vidéo" + (best.count > 1 ? "s" : "") + ").</p>" + rows;
    }
    return '<section style="' + S.panel + 'margin-bottom:18px;">' +
      '<h2 style="' + S.h2 + '">Meilleures heures de publication</h2>' +
      '<p style="margin:6px 0 16px;color:#8a8a8a;font-size:13px;">Vues / jour moyennes selon l\'heure de mise en ligne (corrigé de l\'âge des vidéos).</p>' +
      inner + "</section>";
  }

  // ---- page : chaîne ----
  function channelPage() {
    var c = channels[curIdx()];
    var daily = c.daily || [];
    var series = filterRange(seriesChannel(c));
    var cV = computeChart(series, "views"), cS = computeChart(series, "subs");
    var vg = sumRange(daily, "views"), sg = sumRange(daily, "subs");
    var aPath = "/channel/" + enc(c.id);

    // tableau : jours de la période, plus récents en haut
    var inRange = filterRange(daily);
    var rowsArr = inRange.map(function (r, i) {
      var prev = i > 0 ? inRange[i - 1].views : null;
      var delta = prev == null ? null : r.views - prev;
      return { date: r.date, views: r.views, subs: r.subs, delta: delta };
    }).reverse();
    var rows = rowsArr.map(function (r) {
      return '<div style="display:grid;grid-template-columns:1.3fr 0.9fr 0.9fr 0.9fr;align-items:center;padding:11px 16px;border-top:1px solid #242424;font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;">' +
        "<span>" + esc(r.date) + "</span><span>" + r.views + '</span><span style="color:' + COL.subs + ';">' + (r.subs >= 0 ? "+" + r.subs : String(r.subs)) + "</span>" +
        '<span style="color:' + (r.delta == null ? "#8a8a8a" : (r.delta >= 0 ? COL.pos : COL.neg2)) + ';font-weight:500;">' + (r.delta == null ? "—" : (r.delta >= 0 ? "+" + r.delta : String(r.delta))) + "</span></div>";
    }).join("");
    if (inRange.length === 0) {
      rows = '<div style="padding:18px 16px;border-top:1px solid #242424;color:#777;font-size:13px;text-align:center;">' +
        (c.connected ? "Aucune donnée sur cette période. Clique « ↻ Synchroniser » (l'API Analytics a ~2-3 j de décalage)." : "Chaîne non connectée — clique « Reconnecter ».") + "</div>";
    }

    var statusOn = c.connected;
    var statusPill = '<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:' + (statusOn ? "#4fd98e" : "#ff8c8f") + ';background:' + (statusOn ? "rgba(46,207,118,0.12)" : "rgba(255,92,97,0.12)") + ';border:1px solid ' + (statusOn ? "rgba(46,207,118,0.3)" : "rgba(255,92,97,0.3)") + ';padding:4px 10px;border-radius:999px;">' +
      '<span style="width:7px;height:7px;border-radius:50%;background:' + (statusOn ? COL.pos : COL.neg2) + ';"></span>' + esc(c.status) + "</span>";

    var privSel = function (nm, sel) {
      return '<select name="' + nm + '" class="foc" style="' + S.input + 'cursor:pointer;">' +
        PRIV.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === sel ? " selected" : "") + ">" + p[1] + "</option>"; }).join("") + "</select>";
    };

    return '<div style="animation:dpop .3s ease;">' +
      '<header style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap;">' +
        '<div style="display:flex;flex-direction:column;gap:8px;"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<h1 style="margin:0;font-size:27px;font-weight:700;letter-spacing:-0.015em;color:#f5f5f5;">' + esc(c.id) + "</h1>" + statusPill + "</div>" +
          '<div style="font-family:\'IBM Plex Mono\';font-size:12px;color:#8a8a8a;">Titre YouTube : ' + esc(c.ytTitle) + "</div></div>" +
        '<div style="display:flex;gap:8px;flex:none;flex-wrap:wrap;">' +
          '<form method="post" action="' + aPath + '/sync"><button class="hov-ghost" style="' + S.ghost + '">↻ Synchroniser</button></form>' +
          '<button data-rename="' + esc(c.id) + '" class="hov-ghost" style="' + S.ghost + '">Renommer la chaîne</button>' +
          '<a href="' + aPath + '/connect" class="hov-cta" style="border:1px solid #ff4d8d;background:#ff4d8d;color:#111;padding:9px 15px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;">Reconnecter</a></div></header>' +
      '<section style="' + S.panel + 'margin-bottom:18px;">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
          '<div><h2 style="margin:0;font-size:16px;font-weight:700;letter-spacing:-0.01em;color:#f5f5f5;">Performance — 2026</h2>' +
          '<p style="margin:6px 0 0;color:#8a8a8a;font-size:13px;">Vues et abonnés par jour (YouTube Analytics, ~2-3 j de décalage).</p></div>' + selectors() + "</div>" +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 22px;">' +
          kpi("Vues totales", num(c.totals ? c.totals.views : null), COL.chart) +
          kpi("Abonnés", num(c.totals ? c.totals.subs : null), COL.subs) +
          kpi("Vues gagnées · " + rangeLabel(), gainLabel(vg), gainColor(vg)) +
          kpi("Abonnés gagnés · " + rangeLabel(), gainLabel(sg), gainColor(sg)) + "</div>" +
        avgLine(c.totals, daily) +
        '<div style="margin-top:22px;">' + chartTitle(COL.chart, "Vues") + chartSVG(cV, COL.chart, { key: "views", unit: "vues" }) + "</div>" +
        '<div style="margin:22px 0 0;">' + chartTitle(COL.subs, "Abonnés") + chartSVG(cS, COL.subs, { key: "subs", unit: "abonnés" }) + "</div>" +
        '<div style="border:1px solid #2c2c2c;border-radius:10px;overflow:hidden;margin-top:22px;">' +
          '<div style="display:grid;grid-template-columns:1.3fr 0.9fr 0.9fr 0.9fr;align-items:center;padding:11px 16px;background:#202020;font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:0.09em;text-transform:uppercase;color:#8a8a8a;font-weight:500;">' +
            "<span>Date</span><span>Vues / j</span><span>Abonnés Δ</span><span>Évol. vues</span></div>" + rows + "</div></section>" +
      bestHoursPanel(c) +
      // compte + oauth
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px;">' +
        '<section style="' + S.panel + '"><h2 style="' + S.h2 + '">Compte</h2>' +
          '<p style="margin:8px 0 0;color:#8a8a8a;font-size:13px;line-height:1.55;">Renomme la chaîne ou relance la connexion OAuth. Le titre affiché vient de YouTube une fois connecté.</p>' +
          '<div style="display:flex;gap:8px;margin-top:16px;">' +
            '<button data-rename="' + esc(c.id) + '" class="hov-ghost" style="' + S.ghost + '">Renommer la chaîne</button>' +
            '<a href="' + aPath + '/connect" class="hov-ghost" style="' + S.ghost + 'text-decoration:none;">Reconnecter</a></div></section>' +
        '<section style="' + S.panel + '"><h2 style="' + S.h2 + '">Identifiants OAuth (clés)</h2>' +
          '<p style="margin:8px 0 0;color:#8a8a8a;font-size:13px;line-height:1.55;">Le fichier client_secret.json (« Application Web ») est partagé par toutes les chaînes. Dépose-le pour l\'installer ou le mettre à jour.</p>' +
          '<a href="/aide/client-secret" class="hov-cta" style="display:inline-block;margin-top:12px;border:1px solid #ff4d8d;background:#ff4d8d;color:#111;padding:9px 15px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">📄 Comment créer ce fichier ?</a>' +
          '<form method="post" action="/credentials/upload" enctype="multipart/form-data">' +
          '<label class="hov-drop" style="display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;cursor:pointer;border:1.5px dashed #3a3a3a;border-radius:10px;padding:18px;background:#202020;margin-top:14px;">' +
            '<span style="font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;">＋ Fichier client_secret.json</span>' +
            '<span style="font-size:12px;color:#777;">Clique pour parcourir (envoi auto)</span>' +
            '<input type="file" name="secrets" accept=".json" data-autosubmit style="display:none;"></label></form></section></div>' +
      // réglages + dépôt
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;">' +
        '<section style="' + S.panel + '"><h2 style="' + S.h2 + '">Réglages</h2>' +
          '<p style="margin:8px 0 0;color:#8a8a8a;font-size:13px;line-height:1.55;">Planification automatique des mises en ligne.</p>' +
          '<form method="post" action="' + aPath + '/settings">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid #242424;margin-top:8px;">' +
            '<span style="font-size:14px;font-weight:500;color:#ededed;">Planification active</span>' +
            '<label class="switch"><input type="checkbox" name="enabled"' + (c.settings.active ? " checked" : "") + '><span class="track"></span><span class="knob"></span></label></div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:16px;">' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Vidéos par jour</span><input type="number" name="posts_per_day" value="' + c.settings.perDay + '" class="foc" style="' + S.input + '"></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Confidentialité par défaut</span>' + privSel("privacy", c.settings.privacy) + "</div>" +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Début (h)</span><input type="number" name="window_start" value="' + c.settings.start + '" class="foc" style="' + S.input + '"></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Fin (h)</span><input type="number" name="window_end" value="' + c.settings.end + '" class="foc" style="' + S.input + '"></div></div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:13px;align-items:end;">' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Heures fixes (optionnel)</span>' +
              '<input type="text" name="fixed_times" value="' + esc((c.settings.fixedTimes || []).join(", ")) + '" placeholder="ex. 11:30, 18:00 — vide = aléatoire" class="foc" style="' + S.input + '"></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Durée</span>' +
              '<select name="fixed_duration" class="foc" style="' + S.input + 'cursor:pointer;">' +
                [["permanent", "Permanent (jusqu'à changement)"], ["1", "Aujourd'hui seulement"], ["2", "2 jours"], ["3", "3 jours"], ["7", "7 jours"], ["14", "14 jours"]]
                  .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === (c.settings.fixedDuration || "permanent") ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
              "</select></div></div>" +
          '<div style="font-size:11.5px;color:#777;margin-top:8px;line-height:1.5;">' +
            ((c.settings.fixedTimes || []).length
              ? (c.settings.fixedUntil
                  ? "Heures fixes <b style=\"color:#9a9a9a;\">jusqu'au " + esc(c.settings.fixedUntil) + " inclus</b>, puis retour à l'aléatoire."
                  : "Heures fixes <b style=\"color:#9a9a9a;\">permanentes</b> (jusqu'à changement).")
              : "Heures <b style=\"color:#9a9a9a;\">aléatoires</b> dans la fenêtre. Renseigne des heures pour les fixer.") +
            " La fenêtre et « vidéos/jour » sont ignorés quand des heures fixes sont actives.</div>" +
          '<div style="margin-top:16px;padding:14px 16px;border-radius:10px;background:#202020;border:1px solid #2c2c2c;">' +
            '<div style="' + S.field + '">Créneaux du jour</div><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:9px;">' +
            (c.settings.active && c.slots.length ? c.slots.map(function (s) { return '<span style="font-family:\'IBM Plex Mono\';font-size:12px;background:#2c2c2c;color:#ededed;border-radius:6px;padding:5px 10px;">' + esc(s) + "</span>"; }).join("") : '<span style="font-size:13px;color:#777;">Aucun créneau — planification inactive ou déjà passés.</span>') + "</div></div>" +
          '<div style="margin-top:18px;padding-top:16px;border-top:1px solid #242424;">' +
            '<div style="font-size:14px;font-weight:500;color:#ededed;">Hashtags automatiques</div>' +
            '<p style="margin:5px 0 0;color:#8a8a8a;font-size:12.5px;line-height:1.5;">Appliqués aux vidéos déposées sans .json (y compris en SSH). Sans #, séparés par des virgules. #Shorts est ajouté tout seul.</p>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:13px;">' +
              '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Toujours inclus</span>' +
                '<input type="text" name="hashtags_core" value="' + esc((c.settings.hashtagsCore || []).join(", ")) + '" placeholder="ex. football, foot" class="foc" style="' + S.input + '"></div>' +
              '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Nb piochés au hasard</span>' +
                '<input type="number" name="hashtags_extra" value="' + (c.settings.hashtagsExtra != null ? c.settings.hashtagsExtra : 4) + '" min="0" max="15" class="foc" style="' + S.input + '"></div></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;margin-top:13px;"><span style="' + S.field + '">Réservoir (piochés au hasard, un mélange différent par vidéo)</span>' +
              '<textarea name="hashtags_pool" rows="2" placeholder="ex. viral, sport, but, skills, goal, ligue1…" class="foc" style="' + S.input + 'resize:vertical;font-family:\'IBM Plex Sans\';">' + esc((c.settings.hashtagsPool || []).join(", ")) + '</textarea></div>' +
            '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #242424;">' +
              '<div style="font-size:13px;font-weight:500;color:#ededed;">Hashtags temporaires</div>' +
              '<p style="margin:5px 0 0;color:#8a8a8a;font-size:12.5px;line-height:1.5;">Ajoutés aux permanents seulement pour les prochaines vidéos, puis retour automatique aux permanents. La décompte se fait au dépôt de chaque vidéo.</p>' +
              (c.settings.hashtagsTempRemaining > 0
                ? '<p style="margin:7px 0 0;color:#ff4d8d;font-size:12.5px;font-weight:500;">Actifs pour encore ' + c.settings.hashtagsTempRemaining + ' vidéo(s).</p>'
                : '') +
              '<div style="display:grid;grid-template-columns:1fr 200px;gap:13px;margin-top:13px;">' +
                '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Hashtags temporaires</span>' +
                  '<input type="text" name="hashtags_temp" value="' + esc((c.settings.hashtagsTemp || []).join(", ")) + '" placeholder="ex. coupedumonde, finale" class="foc" style="' + S.input + '"></div>' +
                '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Pour les X prochaines vidéos</span>' +
                  '<input type="number" name="hashtags_temp_remaining" value="' + (c.settings.hashtagsTempRemaining != null ? c.settings.hashtagsTempRemaining : 0) + '" min="0" max="999" class="foc" style="' + S.input + '"></div></div></div></div></div>' +
          '<button class="hov-cta" style="' + S.cta + 'margin-top:16px;width:100%;padding:11px 16px;border-radius:9px;">Enregistrer les réglages</button></form></section>' +
        '<section style="' + S.panel + '"><h2 style="' + S.h2 + '">Déposer des vidéos</h2>' +
          '<p style="margin:8px 0 0;color:#8a8a8a;font-size:13px;line-height:1.55;">Mets des vidéos en file pour publication automatique.</p>' +
          '<form method="post" action="' + aPath + '/upload" enctype="multipart/form-data">' +
          '<label class="hov-drop" style="display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;cursor:pointer;border:1.5px dashed #3a3a3a;border-radius:10px;padding:20px;background:#202020;margin-top:14px;">' +
            '<span id="upname" style="font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;">＋ Fichiers vidéo + .json</span>' +
            '<span style="font-size:12px;color:#777;">Plusieurs fichiers possibles — clique pour parcourir</span>' +
            '<input type="file" name="videos" accept="video/*,.json" multiple data-files="upname" style="display:none;"></label>' +
          '<div style="display:flex;flex-direction:column;gap:14px;margin-top:16px;">' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Titre</span><input type="text" name="title" placeholder="vide = nom du fichier" class="foc" style="' + S.inputSans + '"></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Description</span><textarea name="description" rows="3" class="foc" style="' + S.inputSans + 'resize:vertical;font-family:\'IBM Plex Sans\';"></textarea></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Tags (séparés par des virgules)</span><input type="text" name="tags" placeholder="clip, best-of, 2026" class="foc" style="' + S.inputSans + '"></div>' +
            '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">' +
              '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Confidentialité</span>' + privSel("privacy", c.settings.privacy) + "</div>" +
              '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Contenu pour enfants</span>' +
                '<div style="display:inline-flex;border:1px solid #3a3a3a;border-radius:8px;overflow:hidden;">' +
                  '<button type="button" data-kids="no" id="kidsNo" style="border:none;cursor:pointer;padding:9px 18px;font-size:13px;font-weight:500;background:#ff4d8d;color:#111;">Non</button>' +
                  '<button type="button" data-kids="yes" id="kidsYes" style="border:none;border-left:1px solid #3a3a3a;cursor:pointer;padding:9px 18px;font-size:13px;font-weight:500;background:#1c1c1c;color:#ededed;">Oui</button></div>' +
                '<input type="checkbox" name="made_for_kids" id="kidsInput" style="display:none;"></div></div></div>' +
          '<div style="margin-top:16px;padding:13px 15px;border-radius:10px;background:#202020;border:1px solid #2c2c2c;font-size:12.5px;color:#9a9a9a;line-height:1.6;">' +
            '<span style="font-weight:600;color:#ff4d8d;">Astuce —</span> dépose des paires <span style="font-family:\'IBM Plex Mono\';font-size:12px;color:#ededed;">clip01.mp4</span> + <span style="font-family:\'IBM Plex Mono\';font-size:12px;color:#ededed;">clip01.json</span> (même nom) pour donner à chaque vidéo son titre/description/tags. Les vidéos sans .json prennent les valeurs ci-dessus.</div>' +
          '<button class="hov-cta" style="' + S.cta + 'margin-top:16px;width:100%;padding:11px 16px;border-radius:9px;">Ajouter à la file</button></form></section></div></div>';
  }

  // ---- render + events ----
  var root = document.getElementById("root");
  function render() {
    CHARTS = {}; chartSeq = 0; hideChartTip();
    var body = isGlobal() ? globalPage() : channelPage();
    // La sidebar est rendue côté serveur (shell) ; ici on ne remplit que le contenu.
    root.innerHTML = '<div class="page">' + body + "</div>";
    window.scrollTo(0, 0);
  }

  root.addEventListener("click", function (e) {
    // Navigation = vrais changements de page (la sidebar serveur reste affichée).
    var nav = e.target.closest("[data-nav]");
    if (nav) { window.location = "/"; return; }
    var nc = e.target.closest("[data-navch]");
    if (nc) { window.location = "/channel/" + encodeURIComponent(nc.getAttribute("data-navch")); return; }
    var r = e.target.closest("[data-range]");
    if (r) { var v = r.getAttribute("data-range"); range = v === "all" ? "all" : parseInt(v, 10); render(); return; }
    var md = e.target.closest("[data-mode]");
    if (md) { mode = md.getAttribute("data-mode"); render(); return; }
    var k = e.target.closest("[data-kids]");
    if (k) {
      var yes = k.getAttribute("data-kids") === "yes";
      var inp = document.getElementById("kidsInput"); if (inp) inp.checked = yes;
      var no = document.getElementById("kidsNo"), ye = document.getElementById("kidsYes");
      if (no && ye) {
        no.style.background = yes ? "#1c1c1c" : "#ff4d8d"; no.style.color = yes ? "#ededed" : "#111";
        ye.style.background = yes ? "#ff4d8d" : "#1c1c1c"; ye.style.color = yes ? "#111" : "#ededed";
      }
      return;
    }
    var rn = e.target.closest("[data-rename]");
    if (rn) {
      var cur = rn.getAttribute("data-rename");
      var nm = window.prompt("Nouveau nom de la chaîne", cur);
      if (nm && nm.trim() && nm.trim() !== cur) {
        var f = document.createElement("form");
        f.method = "post"; f.action = "/channel/" + encodeURIComponent(cur) + "/rename";
        f.innerHTML = '<input type="hidden" name="new_name" value="' + esc(nm.trim()) + '">';
        document.body.appendChild(f); f.submit();
      }
      return;
    }
  });

  root.addEventListener("change", function (e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute("data-autosubmit") && t.files && t.files.length) { t.form.submit(); return; }
    if (t.hasAttribute && t.hasAttribute("data-files") && t.files) {
      var span = document.getElementById(t.getAttribute("data-files"));
      if (span) span.textContent = t.files.length ? t.files.length + " fichier(s) sélectionné(s)" : "＋ Fichiers vidéo + .json";
    }
  });

  var fl = document.getElementById("flash");
  if (fl && fl.children.length) setTimeout(function () { fl.style.transition = "opacity .4s"; fl.style.opacity = "0"; }, 4000);

  // ---- info-bulle des courbes (survol) ----
  var chartTip = document.createElement("div");
  chartTip.style.cssText = "position:fixed;z-index:60;pointer-events:none;display:none;background:#161616;" +
    "border:1px solid #3a3a3a;border-radius:9px;padding:8px 11px;box-shadow:0 6px 22px rgba(0,0,0,.5);" +
    "font-family:'IBM Plex Mono';min-width:88px;";
  document.body.appendChild(chartTip);
  var hoverCross = null, hoverHl = null;
  function hideChartTip() {
    chartTip.style.display = "none";
    if (hoverCross) hoverCross.style.display = "none";
    if (hoverHl) hoverHl.style.display = "none";
    hoverCross = hoverHl = null;
  }
  root.addEventListener("mousemove", function (e) {
    var hit = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (!hit) { if (chartTip.style.display !== "none") hideChartTip(); return; }
    var reg = CHARTS[hit.getAttribute("data-tip")];
    var p = reg && reg.pts[+hit.getAttribute("data-i")];
    if (!p) { hideChartTip(); return; }
    var xl = document.getElementById(reg.x), hc = document.getElementById(reg.h);
    if (xl) { xl.setAttribute("x1", p.cx); xl.setAttribute("x2", p.cx); xl.style.display = ""; if (hoverCross && hoverCross !== xl) hoverCross.style.display = "none"; hoverCross = xl; }
    if (hc) { hc.setAttribute("cx", p.cx); hc.setAttribute("cy", p.cy); hc.style.display = ""; if (hoverHl && hoverHl !== hc) hoverHl.style.display = "none"; hoverHl = hc; }
    chartTip.innerHTML = p.tip;
    chartTip.style.display = "block";
    var tw = chartTip.offsetWidth, th = chartTip.offsetHeight;
    var lx = e.clientX + 14, ly = e.clientY + 14;
    if (lx + tw > window.innerWidth - 8) lx = e.clientX - tw - 14;
    if (ly + th > window.innerHeight - 8) ly = e.clientY - th - 14;
    chartTip.style.left = lx + "px"; chartTip.style.top = ly + "px";
  });
  root.addEventListener("mouseleave", hideChartTip);

  render();
})();
