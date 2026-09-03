// login.js — standalone first-run / add-source page for TV Navigator (webOS 3.x)
(function () {
  "use strict";

  var KEY_SOURCES = "tvn_sources";
  var KEY_ACTIVE_SOURCE = "tvn_active_source";

  /* ── storage helpers ─────────────────────────────────────── */
  function loadArray(key) {
    try {
      var v = localStorage.getItem(key);
      v = v ? JSON.parse(v) : [];
      return Object.prototype.toString.call(v) === "[object Array]" ? v : [];
    } catch (e) {
      return [];
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function trim(v) {
    return String(v || "").replace(/^\s+|\s+$/g, "");
  }

  function makeId() {
    return "src-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
  }

  /* ── redirect if already logged in, unless Settings requested a new source ── */
  var addingSource = /(?:\?|&)add=1(?:&|$)/.test(window.location.search || "");
  var hasExistingSources = loadArray(KEY_SOURCES).length > 0;
  if (hasExistingSources && !addingSource) {
    window.location.replace("index.html");
    return;
  }

  (function applyStoredTheme() {
    var theme = "aurora";
    try {
      var rawSettings = localStorage.getItem("tvn_settings");
      var settings = rawSettings ? JSON.parse(rawSettings) : {};
      theme = settings && settings.theme ? settings.theme : theme;
    } catch (e) {}
    if (
      theme !== "dark" &&
      theme !== "light" &&
      theme !== "oled" &&
      theme !== "magenta" &&
      theme !== "aurora"
    ) {
      theme = "aurora";
    }
    document.body.className = "tvn-theme-" + theme;
  })();

  /* ── DOM refs ────────────────────────────────────────────── */
  var tabXtream = document.getElementById("lp-tab-xtream");
  var tabM3u = document.getElementById("lp-tab-m3u");
  var formXtream = document.getElementById("lp-form-xtream");
  var formM3u = document.getElementById("lp-form-m3u");
  var errorBox = document.getElementById("lp-error");
  var saveBtn = document.getElementById("lp-save");
  var cancelBtn = document.getElementById("lp-cancel");

  /* ── cancel is only possible when a working source already exists ── */
  function goToDashboard() {
    window.location.replace("index.html");
  }

  if (hasExistingSources && cancelBtn) {
    cancelBtn.style.display = "";
    // tabindex is added here so the hidden button never joins remote navigation.
    cancelBtn.setAttribute("tabindex", "0");
    cancelBtn.addEventListener("click", goToDashboard);
    var hint = document.getElementById("lp-hint");
    if (hint) {
      hint.textContent =
        "\u25B2\u25BC\u25C0\u25B6 move \u00B7 OK on a field to type \u00B7 BACK to cancel";
    }
  } else if (cancelBtn && cancelBtn.parentNode) {
    cancelBtn.parentNode.removeChild(cancelBtn);
    cancelBtn = null;
  }

  /* ── on-screen diagnostics (readable directly on the TV) ── */
  function diag(msg) {
    var box = document.getElementById("lp-diag");
    if (!box) return;
    var el = document.activeElement;
    box.textContent = msg + " | focus: " + (el ? el.id || el.tagName : "none");
  }
  /* ── active tab ──────────────────────────────────────────── */
  var activeTab = "xtream";

  function setTab(tab) {
    activeTab = tab;
    tabXtream.classList.toggle("active", tab === "xtream");
    tabM3u.classList.toggle("active", tab === "m3u");
    formXtream.classList.toggle("active", tab === "xtream");
    formM3u.classList.toggle("active", tab === "m3u");
    clearError();
  }

  tabXtream.addEventListener("click", function () {
    setTab("xtream");
    selectEl(tabXtream);
  });
  tabM3u.addEventListener("click", function () {
    setTab("m3u");
    selectEl(tabM3u);
  });

  /* ── error display ───────────────────────────────────────── */
  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add("show");
  }
  function clearError() {
    errorBox.textContent = "";
    errorBox.classList.remove("show");
  }

  /* ── build source object ─────────────────────────────────── */
  function buildSource() {
    if (activeTab === "xtream") {
      var name =
        trim(document.getElementById("lp-name").value) || "Xtream Source";
      var server = trim(document.getElementById("lp-server").value);
      var user = trim(document.getElementById("lp-user").value);
      var pass = trim(document.getElementById("lp-pass").value);
      if (!server || !user || !pass) {
        throw new Error("Fill in the Xtream server, username and password.");
      }
      return {
        id: makeId(),
        type: "xtream",
        name: name,
        server: server,
        user: user,
        pass: pass,
      };
    }
    var m3uName =
      trim(document.getElementById("lp-m3u-name").value) || "M3U Playlist";
    var m3uUrl = trim(document.getElementById("lp-m3u-url").value);
    var ua = trim(document.getElementById("lp-m3u-ua").value);
    if (!m3uUrl) {
      throw new Error("Enter a remote M3U URL.");
    }
    return {
      id: makeId(),
      type: "m3u",
      name: m3uName,
      url: m3uUrl,
      userAgent: ua,
    };
  }

  /* ── XHR helpers ─────────────────────────────────────────── */
  function fetchText(url, userAgent) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = 30000;
      if (userAgent) {
        try {
          xhr.setRequestHeader("User-Agent", userAgent);
        } catch (e) {}
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error("HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () {
        reject(new Error("Network error"));
      };
      xhr.ontimeout = function () {
        reject(new Error("Timeout"));
      };
      xhr.send();
    });
  }

  function fetchJSON(url) {
    return fetchText(url).then(function (t) {
      return JSON.parse(t);
    });
  }

  function xtreamApiUrl(src) {
    return (
      trim(src.server).replace(/\/+$/, "") +
      "/player_api.php?username=" +
      encodeURIComponent(src.user) +
      "&password=" +
      encodeURIComponent(src.pass)
    );
  }

  /* ── validate source ─────────────────────────────────────── */
  function validateSource(src) {
    if (src.type === "xtream") {
      return fetchJSON(xtreamApiUrl(src)).then(function (data) {
        var auth = data && data.user_info ? data.user_info.auth : 0;
        if (auth !== 1 && auth !== "1" && auth !== true && auth !== "true") {
          throw new Error("Xtream authentication failed.");
        }
        if (data.user_info && data.user_info.exp_date) {
          src.expiry = String(data.user_info.exp_date);
        }
      });
    }
    return fetchText(src.url, src.userAgent).then(function (text) {
      if (text.indexOf("#EXTM3U") === -1 && text.indexOf("#EXTINF") === -1) {
        throw new Error("That URL did not return a valid M3U playlist.");
      }
    });
  }

  /* ── save and redirect ───────────────────────────────────── */
  function saveAndGo(src) {
    var sources = loadArray(KEY_SOURCES);
    sources.push(src);
    saveJson(KEY_SOURCES, sources);
    try {
      localStorage.setItem(KEY_ACTIVE_SOURCE, src.id);
    } catch (e) {}
    window.location.replace("index.html");
  }

  /* ── save button handler ─────────────────────────────────── */
  var unlockTimer = null;

  function onSave() {
    clearError();
    var src;
    try {
      src = buildSource();
    } catch (e) {
      showError(e.message || "Invalid source.");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Checking...";
    selectEl(saveBtn);

    // Auto-unlock after 15 s if network hangs
    unlockTimer = setTimeout(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Source";
      showError("Validation timed out. Check server URL and credentials.");
    }, 15000);

    validateSource(src).then(
      function () {
        clearTimeout(unlockTimer);
        saveAndGo(src);
      },
      function (err) {
        clearTimeout(unlockTimer);
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Source";
        showError(
          err && err.message ? err.message : "Source validation failed."
        );
        selectEl(saveBtn);
      }
    );
  }

  saveBtn.addEventListener("click", onSave);

  /* ── webOS 3.x remote navigation ─────────────────────────
     Native-first: webOS TV has built-in spatial navigation, so arrow keys and
     OK are left alone and only handled here when the platform does not act.
     Calling preventDefault() on arrows would disable the TV's own navigation. */

  var selEl = null; // element currently highlighted
  var _nativeClicked = false; // set when the platform fired a real click
  var editing = false; // true only after OK opens the on-screen keyboard

  function safeFocus(node) {
    if (!node) return;
    try {
      node.focus({ preventScroll: true });
    } catch (e) {
      try {
        node.focus();
      } catch (e2) {}
    }
  }

  function isInputEl(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
  }

  // Selectable items of the active tab, in visual order.
  function items() {
    var all = document.querySelectorAll("[tabindex]");
    var out = [];
    var i;
    for (i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.disabled) continue;
      var a = n.parentNode;
      var skip = false;
      while (a && a !== document.body) {
        if (
          a.classList &&
          a.classList.contains("lp-form-block") &&
          !a.classList.contains("active")
        ) {
          skip = true;
          break;
        }
        a = a.parentNode;
      }
      if (!skip) out.push(n);
    }
    return out;
  }

  // Group items into visual rows by their vertical position.
  function rows() {
    var list = items();
    var rs = [];
    var i, j;
    for (i = 0; i < list.length; i++) {
      var top = list[i].getBoundingClientRect().top;
      var row = null;
      for (j = 0; j < rs.length; j++) {
        if (Math.abs(rs[j].top - top) < 20) {
          row = rs[j];
          break;
        }
      }
      if (!row) {
        row = { top: top, items: [] };
        rs.push(row);
      }
      row.items.push(list[i]);
    }
    rs.sort(function (a, b) {
      return a.top - b.top;
    });
    return rs;
  }

  function locate(rs, el) {
    var r, c;
    for (r = 0; r < rs.length; r++) {
      for (c = 0; c < rs[r].items.length; c++) {
        if (rs[r].items[c] === el) return { row: r, col: c };
      }
    }
    return null;
  }

  function selectEl(el) {
    if (!el) return;
    var list = items();
    var i;
    for (i = 0; i < list.length; i++) {
      list[i].classList.remove("lp-focus");
    }
    selEl = el;
    el.classList.add("lp-focus");
    // Real DOM focus, so webOS spatial navigation and native OK keep working.
    safeFocus(el);
    try {
      el.scrollIntoView(false);
    } catch (e) {}
  }

  function move(dRow, dCol) {
    var rs = rows();
    if (!rs.length) return;
    var pos = selEl ? locate(rs, selEl) : null;
    if (!pos) {
      selectEl(rs[0].items[0]);
      return;
    }
    if (dCol) {
      var nc = pos.col + dCol;
      if (nc >= 0 && nc < rs[pos.row].items.length) {
        selectEl(rs[pos.row].items[nc]);
        return;
      }
      // Past the edge of a row – step to the adjacent row.
      var wr = pos.row + (dCol > 0 ? 1 : -1);
      if (wr >= 0 && wr < rs.length) {
        selectEl(
          dCol > 0 ? rs[wr].items[0] : rs[wr].items[rs[wr].items.length - 1]
        );
      }
      return;
    }
    var nr = pos.row + dRow;
    if (nr < 0 || nr >= rs.length) return;
    var col = Math.min(pos.col, rs[nr].items.length - 1);
    selectEl(rs[nr].items[col]);
  }

  function activate() {
    var el = document.activeElement;
    if (!el || el === document.body) el = selEl;
    if (!el) return;
    if (isInputEl(el)) {
      safeFocus(el);
      return;
    }
    if (typeof el.click === "function") el.click();
  }

  function normalizedCode(event) {
    var code = event.keyCode || event.which || 0;
    var key = event.key || "";
    if (code) return code;
    if (key === "ArrowLeft") return 37;
    if (key === "ArrowUp") return 38;
    if (key === "ArrowRight") return 39;
    if (key === "ArrowDown") return 40;
    if (key === "Enter" || key === "OK") return 13;
    if (key === "Backspace") return 8;
    if (key === "Escape") return 27;
    if (key === "GoBack" || key === "Back") return 461;
    return 0;
  }

  document.addEventListener("keydown", onKey);

  function onKey(event) {
    if (!event) return;
    var code = normalizedCode(event);
    if (!code) return;

    var isBack = code === 461 || code === 10009 || code === 27;
    var active = document.activeElement;

    // Only while the on-screen keyboard is open do keys belong to it.
    // Merely having an input focused still allows arrow navigation.
    if (editing) {
      if (isBack) {
        // The TV closes its keyboard itself; keep focus on the field so
        // spatial navigation still has an anchor to move from.
        editing = false;
        safeFocus(active);
      }
      return;
    }

    if (isBack) {
      // Only leave the page when there is already a source to go back to.
      if (hasExistingSources) goToDashboard();
      return;
    }

    if (code === 13) {
      if (isInputEl(active)) {
        editing = true; // OK on a field opens the TV keyboard natively
        return;
      }
      // Let the platform fire the click first; only step in if it did not.
      setTimeout(function () {
        if (!_nativeClicked) activate();
        _nativeClicked = false;
      }, 0);
      return;
    }

    if (code === 37 || code === 38 || code === 39 || code === 40) {
      if (code === 38) move(-1, 0);
      else if (code === 40) move(1, 0);
      else if (code === 37) move(0, -1);
      else move(0, 1);
      event.preventDefault();
    }
  }

  // Keep the highlight on whatever the platform focused.
  function syncSelectionToFocus() {
    var el = document.activeElement;
    if (!el || el === document.body) return;
    var list = items();
    var i;
    var found = false;
    for (i = 0; i < list.length; i++) {
      if (list[i] === el) found = true;
      list[i].classList.remove("lp-focus");
    }
    if (found) {
      selEl = el;
      el.classList.add("lp-focus");
    }
  }

  // Track native activation so the OK fallback never double-fires.
  document.addEventListener(
    "click",
    function () {
      _nativeClicked = true;
    },
    true
  );

  // Keep the highlight in step with focus however it was moved.
  document.addEventListener("focus", syncSelectionToFocus, true);

  // Pointer / magic-remote clicks keep the selection in sync.
  (function bindPointer() {
    var list = items();
    var i;
    for (i = 0; i < list.length; i++) {
      (function (el) {
        el.addEventListener("mousedown", function () {
          selectEl(el);
        });
      })(list[i]);
    }
  })();

  /* ── initial selection ───────────────────────────────────── */
  setTimeout(function () {
    selectEl(tabXtream);
  }, 200);
})();
