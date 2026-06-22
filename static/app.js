/* clipstudio — SPA front (porté du handoff de design).
   - État client : `view` ('global' ou id de chaîne) et `range` (7|28|60|'all').
   - Les graphes / la navigation / le sélecteur de période sont 100% client.
   - Les actions persistantes (relevés, réglages, dépôt, connexion, renommage,
     identifiants OAuth) passent par des <form> vers les routes Flask existantes. */
(function () {
  "use strict";
  var DATA = window.__DATA__ || { channels: [], hasSecrets: false, initialView: "global" };
  var channels = DATA.channels;
  var COL = { chart: "#ff4d8d", subs: "#29d4c5", pos: "#2ecf76", neg: "#777777", neg2: "#ff5c61" };

  var view = DATA.initialView || "global";
  var range = 28;

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
  // Chaînes triées pour l'affichage : actives (planification ON) d'abord.
  // (le tri JS est stable → l'ordre d'origine est conservé à égalité)
  function sortedChannels() {
    return channels.slice().sort(function (a, b) {
      return (b.settings.active ? 1 : 0) - (a.settings.active ? 1 : 0);
    });
  }
  function lastF(arr, key) { return arr.length ? arr[arr.length - 1][key] : 0; }
  function round(n) { return Math.round(n * 10) / 10; }
  function shortD(d) { var p = String(d).split("-"); return p.length === 3 ? p[2] + "/" + p[1] : d; }
  function niceCeil(v) {
    if (v <= 0) return 10;
    var pow = Math.pow(10, Math.floor(Math.log10(v))), r = v / pow, m;
    if (r <= 1) m = 1; else if (r <= 2) m = 2; else if (r <= 5) m = 5; else m = 10;
    return m * pow;
  }
  function todayIso() {
    var d = new Date(), z = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
  }
  var PRIV = [["public", "Publique"], ["unlisted", "Non répertoriée"], ["private", "Privée"]];

  function filterRange(readings) {
    if (range === "all" || readings.length === 0) return readings;
    var maxD = readings[readings.length - 1].date;
    var p = maxD.split("-").map(Number);
    var ref = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    ref.setUTCDate(ref.getUTCDate() - range);
    var startIso = ref.toISOString().slice(0, 10);
    return readings.filter(function (r) { return r.date >= startIso; });
  }
  function globalSeries() {
    var all = [];
    channels.forEach(function (c) { c.readings.forEach(function (r) { all.push(r.date); }); });
    var dates = Array.from(new Set(all)).sort(function (a, b) { return a.localeCompare(b); });
    return dates.map(function (d) {
      var tv = 0, ts = 0;
      channels.forEach(function (c) {
        var v = 0, sv = 0;
        c.readings.forEach(function (r) { if (r.date.localeCompare(d) <= 0) { v = r.views; sv = r.subs; } });
        tv += v; ts += sv;
      });
      return { date: d, views: tv, subs: ts };
    });
  }
  function gain(series, key) { return series.length < 2 ? null : series[series.length - 1][key] - series[0][key]; }
  function gainLabel(g) { return g == null ? "—" : (g >= 0 ? "+" + g : String(g)); }
  function gainColor(g) { return g == null ? "#8a8a8a" : (g >= 0 ? COL.pos : COL.neg2); }

  function computeChart(series, key) {
    var n = series.length;
    if (n < 2) return { ready: false };
    var padL = 46, padR = 18, padT = 16, padB = 28, W = 760, H = 220;
    var innerW = W - padL - padR, innerH = H - padT - padB, baseY = padT + innerH;
    var vals = series.map(function (s) { return s[key]; });
    var niceMax = niceCeil(Math.max.apply(null, vals));
    var X = function (i) { return round(padL + innerW * (i / (n - 1))); };
    var Y = function (v) { return round(padT + innerH * (1 - v / niceMax)); };
    var showVals = n <= 8, rad = n <= 8 ? 4.5 : 3;
    var pts = series.map(function (s, i) {
      return { cx: X(i), cy: Y(s[key]), ty: Y(s[key]) - 11, r: rad, label: showVals ? String(s[key]) : "" };
    });
    var line = pts.map(function (p) { return p.cx + "," + p.cy; }).join(" ");
    var area = "M " + pts[0].cx + "," + baseY + " " + pts.map(function (p) { return "L " + p.cx + "," + p.cy; }).join(" ") + " L " + pts[n - 1].cx + "," + baseY + " Z";
    var ticks = [1, 0.5, 0].map(function (f) { var y = round(padT + innerH * (1 - f)); return { y: y, ty: y + 4, label: Math.round(niceMax * f) }; });
    var stepIdx = Math.max(1, Math.ceil(n / 6)), labels = [];
    series.forEach(function (s, i) { if (i % stepIdx === 0 || i === n - 1) labels.push({ x: X(i), label: shortD(s.date) }); });
    return { ready: true, line: line, area: area, pts: pts, ticks: ticks, labels: labels };
  }

  function chartSVG(cd, color, striped) {
    if (!cd.ready) {
      return '<div style="border:1px dashed #333333;border-radius:10px;height:160px;display:flex;align-items:center;justify-content:center;text-align:center;color:#777777;font-size:13px;' +
        (striped ? "background:repeating-linear-gradient(45deg,#161616,#161616 10px,#1a1a1a 10px,#1a1a1a 20px);" : "") +
        '">Pas assez de données ' + (striped ? "sur cette période" : "sur la période") + ".</div>";
    }
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
    return '<svg viewBox="0 0 760 220" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;font-family:\'IBM Plex Mono\';animation:dpop .35s ease;">' +
      ticks + '<path d="' + cd.area + '" fill="' + fill + '" stroke="none"></path>' +
      '<polyline points="' + cd.line + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
      pts + labels + "</svg>";
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
  };

  function kpi(label, num, color) {
    return '<div style="' + S.kpi + '"><span style="' + S.kpiLabel + '">' + label + '</span><span style="' + S.kpiNum + "color:" + color + ';">' + esc(num) + "</span></div>";
  }
  function rangeSelector() {
    var defs = [["7 j", 7], ["28 j", 28], ["2 mois", 60], ["Tout", "all"]];
    return '<div style="display:inline-flex;background:#1c1c1c;border:1px solid #3a3a3a;border-radius:9px;padding:3px;gap:3px;flex:none;">' +
      defs.map(function (o) {
        var on = range === o[1];
        return '<button data-range="' + o[1] + '" style="border:none;cursor:pointer;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:500;font-family:\'IBM Plex Mono\';background:' +
          (on ? "#ff4d8d" : "transparent") + ";color:" + (on ? "#111111" : "#cfcfcf") + ';">' + o[0] + "</button>";
      }).join("") + "</div>";
  }
  function rangeLabel() {
    var m = { 7: "7 j", 28: "28 j", 60: "2 mois" };
    return range === "all" ? "tout" : (m[range] || (range + " j"));
  }
  function chartTitle(color, txt) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;"><span style="width:10px;height:3px;border-radius:2px;background:' + color + ';"></span><h3 style="margin:0;font-size:13px;font-weight:600;color:#ededed;">' + txt + "</h3></div>";
  }

  // ---- sidebar ----
  function sidebar() {
    var items = sortedChannels().map(function (c) {
      var on = !isGlobal() && c.id === view;
      return '<button data-navch="' + esc(c.id) + '" class="hov-item" style="position:relative;display:flex;align-items:center;gap:11px;width:100%;text-align:left;border:none;cursor:pointer;border-radius:9px;padding:10px 10px 10px 14px;margin-bottom:3px;color:#fff;background:' + (on ? "#1f1f1f" : "transparent") + ';">' +
        '<span style="position:absolute;left:4px;top:10px;bottom:10px;width:2px;border-radius:2px;background:' + (on ? COL.chart : "transparent") + ';"></span>' +
        '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + (c.connected ? COL.pos : "#8a8a8a") + ';"></span>' +
        '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;">' +
        '<span style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.id) + "</span>" +
        '<span style="font-family:\'IBM Plex Mono\';font-size:10px;color:#8a8a8a;">' + lastF(c.readings, "subs") + " abonnés</span></span></button>";
    }).join("");

    var gOn = isGlobal();
    var secretTxt = DATA.hasSecrets ? "installé" : "à installer";
    var secretCol = DATA.hasSecrets ? COL.pos : "#8a8a8a";

    return '<aside style="width:266px;flex:none;background:#0c0c0c;color:#fff;display:flex;flex-direction:column;border-right:1px solid #1f1f1f;height:100vh;">' +
      '<div style="padding:20px 20px 16px;display:flex;align-items:center;gap:11px;border-bottom:1px solid #1f1f1f;">' +
        '<div style="width:28px;height:28px;border-radius:7px;background:#ff4d8d;display:flex;align-items:center;justify-content:center;flex:none;">' +
          '<span style="width:0;height:0;border-left:10px solid #0c0c0c;border-top:6px solid transparent;border-bottom:6px solid transparent;margin-left:3px;"></span></div>' +
        '<div style="display:flex;flex-direction:column;line-height:1.15;">' +
          '<span style="font-weight:700;font-size:15px;letter-spacing:0.01em;">clipstudio</span>' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:10px;color:#7a7a7a;letter-spacing:0.09em;text-transform:uppercase;">auto-upload</span></div></div>' +
      '<div style="padding:16px 14px 6px;">' +
        '<button data-nav="global" class="hov-item" style="position:relative;display:flex;align-items:center;gap:11px;width:100%;text-align:left;border:none;cursor:pointer;border-radius:9px;padding:11px 10px 11px 14px;color:#fff;background:' + (gOn ? "#1f1f1f" : "transparent") + ';">' +
          '<span style="position:absolute;left:4px;top:11px;bottom:11px;width:2px;border-radius:2px;background:' + (gOn ? COL.chart : "transparent") + ';"></span>' +
          '<span style="display:grid;grid-template-columns:6px 6px;gap:3px;flex:none;">' +
            ['', '', '', ''].map(function () { return '<span style="width:6px;height:6px;border-radius:1.5px;background:' + (gOn ? COL.chart : "#9a9a9a") + ';"></span>'; }).join("") +
          "</span>" +
          '<span style="display:flex;flex-direction:column;gap:2px;"><span style="font-size:13px;font-weight:600;">Vue d\'ensemble</span>' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:10px;color:#8a8a8a;">cumul ' + channels.length + " chaînes</span></span></button></div>" +
      '<div style="padding:8px 14px 8px;">' +
        '<div style="font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:0.13em;color:#6f6f6f;text-transform:uppercase;padding:0 8px 10px;">Chaînes · ' + channels.length + "</div>" + items +
        '<form method="post" action="/channels/add" style="display:flex;gap:6px;margin-top:8px;padding:0 2px;">' +
          '<input name="name" placeholder="+ ajouter" style="' + S.input + 'flex:1;min-width:0;padding:7px 9px;font-size:12px;" class="foc">' +
          '<button class="hov-ghost" style="' + S.ghost + 'padding:7px 10px;">OK</button></form></div>' +
      '<div style="margin-top:auto;padding:14px;border-top:1px solid #1f1f1f;">' +
        '<div style="font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:0.13em;color:#6f6f6f;text-transform:uppercase;padding:0 8px 8px;">Clés partagées</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-radius:9px;background:#171717;">' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:11px;color:#cfcfcf;">client_secret.json</span>' +
          '<span style="font-size:10px;color:' + secretCol + ';font-family:\'IBM Plex Mono\';">' + secretTxt + "</span></div>" +
        '<div style="margin-top:12px;padding:0 8px;font-family:\'IBM Plex Mono\';font-size:11px;display:flex;gap:10px;flex-wrap:wrap;">' +
          '<a class="muted-link" href="/library">Bibliothèque</a><a class="muted-link" href="/logs">Logs</a><a class="muted-link" href="/logout">Déconnexion</a></div></div>' +
      "</aside>";
  }

  // ---- page : vue d'ensemble ----
  function globalPage() {
    var gFull = globalSeries();
    var gF = filterRange(gFull);
    var gV = computeChart(gF, "views"), gS = computeChart(gF, "subs");
    var gvg = gain(gF, "views"), gsg = gain(gF, "subs");

    var cards = sortedChannels().map(function (c, i) {
      var f = filterRange(c.readings), sg = gain(f, "subs");
      return '<button data-navch="' + esc(c.id) + '" class="hov-card" style="min-width:0;text-align:left;cursor:pointer;border:1px solid #2c2c2c;background:#202020;border-radius:10px;padding:14px 15px;display:flex;flex-direction:column;gap:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
          '<span style="display:flex;align-items:center;gap:8px;min-width:0;"><span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + (c.connected ? COL.pos : "#8a8a8a") + ';"></span>' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.id) + "</span></span>" +
          '<span style="font-size:10px;font-family:\'IBM Plex Mono\';color:' + (c.settings.active ? COL.pos : "#777777") + ';white-space:nowrap;">' + (c.settings.active ? "auto actif" : "en pause") + "</span></div>" +
        '<div style="display:flex;gap:18px;">' +
          '<div style="display:flex;flex-direction:column;gap:3px;"><span style="font-family:\'IBM Plex Mono\';font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#777;">vues</span><span style="font-family:\'IBM Plex Mono\';font-size:21px;font-weight:600;line-height:1;color:' + COL.chart + ';">' + lastF(c.readings, "views") + "</span></div>" +
          '<div style="display:flex;flex-direction:column;gap:3px;"><span style="font-family:\'IBM Plex Mono\';font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:#777;">abonnés</span><span style="font-family:\'IBM Plex Mono\';font-size:21px;font-weight:600;line-height:1;color:' + COL.subs + ';">' + lastF(c.readings, "subs") + "</span></div></div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;font-family:\'IBM Plex Mono\';font-size:11px;color:#8a8a8a;border-top:1px solid #2a2a2a;padding-top:10px;">' +
          '<span style="color:' + gainColor(sg) + ';">' + gainLabel(sg) + " ab.</span>" +
          "<span>" + (c.settings.active ? c.slots.length + " créneaux/j" : "— créneau") + "</span></div></button>";
    }).join("");

    return '<div style="animation:dpop .3s ease;">' +
      '<header style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px;">' +
        '<div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<h1 style="margin:0;font-size:27px;font-weight:700;letter-spacing:-0.015em;color:#f5f5f5;white-space:nowrap;">Vue d\'ensemble</h1>' +
          '<span style="font-family:\'IBM Plex Mono\';font-size:11px;color:#ff4d8d;background:rgba(255,77,141,0.1);border:1px solid rgba(255,77,141,0.3);padding:4px 10px;border-radius:999px;">cumul · ' + channels.length + " chaînes</span></div>" +
          '<div style="font-family:\'IBM Plex Mono\';font-size:12px;color:#8a8a8a;margin-top:8px;">Toutes chaînes confondues — saison 2026</div></div>' +
        rangeSelector() + "</header>" +
      '<section style="' + S.panel + 'margin-bottom:18px;">' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">' +
          kpi("Vues cumulées", lastF(gFull, "views"), COL.chart) +
          kpi("Abonnés cumulés", lastF(gFull, "subs"), COL.subs) +
          kpi("Vues gagnées · " + rangeLabel(), gainLabel(gvg), gainColor(gvg)) +
          kpi("Abonnés gagnés · " + rangeLabel(), gainLabel(gsg), gainColor(gsg)) + "</div>" +
        '<div style="margin-top:22px;padding-top:20px;border-top:1px solid #262626;">' +
          chartTitle(COL.chart, "Vues cumulées") + chartSVG(gV, COL.chart, false) +
          '<div style="margin:22px 0 0;">' + chartTitle(COL.subs, "Abonnés cumulés") + chartSVG(gS, COL.subs, false) + "</div></div></section>" +
      '<section style="' + S.panel + '">' +
        '<h2 style="' + S.h2 + '">Détail par chaîne</h2>' +
        '<p style="margin:4px 0 16px;color:#8a8a8a;font-size:13px;">Clique une chaîne pour ouvrir sa page de stats.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(' + Math.max(1, channels.length) + ',1fr);gap:12px;">' + cards + "</div></section></div>";
  }

  // ---- page : chaîne ----
  function channelPage() {
    var c = channels[curIdx()];
    var cF = filterRange(c.readings);
    var cV = computeChart(cF, "views"), cS = computeChart(cF, "subs");
    var vg = gain(cF, "views"), sg = gain(cF, "subs");
    var aPath = "/channel/" + enc(c.id);

    var rows = c.readings.map(function (r, i) {
      var prev = i > 0 ? c.readings[i - 1].views : null;
      var delta = prev == null ? null : r.views - prev;
      return '<div style="display:grid;grid-template-columns:1.3fr 0.9fr 0.9fr 0.8fr 50px;align-items:center;padding:11px 16px;border-top:1px solid #242424;font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;">' +
        "<span>" + esc(r.date) + "</span><span>" + r.views + '</span><span style="color:' + COL.subs + ';">' + r.subs + "</span>" +
        '<span style="color:' + (delta == null ? "#8a8a8a" : (delta >= 0 ? COL.pos : COL.neg2)) + ';font-weight:500;">' + (delta == null ? "—" : (delta >= 0 ? "+" + delta : String(delta))) + "</span>" +
        '<form method="post" action="' + aPath + '/views/delete" style="justify-self:end;"><input type="hidden" name="date" value="' + esc(r.date) + '">' +
        '<button class="hov-x" style="border:none;background:transparent;color:#666;font-size:13px;cursor:pointer;padding:4px;">✕</button></form></div>';
    }).join("");
    if (c.readings.length === 0) rows = '<div style="padding:18px 16px;border-top:1px solid #242424;color:#777;font-size:13px;text-align:center;">Aucun relevé pour cette chaîne.</div>';

    var statusOn = c.connected;
    var statusPill = '<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:' + (statusOn ? "#4fd98e" : "#ff8c8f") + ';background:' + (statusOn ? "rgba(46,207,118,0.12)" : "rgba(255,92,97,0.12)") + ';border:1px solid ' + (statusOn ? "rgba(46,207,118,0.3)" : "rgba(255,92,97,0.3)") + ';padding:4px 10px;border-radius:999px;">' +
      '<span style="width:7px;height:7px;border-radius:50%;background:' + (statusOn ? COL.pos : COL.neg2) + ';"></span>' + esc(c.status) + "</span>";

    var privSel = function (nm, sel) {
      return '<select name="' + nm + '" class="foc" style="' + S.input + 'cursor:pointer;">' +
        PRIV.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === sel ? " selected" : "") + ">" + p[1] + "</option>"; }).join("") + "</select>";
    };

    return '<div style="animation:dpop .3s ease;">' +
      // header
      '<header style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px;">' +
        '<div style="display:flex;flex-direction:column;gap:8px;"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<h1 style="margin:0;font-size:27px;font-weight:700;letter-spacing:-0.015em;color:#f5f5f5;">' + esc(c.id) + "</h1>" + statusPill + "</div>" +
          '<div style="font-family:\'IBM Plex Mono\';font-size:12px;color:#8a8a8a;">Titre YouTube : ' + esc(c.ytTitle) + "</div></div>" +
        '<div style="display:flex;gap:8px;flex:none;">' +
          '<form method="post" action="' + aPath + '/sync"><button class="hov-ghost" style="' + S.ghost + '">↻ Synchroniser</button></form>' +
          '<button data-rename="' + esc(c.id) + '" class="hov-ghost" style="' + S.ghost + '">Renommer la chaîne</button>' +
          '<a href="' + aPath + '/connect" class="hov-cta" style="border:1px solid #ff4d8d;background:#ff4d8d;color:#111;padding:9px 15px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;">Reconnecter</a></div></header>' +
      // performance panel
      '<section style="' + S.panel + 'margin-bottom:18px;">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">' +
          '<div><h2 style="margin:0;font-size:16px;font-weight:700;letter-spacing:-0.01em;color:#f5f5f5;">Performance — 2026</h2>' +
          '<p style="margin:6px 0 0;color:#8a8a8a;font-size:13px;">Vues et abonnés sur la période sélectionnée.</p></div>' + rangeSelector() + "</div>" +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 22px;">' +
          kpi("Vues · dernier", lastF(c.readings, "views"), COL.chart) +
          kpi("Abonnés · total", lastF(c.readings, "subs"), COL.subs) +
          kpi("Vues gagnées · " + rangeLabel(), gainLabel(vg), gainColor(vg)) +
          kpi("Abonnés gagnés · " + rangeLabel(), gainLabel(sg), gainColor(sg)) + "</div>" +
        chartTitle(COL.chart, "Vues") + chartSVG(cV, COL.chart, true) +
        '<div style="margin:22px 0 0;">' + chartTitle(COL.subs, "Abonnés") + chartSVG(cS, COL.subs, true) + "</div>" +
        // add reading form
        '<form method="post" action="' + aPath + '/views/add" style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px;padding:16px;border:1px solid #2c2c2c;border-radius:10px;background:#202020;margin:22px 0 18px;">' +
          '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Date</span><input type="date" name="date" value="' + todayIso() + '" required class="foc" style="' + S.input + '"></div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Vues</span><input type="number" name="views" placeholder="ex. 120" required class="foc" style="' + S.input + 'width:120px;"></div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;"><span style="' + S.field + '">Abonnés</span><input type="number" name="subs" placeholder="ex. 40" class="foc" style="' + S.input + 'width:120px;"></div>' +
          '<button class="hov-cta" style="' + S.cta + '">+ Ajouter le relevé</button></form>' +
        // table
        '<div style="border:1px solid #2c2c2c;border-radius:10px;overflow:hidden;">' +
          '<div style="display:grid;grid-template-columns:1.3fr 0.9fr 0.9fr 0.8fr 50px;align-items:center;padding:11px 16px;background:#202020;font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:0.09em;text-transform:uppercase;color:#8a8a8a;font-weight:500;">' +
            "<span>Date</span><span>Vues</span><span>Abonnés</span><span>Évol.</span><span></span></div>" + rows + "</div></section>" +
      // compte + oauth
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px;">' +
        '<section style="' + S.panel + '"><h2 style="' + S.h2 + '">Compte</h2>' +
          '<p style="margin:8px 0 0;color:#8a8a8a;font-size:13px;line-height:1.55;">Renomme la chaîne ou relance la connexion OAuth. Le titre affiché vient de YouTube une fois connecté.</p>' +
          '<div style="display:flex;gap:8px;margin-top:16px;">' +
            '<button data-rename="' + esc(c.id) + '" class="hov-ghost" style="' + S.ghost + '">Renommer la chaîne</button>' +
            '<a href="' + aPath + '/connect" class="hov-ghost" style="' + S.ghost + 'text-decoration:none;">Reconnecter</a></div></section>' +
        '<section style="' + S.panel + '"><h2 style="' + S.h2 + '">Identifiants OAuth (clés)</h2>' +
          '<p style="margin:8px 0 0;color:#8a8a8a;font-size:13px;line-height:1.55;">Le fichier client_secret.json (« Application Web ») est partagé par toutes les chaînes. Dépose-le pour l\'installer ou le mettre à jour.</p>' +
          '<form method="post" action="/credentials/upload" enctype="multipart/form-data">' +
          '<label class="hov-drop" style="display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;cursor:pointer;border:1.5px dashed #3a3a3a;border-radius:10px;padding:18px;background:#202020;margin-top:14px;">' +
            '<span style="font-family:\'IBM Plex Mono\';font-size:13px;color:#ededed;">＋ Fichier client_secret.json</span>' +
            '<span style="font-size:12px;color:#777;">Clique pour parcourir (envoi auto)</span>' +
            '<input type="file" name="secrets" accept=".json" data-autosubmit style="display:none;"></label></form></section></div>' +
      // réglages + dépôt
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;">' +
        // settings
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
          '<div style="margin-top:16px;padding:14px 16px;border-radius:10px;background:#202020;border:1px solid #2c2c2c;">' +
            '<div style="' + S.field + '">Créneaux du jour</div><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:9px;">' +
            (c.settings.active && c.slots.length ? c.slots.map(function (s) { return '<span style="font-family:\'IBM Plex Mono\';font-size:12px;background:#2c2c2c;color:#ededed;border-radius:6px;padding:5px 10px;">' + esc(s) + "</span>"; }).join("") : '<span style="font-size:13px;color:#777;">Aucun créneau — planification inactive ou déjà passés.</span>') + "</div></div>" +
          '<button class="hov-cta" style="' + S.cta + 'margin-top:16px;width:100%;padding:11px 16px;border-radius:9px;">Enregistrer les réglages</button></form></section>' +
        // upload
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
    var body = isGlobal() ? globalPage() : channelPage();
    root.innerHTML = '<div style="display:flex;min-height:100vh;width:100%;color:#ededed;background:#111;">' +
      sidebar() +
      '<main style="flex:1;min-width:0;overflow-y:auto;background:#111;"><div style="max-width:1080px;margin:0 auto;padding:30px 38px 72px;">' +
      body + "</div></main></div>";
    window.scrollTo(0, 0);
  }

  root.addEventListener("click", function (e) {
    var nav = e.target.closest("[data-nav]");
    if (nav) { view = nav.getAttribute("data-nav"); render(); return; }
    var nc = e.target.closest("[data-navch]");
    if (nc) { view = nc.getAttribute("data-navch"); render(); return; }
    var r = e.target.closest("[data-range]");
    if (r) { var v = r.getAttribute("data-range"); range = v === "all" ? "all" : parseInt(v, 10); render(); return; }
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

  // auto-masquer les toasts flash
  var fl = document.getElementById("flash");
  if (fl && fl.children.length) setTimeout(function () { fl.style.transition = "opacity .4s"; fl.style.opacity = "0"; }, 4000);

  render();
})();
