// co2tracker.js — Gaia Radio CO₂ emission tracker for tar1090
//
// Hybrid architecture:
//   • Server-side daemon (co2daemon.sh) tracks CO₂ continuously and
//     publishes totals to /co2data.json.  These are the authoritative
//     "all time" numbers.
//   • This client-side module provides real-time per-aircraft detail and
//     a "session" counter while the page is open.
//   • If the server daemon is unreachable, falls back to localStorage.
(function () {
  'use strict';

  // ======================== Configuration ========================
  var UPDATE_INTERVAL   = 5000;   // ms between client tracking cycles
  var SERVER_POLL       = 10000;  // ms between server data fetches
  var STALE_POS_SEC     = 120;
  var MAX_JUMP_KM       = 50;
  var MIN_MOVE_KM       = 0.01;
  var CLEANUP_MAX_AGE   = 3600000;
  var STORAGE_KEY       = 'gaia_co2_tracker';

  // ======================== Emission Factors ========================
  // kg CO₂ per km — used client-side for type-specific accuracy.
  var EF = {
    // Turboprops
    AT43: 2.5,  AT45: 2.5,  AT72: 3.0,  AT76: 3.0,
    DH8A: 2.2,  DH8B: 2.4,  DH8C: 2.8,  DH8D: 3.2,
    SF34: 2.0,  D328: 1.8,  F50:  2.5,  JS41: 1.8,
    L410: 1.2,  AN26: 3.5,  AN24: 3.2,  BEH2: 2.0,
    // Regional jets
    CRJ1: 3.5,  CRJ2: 3.8,  CRJ7: 4.5,  CRJ9: 5.0,  CRJX: 5.2,
    E135: 3.3,  E145: 3.5,  E170: 4.5,  E75L: 4.8,  E75S: 4.8,
    E190: 5.5,  E195: 5.8,  E290: 5.0,  E295: 5.2,
    F70:  4.0,  F100: 5.0,  RJ85: 5.5,  RJ1H: 6.0,
    SU95: 5.5,  AR85: 5.3,
    // Narrow-body
    A318: 6.5,  A319: 7.0,  A19N: 6.0,
    A320: 7.8,  A20N: 6.5,
    A321: 8.5,  A21N: 7.2,
    B731: 7.5,  B732: 7.2,  B733: 7.0,
    B734: 7.2,  B735: 6.5,  B736: 6.8,
    B737: 7.0,  B738: 7.5,  B739: 7.8,
    B37M: 5.8,  B38M: 6.0,  B39M: 6.3,
    B752: 9.0,  B753: 10.0,
    MD80: 8.5,  MD81: 8.3,  MD82: 8.5,  MD83: 8.5,
    MD87: 7.8,  MD88: 8.5,  MD90: 8.0,
    BCS1: 5.8,  BCS3: 6.2,
    C919: 7.5,  B712: 7.0,
    DC93: 7.2,  DC95: 7.5,
    T204: 7.8,  T154: 12.0,
    // Wide-body
    A306: 14.5,  A30B: 15.0,  A310: 13.0,
    A332: 14.0,  A333: 15.0,
    A338: 12.0,  A339: 12.5,
    A342: 16.0,  A343: 16.5,  A345: 18.0,  A346: 19.0,
    A359: 11.5,  A35K: 12.5,  A388: 25.0,
    B741: 23.0,  B742: 23.0,  B743: 23.0,
    B744: 22.0,  B748: 21.0,
    B762: 11.0,  B763: 11.5,  B764: 12.5,
    B772: 15.0,  B77L: 16.0,  B77W: 17.5,
    B788: 11.0,  B789: 12.0,  B78X: 12.5,
    DC10: 18.0,  MD11: 17.0,
    L101: 18.0,  IL96: 20.0,  IL86: 22.0,
    // Business / private jets
    C25A: 0.9,  C25B: 1.0,  C25C: 1.0,  C25M: 1.0,
    C510: 0.7,  C525: 0.9,
    C500: 0.9,  C550: 1.1,  C560: 1.5,  C56X: 1.8,
    C680: 2.0,  C68A: 2.0,  C700: 2.2,  C750: 2.3,
    CL30: 2.0,  CL35: 2.2,  CL60: 2.5,
    GL5T: 3.0,  GL7T: 3.5,  GLEX: 3.2,
    GLF4: 2.5,  GLF5: 2.8,  GLF6: 3.0,
    G150: 1.6,  G280: 2.0,
    FA50: 1.8,  FA7X: 2.3,  FA8X: 2.5,  F900: 2.2,  F2TH: 2.0,
    E35L: 1.2,  E55P: 1.2,
    LJ35: 1.4,  LJ45: 1.5,  LJ60: 1.8,  LJ75: 1.5,
    H25B: 1.8,  H25C: 1.8,
    GALX: 2.0,  ASTR: 1.5,
    PC12: 0.7,  PC24: 1.0,  TBM7: 0.5,  TBM8: 0.5,  TBM9: 0.5,
    PRM1: 1.0,  P180: 0.8,
    BE20: 0.7,  BE30: 0.8,  BE40: 1.2,  BE4W: 1.3,
    EA50: 0.5,
    // Military transport / tanker
    C130: 8.5,  C30J: 8.0,  C17:  25.0,  C5:   35.0,  C5M: 35.0,
    K35R: 20.0, KC10: 18.0, A400: 9.5,   MRTT: 14.0,
    A124: 45.0, AN12: 10.0, IL76: 15.0,
    E3CF: 20.0, E6:   20.0, P3:   9.0,   P8:   11.0
  };

  var WTC_FALLBACK = { L: 1.5, M: 7.0, H: 20.0, J: 30.0 };
  var CAT_FALLBACK = {
    A1: 0.8, A2: 1.5, A3: 5.0, A4: 8.0, A5: 20.0, A6: 20.0, A7: 0.3,
    B1: 0.1, B2: 0.3, B4: 0.1, B6: 0.1, C1: 0.01, C3: 0.01
  };

  // ======================== Haversine ========================
  function toRad(deg) { return deg * Math.PI / 180; }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371.0 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ======================== State ========================
  var tracked     = {};      // per-aircraft client-side tracking
  var sessionCO2  = 0;       // kg – this page session
  var sessionDist = 0;       // km – this page session
  var sessionCount = 0;      // aircraft seen this session
  var seenHexes   = {};

  // Server-side data (fetched from co2data.json)
  var serverData  = null;    // { co2Kg, distKm, count, since, updated }
  var serverOK    = false;   // true when server daemon is reachable

  // Fallback localStorage totals (used only when server is down)
  var lsCO2   = 0;
  var lsDist  = 0;
  var lsCount = 0;

  // ======================== Emission lookup ========================
  function getEmissionFactor(type, wtc, cat) {
    if (type && EF[type] !== undefined) return EF[type];
    if (wtc && WTC_FALLBACK[wtc] !== undefined) return WTC_FALLBACK[wtc];
    if (cat && CAT_FALLBACK[cat] !== undefined) return CAT_FALLBACK[cat];
    return null;
  }

  // ======================== Server data fetch ========================
  function fetchServerData() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'co2data.json?_=' + Date.now(), true);
    xhr.timeout = 5000;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          serverData = JSON.parse(xhr.responseText);
          serverOK = true;
        } catch (e) { serverOK = false; }
      } else {
        serverOK = false;
      }
    };
    xhr.onerror = xhr.ontimeout = function () { serverOK = false; };
    xhr.send();
  }

  // ======================== localStorage fallback ========================
  function loadLS() {
    try {
      var s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (s.v === 2) { lsCO2 = s.co2 || 0; lsDist = s.dist || 0; lsCount = s.cnt || 0; }
    } catch (e) {}
  }

  function saveLS() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 2, co2: lsCO2 + sessionCO2, dist: lsDist + sessionDist,
        cnt: lsCount + sessionCount
      }));
    } catch (e) {}
  }

  // ======================== Core client-side tracking ========================
  function processPlane(plane) {
    if (!plane.position) return;
    if (plane.seen_pos > STALE_POS_SEC) return;

    var hex = plane.icao;
    var lat = plane.position[1];
    var lon = plane.position[0];
    var posTime = plane.position_time;

    if (!seenHexes[hex]) { seenHexes[hex] = true; sessionCount++; }

    var ac = tracked[hex];
    if (!ac) {
      tracked[hex] = {
        lastLat: lat, lastLon: lon, lastPosTime: posTime,
        distKm: 0, co2Kg: 0,
        type: plane.icaoType || null,
        wtc: plane.wtc || null,
        cat: plane.category || null,
        lastUpdate: Date.now()
      };
      return;
    }

    ac.lastUpdate = Date.now();
    if (posTime && posTime === ac.lastPosTime) return;
    if (ac.lastLat === null) {
      ac.lastLat = lat; ac.lastLon = lon; ac.lastPosTime = posTime;
      return;
    }

    var dist = haversineKm(ac.lastLat, ac.lastLon, lat, lon);

    if (dist > MAX_JUMP_KM) {
      ac.lastLat = lat; ac.lastLon = lon; ac.lastPosTime = posTime;
      return;
    }

    if (dist > MIN_MOVE_KM) {
      ac.distKm += dist;
      sessionDist += dist;

      if (plane.icaoType) ac.type = plane.icaoType;
      if (plane.wtc) ac.wtc = plane.wtc;
      if (plane.category) ac.cat = plane.category;

      var factor = getEmissionFactor(ac.type, ac.wtc, ac.cat);
      if (factor !== null) {
        var co2 = dist * factor;
        ac.co2Kg += co2;
        sessionCO2 += co2;
      }
    }

    ac.lastLat = lat; ac.lastLon = lon; ac.lastPosTime = posTime;
  }

  function tick() {
    if (typeof g === 'undefined' || !g.planes) return;

    for (var hex in g.planes) { processPlane(g.planes[hex]); }

    // Cleanup stale
    var now = Date.now();
    for (var h in tracked) {
      if (now - tracked[h].lastUpdate > CLEANUP_MAX_AGE) delete tracked[h];
    }

    updatePanel();
    updateSelectedInfo();
  }

  // ======================== Formatting helpers ========================
  function fmtCO2(kg) {
    if (kg >= 1000) return (kg / 1000).toFixed(2) + ' t';
    if (kg >= 10) return kg.toFixed(1) + ' kg';
    return kg.toFixed(2) + ' kg';
  }

  function fmtDist(km) {
    if (km >= 1000) return (km / 1000).toFixed(1) + 'k km';
    if (km >= 10) return km.toFixed(1) + ' km';
    return km.toFixed(2) + ' km';
  }

  function fmtAge(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ======================== UI – Summary Panel ========================
  function createPanel() {
    var style = document.createElement('style');
    style.textContent = '\
      #co2-panel {\
        position: fixed;\
        bottom: 12px;\
        left: 12px;\
        z-index: 1000;\
        background: rgba(24, 24, 28, 0.88);\
        color: #e0e0e0;\
        border-radius: 8px;\
        padding: 0;\
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\
        font-size: 12px;\
        line-height: 1.5;\
        min-width: 180px;\
        box-shadow: 0 2px 12px rgba(0,0,0,0.4);\
        backdrop-filter: blur(8px);\
        -webkit-backdrop-filter: blur(8px);\
        border: 1px solid rgba(255,255,255,0.08);\
        overflow: hidden;\
        user-select: none;\
      }\
      #co2-panel-header {\
        display: flex;\
        align-items: center;\
        justify-content: space-between;\
        padding: 7px 10px;\
        cursor: pointer;\
        background: rgba(255,255,255,0.04);\
        border-bottom: 1px solid rgba(255,255,255,0.06);\
      }\
      #co2-panel-header:hover { background: rgba(255,255,255,0.08); }\
      #co2-panel-title {\
        font-weight: 600;\
        font-size: 11px;\
        text-transform: uppercase;\
        letter-spacing: 0.5px;\
        color: #81c784;\
      }\
      #co2-panel-toggle {\
        font-size: 10px;\
        color: #888;\
        transition: transform 0.2s;\
      }\
      #co2-panel.collapsed #co2-panel-toggle { transform: rotate(180deg); }\
      #co2-panel-body { padding: 8px 10px; }\
      #co2-panel.collapsed #co2-panel-body { display: none; }\
      .co2-row {\
        display: flex;\
        justify-content: space-between;\
        align-items: baseline;\
        padding: 2px 0;\
      }\
      .co2-label { color: #999; font-size: 11px; }\
      .co2-value { font-weight: 600; font-variant-numeric: tabular-nums; color: #fff; }\
      .co2-value-big { color: #81c784; font-size: 14px; }\
      .co2-divider { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 4px 0; }\
      .co2-source {\
        font-size: 9px;\
        color: #666;\
        text-align: right;\
        padding-top: 2px;\
      }\
      .co2-dot {\
        display: inline-block;\
        width: 6px; height: 6px;\
        border-radius: 50%;\
        margin-right: 4px;\
        vertical-align: middle;\
      }\
      .co2-dot-on  { background: #81c784; }\
      .co2-dot-off { background: #666; }\
      #co2-selected {\
        margin-top: 6px;\
        padding: 6px 8px;\
        background: rgba(129,199,132,0.08);\
        border: 1px solid rgba(129,199,132,0.15);\
        border-radius: 6px;\
        font-size: 11px;\
        color: #ccc;\
        display: none;\
      }\
      #co2-selected .co2-sel-title { font-weight: 600; color: #81c784; margin-bottom: 3px; font-size: 11px; }\
      #co2-selected .co2-sel-row { display: flex; justify-content: space-between; padding: 1px 0; }\
      #co2-selected .co2-sel-label { color: #999; }\
      #co2-selected .co2-sel-value { color: #fff; font-weight: 500; }\
    ';
    document.head.appendChild(style);

    var panel = document.createElement('div');
    panel.id = 'co2-panel';
    panel.innerHTML = '\
      <div id="co2-panel-header">\
        <span id="co2-panel-title">\u{1F33F} CO\u2082 Tracker</span>\
        <span id="co2-panel-toggle">\u25BC</span>\
      </div>\
      <div id="co2-panel-body">\
        <div class="co2-row">\
          <span class="co2-label">All time</span>\
          <span class="co2-value co2-value-big" id="co2-alltime">—</span>\
        </div>\
        <div class="co2-row">\
          <span class="co2-label">Total distance</span>\
          <span class="co2-value" id="co2-alldist">—</span>\
        </div>\
        <div class="co2-source" id="co2-source"></div>\
        <hr class="co2-divider">\
        <div class="co2-row">\
          <span class="co2-label">Session CO\u2082</span>\
          <span class="co2-value" id="co2-session">0 kg</span>\
        </div>\
        <div class="co2-row">\
          <span class="co2-label">Session dist</span>\
          <span class="co2-value" id="co2-sessdist">0 km</span>\
        </div>\
        <hr class="co2-divider">\
        <div class="co2-row">\
          <span class="co2-label">Aircraft seen</span>\
          <span class="co2-value" id="co2-count">0</span>\
        </div>\
        <div id="co2-selected">\
          <div class="co2-sel-title" id="co2-sel-title">Selected</div>\
          <div class="co2-sel-row">\
            <span class="co2-sel-label">Distance</span>\
            <span class="co2-sel-value" id="co2-sel-dist">\u2014</span>\
          </div>\
          <div class="co2-sel-row">\
            <span class="co2-sel-label">CO\u2082 est.</span>\
            <span class="co2-sel-value" id="co2-sel-co2">\u2014</span>\
          </div>\
          <div class="co2-sel-row">\
            <span class="co2-sel-label">Factor</span>\
            <span class="co2-sel-value" id="co2-sel-factor">\u2014</span>\
          </div>\
        </div>\
      </div>\
    ';
    document.body.appendChild(panel);

    // Toggle collapse
    document.getElementById('co2-panel-header').addEventListener('click', function () {
      panel.classList.toggle('collapsed');
      try { localStorage.setItem(STORAGE_KEY + '_c', panel.classList.contains('collapsed') ? '1' : '0'); } catch (e) {}
    });
    try {
      if (localStorage.getItem(STORAGE_KEY + '_c') === '1') panel.classList.add('collapsed');
    } catch (e) {}
  }

  function updatePanel() {
    var el;

    // "All time" row — prefer server, fall back to localStorage + session
    if (serverOK && serverData) {
      el = document.getElementById('co2-alltime');
      if (el) el.textContent = fmtCO2(serverData.co2Kg);
      el = document.getElementById('co2-alldist');
      if (el) el.textContent = fmtDist(serverData.distKm);
      el = document.getElementById('co2-count');
      if (el) el.textContent = serverData.count;
      el = document.getElementById('co2-source');
      if (el) el.innerHTML = '<span class="co2-dot co2-dot-on"></span>Server \u00b7 updated ' + fmtAge(serverData.updated);
    } else {
      var allCO2 = lsCO2 + sessionCO2;
      var allDist = lsDist + sessionDist;
      var allCount = lsCount + sessionCount;
      el = document.getElementById('co2-alltime');
      if (el) el.textContent = fmtCO2(allCO2);
      el = document.getElementById('co2-alldist');
      if (el) el.textContent = fmtDist(allDist);
      el = document.getElementById('co2-count');
      if (el) el.textContent = allCount;
      el = document.getElementById('co2-source');
      if (el) el.innerHTML = '<span class="co2-dot co2-dot-off"></span>Browser only';
    }

    // Session row — always client-side
    el = document.getElementById('co2-session');
    if (el) el.textContent = fmtCO2(sessionCO2);
    el = document.getElementById('co2-sessdist');
    if (el) el.textContent = fmtDist(sessionDist);
  }

  // ======================== UI – Selected aircraft info ========================
  function updateSelectedInfo() {
    var selBlock = document.getElementById('co2-selected');
    if (!selBlock) return;

    var sp = (typeof SelectedPlane !== 'undefined') ? SelectedPlane : null;
    if (!sp || !tracked[sp.icao]) {
      selBlock.style.display = 'none';
      return;
    }

    var ac = tracked[sp.icao];
    selBlock.style.display = 'block';

    var title = sp.flight ? sp.flight.trim() : sp.icao.toUpperCase();
    if (ac.type) title += ' (' + ac.type + ')';
    document.getElementById('co2-sel-title').textContent = title;
    document.getElementById('co2-sel-dist').textContent = fmtDist(ac.distKm);

    var factor = getEmissionFactor(ac.type, ac.wtc, ac.cat);
    if (factor !== null && ac.co2Kg > 0) {
      document.getElementById('co2-sel-co2').textContent = fmtCO2(ac.co2Kg);
      var src = ac.type && EF[ac.type] !== undefined ? ac.type : (ac.wtc ? 'WTC-' + ac.wtc : 'cat');
      document.getElementById('co2-sel-factor').textContent = factor.toFixed(1) + ' kg/km (' + src + ')';
    } else {
      document.getElementById('co2-sel-co2').textContent = 'Unknown type';
      document.getElementById('co2-sel-factor').textContent = '\u2014';
    }
  }

  // ======================== Init ========================
  function init() {
    loadLS();
    createPanel();
    fetchServerData();
    setInterval(tick, UPDATE_INTERVAL);
    setInterval(fetchServerData, SERVER_POLL);
    // Periodic localStorage save (fallback)
    setInterval(saveLS, 30000);
    console.log('[co2tracker] CO\u2082 tracker initialised (hybrid mode)');
  }

  function waitForTar1090() {
    if (typeof g !== 'undefined' && g.planes) {
      init();
    } else {
      setTimeout(waitForTar1090, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForTar1090);
  } else {
    waitForTar1090();
  }

})();
