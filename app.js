(function () {
  "use strict";

  /* Writes to the static diagnostic panel in index.html. */
  function diag(msg) {
    try {
      if (window._sd) window._sd(msg);
    } catch (e) {}
  }
  function hud(msg) {
    diag(msg);
  }
  function hideDiag() {
    try {
      var p = document.getElementById("static-diag");
      if (p && p.parentNode) p.parentNode.removeChild(p);
    } catch (e) {}
  }

  diag("app.js start");

  var KEY_SOURCES = "tvn_sources";
  var KEY_ACTIVE_SOURCE = "tvn_active_source";
  var KEY_FAVORITES = "tvn_favorites";
  var KEY_HISTORY = "tvn_history";
  var KEY_POSITIONS = "tvn_positions";
  var KEY_SETTINGS = "tvn_settings";
  var KEY_CACHE_COUNTS = "tvn_cache_counts_v1";
  var CACHE_DB_NAME = "tvn_cache_db";
  var CACHE_DB_STORE = "source_cache";
  var CACHE_DB_VERSION = 1;
  var PAGE_CHANNELS = 40;
  var PAGE_GRID = 24;
  var HOME_SEARCH_RENDER_LIMIT = 120;
  // Browsers cap concurrent connections per host at ~6; more just queues.
  var SYNC_CONCURRENCY = 6;
  var KEY_RATING_CACHE = "tvn_rating_cache_v1";
  var RATING_CACHE_TTL = 14 * 24 * 3600 * 1000;
  var ratingCacheData = null;
  var ratingCacheSaveTimer = null;
  var ENABLE_CATEGORY_SEARCH = false;

  var state = {
    view: "home",
    sourceTab: "xtream",
    sourceEditId: "",
    sources: loadArray(KEY_SOURCES),
    activeSourceId: loadString(KEY_ACTIVE_SOURCE),
    sourceCache: {},
    recordsByUid: {},
    ratingLive: {},
    ratingFetch: {},
    favorites: loadArray(KEY_FAVORITES),
    history: loadArray(KEY_HISTORY),
    positions: loadObject(KEY_POSITIONS),
    settings: mergeSettings(loadObject(KEY_SETTINGS)),
    searchQuery: "",
    categorySearch: {
      live: "",
      movies: "",
      series: ""
    },
    homeSearch: {
      token: 0,
      loading: false,
      lastQuery: "",
      focused: false,
      results: []
    },
    homeSummary: {
      counts: {
        live: 0,
        movies: 0,
        series: 0
      },
      updatedAt: {
        live: 0,
        movies: 0,
        series: 0
      },
      loading: false,
      sourceId: "",
      recentLoading: false,
      recentLoaded: false,
      recentSourceId: "",
      recentSessionLoaded: false
    },
    live: {
      selectedCategoryId: null,
      items: [],
      activeUid: null,
      rendered: 0,
      epg: []
    },
    movies: {
      selectedCategoryId: null,
      items: [],
      selectedUid: null,
      rendered: 0
    },
    series: {
      selectedCategoryId: null,
      items: [],
      selectedUid: null,
      restoreUid: null,
      rendered: 0
    },
    overlay: {
      open: false,
      record: null,
      list: null,
      index: -1,
      hls: null,
      mpegts: null,
      tick: null,
      controlsTimer: null,
      restartTimer: null,
      stallWatch: null,
      lastTime: 0,
      subtitle: { cues: [], enabled: false, loading: false, error: null }
    },
    movieDetail: {
      open: false,
      record: null,
      list: null,
      index: -1
    },
    inline: {
      record: null,
      list: null,
      index: -1,
      hls: null,
      mpegts: null,
      restartTimer: null,
      stallWatch: null,
      lastTime: 0
    }
  };

  var dom = {
    workspace: document.getElementById("workspace"),
    sourceModal: document.getElementById("source-modal"),
    sourceError: document.getElementById("source-error"),
    sourceMenu: document.getElementById("source-menu"),
    sourceMenuBtn: document.getElementById("source-menu-btn"),
    search: document.getElementById("global-search"),
    refreshBtn: document.getElementById("refresh-btn"),
    openSourceModalBtn: document.getElementById("open-source-modal"),
    topbarTime: document.getElementById("topbar-time-value"),
    topbarDate: document.getElementById("topbar-date-value"),
    logoutBtn: document.getElementById("logout-btn"),
    syncProgress: document.getElementById("sync-progress"),
    syncProgressLabel: document.getElementById("sync-progress-label"),
    syncProgressCount: document.getElementById("sync-progress-count"),
    syncProgressFill: document.getElementById("sync-progress-fill"),
    overlay: document.getElementById("overlay-player"),
    overlayVideo: document.getElementById("overlay-video"),
    overlayStatus: document.getElementById("overlay-status"),
    overlayTitle: document.getElementById("overlay-title"),
    overlaySubtitle: document.getElementById("overlay-subtitle"),
    overlayProgressFill: document.getElementById("overlay-progress-fill"),
    overlayCurrentTime: document.getElementById("overlay-current-time"),
    overlayTotalTime: document.getElementById("overlay-total-time"),
    overlayPlayPause: document.getElementById("overlay-playpause"),
    overlayPrev: document.getElementById("overlay-prev"),
    overlayRew: document.getElementById("overlay-rew"),
    overlayFwd: document.getElementById("overlay-fwd"),
    overlaySubtitleBtn: document.getElementById("overlay-subtitle-btn"),
    overlayQualityBtn: document.getElementById("overlay-quality-btn"),
    overlayFullscreenBtn: document.getElementById("overlay-fullscreen-btn"),
    overlayNext: document.getElementById("overlay-next"),
    overlayFavorite: document.getElementById("overlay-favorite"),
    overlayClose: document.getElementById("overlay-close"),
    overlayHint: document.getElementById("overlay-hint"),
    confirmModal: document.getElementById("confirm-modal"),
    confirmTitle: document.getElementById("confirm-title"),
    confirmMessage: document.getElementById("confirm-message"),
    confirmCancel: document.getElementById("confirm-cancel"),
    confirmOk: document.getElementById("confirm-ok")
  };

  if (!state.activeSourceId && state.sources.length) {
    state.activeSourceId = state.sources[0].id;
  }

  var cachePersistTimers = {};
  var homeCountSyncState = {};
  var appClockTimer = null;
  var recentWarmTimer = null;
  var cacheDatabase = createCacheDatabase();
  var confirmDialogAction = null;
  var confirmDialogReturnSelector = "";

  function createCacheDatabase() {
    var idb = window.indexedDB || window.webkitIndexedDB || null;
    var fallbackKey = "tvn_cache_fallback_v1";
    if (!idb) {
      return {
        loadSource: function (sourceId) {
          var bucket = loadObject(fallbackKey);
          return Promise.resolve(bucket[String(sourceId)] || null);
        },
        saveSource: function (sourceId, payload) {
          var bucket = loadObject(fallbackKey);
          bucket[String(sourceId)] = payload;
          saveJson(fallbackKey, bucket);
          return Promise.resolve();
        },
        deleteSource: function (sourceId) {
          var bucket = loadObject(fallbackKey);
          delete bucket[String(sourceId)];
          saveJson(fallbackKey, bucket);
          return Promise.resolve();
        },
        clearAll: function () {
          saveJson(fallbackKey, {});
          return Promise.resolve();
        }
      };
    }

    function openDb() {
      return new Promise(function (resolve, reject) {
        var req = idb.open(CACHE_DB_NAME, CACHE_DB_VERSION);
        req.onupgradeneeded = function (event) {
          var db = event.target.result;
          if (!db.objectStoreNames.contains(CACHE_DB_STORE)) {
            db.createObjectStore(CACHE_DB_STORE, { keyPath: "sourceId" });
          }
        };
        req.onsuccess = function () {
          resolve(req.result);
        };
        req.onerror = function () {
          reject(req.error || new Error("cache-db-open-failed"));
        };
      });
    }

    function run(mode, action) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction([CACHE_DB_STORE], mode);
          var store = tx.objectStore(CACHE_DB_STORE);
          var req = action(store);
          req.onsuccess = function () {
            resolve(req.result);
          };
          req.onerror = function () {
            reject(req.error || new Error("cache-db-request-failed"));
          };
        });
      });
    }

    return {
      loadSource: function (sourceId) {
        return run("readonly", function (store) {
          return store.get(String(sourceId));
        }).then(function (row) {
          return row && row.payload ? row.payload : null;
        });
      },
      saveSource: function (sourceId, payload) {
        return run("readwrite", function (store) {
          return store.put({
            sourceId: String(sourceId),
            payload: payload,
            savedAt: Date.now()
          });
        }).then(function () {});
      },
      deleteSource: function (sourceId) {
        return run("readwrite", function (store) {
          return store.delete(String(sourceId));
        }).then(function () {});
      },
      clearAll: function () {
        return run("readwrite", function (store) {
          return store.clear();
        }).then(function () {});
      }
    };
  }

  function loadArray(key) {
    try {
      var value = localStorage.getItem(key);
      value = value ? JSON.parse(value) : [];
      return Object.prototype.toString.call(value) === "[object Array]" ? value : [];
    } catch (e) {
      return [];
    }
  }

  function loadObject(key) {
    try {
      var value = localStorage.getItem(key);
      value = value ? JSON.parse(value) : {};
      return value && typeof value === "object" ? value : {};
    } catch (e) {
      return {};
    }
  }

  function loadString(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveJson(key, value) {
    writeJson(key, value);
  }

  function mergeSettings(saved) {
    var defaults = {
      volume: 0.8,
      rememberPosition: true,
      liveStreamFormat: "ts",
      cardDensity: "premium",
      theme: "aurora",
      fastStartup: true,
      osApiKey: "Ai44IgjqwXW1Cku062F9pwbGm7dS2pMw",
      omdbApiKey: "ef4e2333"
    };
    var key;
    for (key in saved) {
      if (Object.prototype.hasOwnProperty.call(saved, key)) {
        defaults[key] = saved[key];
      }
    }
    if (
      defaults.liveStreamFormat !== "default" &&
      defaults.liveStreamFormat !== "ts" &&
      defaults.liveStreamFormat !== "hls"
    ) {
      defaults.liveStreamFormat = "ts";
    }
    if (defaults.cardDensity !== "compact" && defaults.cardDensity !== "premium") {
      defaults.cardDensity = "premium";
    }
    if (
      defaults.theme !== "dark" &&
      defaults.theme !== "light" &&
      defaults.theme !== "oled" &&
      defaults.theme !== "magenta" &&
      defaults.theme !== "aurora"
    ) {
      defaults.theme = "aurora";
    }
    defaults.fastStartup = defaults.fastStartup !== false;
    return defaults;
  }

  function liveFormatLabel(value) {
    if (value === "ts") {
      return "MPEGTS (.ts)";
    }
    if (value === "hls") {
      return "HLS (.m3u8)";
    }
    return "Default";
  }

  function cardDensityLabel(value) {
    return value === "premium" ? "Premium" : "Compact";
  }

  function applyCardDensityClass() {
    var root = document.body;
    if (!root || !root.classList) {
      return;
    }
    root.classList.remove("tvn-density-premium");
    if (state.settings.cardDensity === "premium") {
      root.classList.add("tvn-density-premium");
    }
  }

  function applyThemeClass() {
    var root = document.body;
    if (!root || !root.classList) {
      return;
    }
    root.classList.remove("tvn-theme-dark");
    root.classList.remove("tvn-theme-light");
    root.classList.remove("tvn-theme-oled");
    root.classList.remove("tvn-theme-magenta");
    root.classList.remove("tvn-theme-aurora");
    if (state.settings.theme === "light") {
      root.classList.add("tvn-theme-light");
      return;
    }
    if (state.settings.theme === "oled") {
      root.classList.add("tvn-theme-oled");
      return;
    }
    if (state.settings.theme === "magenta") {
      root.classList.add("tvn-theme-magenta");
      return;
    }
    if (state.settings.theme === "aurora") {
      root.classList.add("tvn-theme-aurora");
      return;
    }
    root.classList.add("tvn-theme-aurora");
  }

  function saveSources() {
    saveJson(KEY_SOURCES, state.sources);
    try {
      localStorage.setItem(KEY_ACTIVE_SOURCE, state.activeSourceId || "");
    } catch (e) {}
  }

  function saveFavorites() {
    saveJson(KEY_FAVORITES, state.favorites);
  }

  function saveHistory() {
    saveJson(KEY_HISTORY, state.history);
  }

  var POSITION_LIMIT = 120;
  var positionsSaveTimer = null;
  var positionsQuotaWarned = false;

  // Each bookmark stores a full record, so the bucket has to be capped.
  function prunePositions(limit) {
    var keys = [];
    var key;
    for (key in state.positions) {
      if (Object.prototype.hasOwnProperty.call(state.positions, key)) {
        keys.push(key);
      }
    }
    if (keys.length <= limit) {
      return;
    }
    keys.sort(function (a, b) {
      return (state.positions[b].updatedAt || 0) - (state.positions[a].updatedAt || 0);
    });
    var i;
    for (i = limit; i < keys.length; i += 1) {
      delete state.positions[keys[i]];
    }
  }

  function savePositions() {
    if (positionsSaveTimer) {
      clearTimeout(positionsSaveTimer);
      positionsSaveTimer = null;
    }
    prunePositions(POSITION_LIMIT);
    if (writeJson(KEY_POSITIONS, state.positions)) {
      return;
    }
    // Quota exceeded: keep only the newest bookmarks and try once more.
    prunePositions(30);
    if (writeJson(KEY_POSITIONS, state.positions) || positionsQuotaWarned) {
      return;
    }
    positionsQuotaWarned = true;
    showToast("Storage full - older resume points were removed", false);
  }

  // Playback ticks twice a second; serialising the whole bucket that often stalls webOS.
  function schedulePositionsSave() {
    if (positionsSaveTimer) {
      return;
    }
    positionsSaveTimer = setTimeout(function () {
      positionsSaveTimer = null;
      savePositions();
    }, 8000);
  }

  function flushPendingPositions() {
    if (positionsSaveTimer) {
      savePositions();
    }
  }

  window.addEventListener("unload", flushPendingPositions);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      flushPendingPositions();
    }
  });

  function saveSettings() {
    saveJson(KEY_SETTINGS, state.settings);
    applyCardDensityClass();
    applyThemeClass();
  }

  function forceLogout() {
    var previousSources = state.sources.slice();
    state.sources = [];
    state.activeSourceId = "";
    state.sourceEditId = "";
    state.sourceCache = {};
    state.ratingLive = {};
    state.ratingFetch = {};
    homeCountSyncState = {};
    Array.prototype.forEach.call(previousSources, function (source) {
      if (source && source.id) {
        cacheDatabase.deleteSource(source.id);
        removePersistedSourceMeta(source.id);
      }
    });
    cacheDatabase.clearAll();
    saveSources();
    // Redirect to dedicated login page instead of reopening the in-app modal
    window.location.replace("login.html");
  }

  function openConfirmDialog(options) {
    var title;
    var message;
    if (!dom.confirmModal) {
      if (options && typeof options.onConfirm === "function") {
        options.onConfirm();
      }
      return;
    }
    title = trim((options && options.title) || "") || "Confirm action";
    message = trim((options && options.message) || "") || "Please confirm.";
    if (dom.confirmTitle) {
      dom.confirmTitle.textContent = title;
    }
    if (dom.confirmMessage) {
      dom.confirmMessage.textContent = message;
    }
    if (dom.confirmOk) {
      dom.confirmOk.textContent = trim((options && options.confirmLabel) || "") || "Confirm";
    }
    if (dom.confirmCancel) {
      dom.confirmCancel.textContent = trim((options && options.cancelLabel) || "") || "Cancel";
    }
    confirmDialogAction =
      options && typeof options.onConfirm === "function" ? options.onConfirm : null;
    confirmDialogReturnSelector = (options && options.returnFocusSelector) || "";
    dom.confirmModal.classList.add("open");
    setTimeout(function () {
      focusNode(dom.confirmCancel || dom.confirmOk);
    }, 40);
  }

  function closeConfirmDialog(restoreFocus) {
    var selector = confirmDialogReturnSelector;
    if (!dom.confirmModal || !dom.confirmModal.classList.contains("open")) {
      return;
    }
    dom.confirmModal.classList.remove("open");
    confirmDialogAction = null;
    confirmDialogReturnSelector = "";
    if (restoreFocus === false || !selector) {
      return;
    }
    focusFirst(selector);
  }

  function confirmDialogAccept() {
    var action = confirmDialogAction;
    closeConfirmDialog(false);
    if (action) {
      action();
    }
  }

  function isConfirmDialogOpen() {
    return !!(
      dom.confirmModal &&
      dom.confirmModal.classList &&
      dom.confirmModal.classList.contains("open")
    );
  }

  function closeApplication() {
    try {
      if (
        window.webOS &&
        window.webOS.application &&
        typeof window.webOS.application.getCurrentApplication === "function"
      ) {
        window.webOS.application.getCurrentApplication().close();
        return;
      }
    } catch (e) {}
    try {
      window.close();
    } catch (e2) {}
  }

  function clearAllLocalData() {
    openConfirmDialog({
      title: "Clear all local data?",
      message:
        "This removes local cache, history, favorites, and resume positions. You will need to sync categories again.",
      confirmLabel: "Clear data",
      cancelLabel: "Cancel",
      returnFocusSelector: "#settings-clear-data",
      onConfirm: performClearAllLocalData
    });
  }

  function performClearAllLocalData() {
    var sources = state.sources.slice();
    state.sourceCache = {};
    state.ratingLive = {};
    state.ratingFetch = {};
    clearRatingCache();
    state.history = [];
    state.favorites = [];
    state.positions = {};
    homeCountSyncState = {};
    Array.prototype.forEach.call(sources, function (source) {
      if (source && source.id) {
        cacheDatabase.deleteSource(source.id);
        removePersistedSourceMeta(source.id);
      }
    });
    saveHistory();
    saveFavorites();
    savePositions();
    resetViewState();
    renderCurrentView();
    showToast("Local data cleared. Sync categories to load content.", true, 2600);
  }

  function activeSource() {
    var i;
    for (i = 0; i < state.sources.length; i++) {
      if (state.sources[i].id === state.activeSourceId) {
        return state.sources[i];
      }
    }
    return null;
  }

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function makeId() {
    return "src-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function decodeHtmlEntities(value) {
    var text = String(value == null ? "" : value);
    if (!text || text.indexOf("&") === -1) {
      return text;
    }
    var node = document.createElement("textarea");
    node.innerHTML = text;
    return node.value;
  }

  function decodeBase64Text(value) {
    var raw = trim(value);
    if (!raw) {
      return "";
    }
    var compact = raw.replace(/\s+/g, "");
    if (compact.length < 8 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(compact)) {
      return raw;
    }
    try {
      var binary = atob(compact);
      var i;
      var safe = 0;
      for (i = 0; i < binary.length; i++) {
        var code = binary.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
          safe += 1;
        }
      }
      if (safe < Math.floor(binary.length * 0.6)) {
        return raw;
      }
      try {
        var utf8 = decodeURIComponent(
          binary.replace(/./g, function (char) {
            var hex = char.charCodeAt(0).toString(16).toUpperCase();
            return "%" + (hex.length < 2 ? "0" + hex : hex);
          })
        );
        return utf8;
      } catch (e2) {
        return binary;
      }
    } catch (e) {
      return raw;
    }
  }

  function normalizeEpgText(value, fallback) {
    var text = decodeBase64Text(value);
    text = decodeHtmlEntities(text);
    text = trim(text.replace(/\s+/g, " "));
    if (!text || /^[-_.|]+$/.test(text)) {
      return fallback || "";
    }
    return text;
  }

  function encodeAttr(value) {
    return String(value == null ? "" : value).replace(/[<>"']/g, function (char) {
      return {
        "<": "%3C",
        ">": "%3E",
        '"': "%22",
        "'": "%27"
      }[char];
    });
  }

  function safeImgUrl(url) {
    if (!url) return "";
    url = String(url).replace(/^\s+|\s+$/g, "");
    if (/^\/\//.test(url)) {
      url = "https:" + url;
    }
    return url.replace(/^http:\/\//i, "https://");
  }

  window.imgFallback = function (el) {
    var src = el.getAttribute("src") || "";
    var original = el.getAttribute("data-logo-original") || src;
    var stage = parseInt(el.getAttribute("data-logo-fallback-stage") || "0", 10);
    if (stage === 0) {
      el.setAttribute("data-logo-fallback-stage", "1");
      var alt = /^https:\/\//i.test(src)
        ? src.replace(/^https:\/\//i, "http://")
        : /^http:\/\//i.test(src)
          ? src.replace(/^http:\/\//i, "https://")
          : "";
      if (alt && alt !== src) {
        el.src = alt;
        return;
      }
    }
    if (stage <= 1 && !/images\.weserv\.nl/i.test(original)) {
      el.setAttribute("data-logo-fallback-stage", "2");
      el.src = "https://images.weserv.nl/?url=" + encodeURIComponent(original);
      return;
    }
    el.style.display = "none";
  };

  function logoFallbackText(value) {
    var words = String(value || "CH").replace(/[^a-z0-9 ]/gi, " ").split(/\s+/);
    var text = "";
    var i;
    for (i = 0; i < words.length && text.length < 2; i += 1) {
      if (words[i]) text += words[i].charAt(0).toUpperCase();
    }
    return text || "CH";
  }

  function pad(num) {
    num = String(num || 0);
    return num.length < 2 ? "0" + num : num;
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    return hours > 0
      ? pad(hours) + ":" + pad(minutes) + ":" + pad(secs)
      : pad(minutes) + ":" + pad(secs);
  }

  function yearFromItem(item) {
    var fields = [item.year, item.releasedate, item.release_date, item.added, item.first_aired];
    var i;
    for (i = 0; i < fields.length; i++) {
      if (!fields[i]) {
        continue;
      }
      var match = String(fields[i]).match(/(19|20)\d{2}/);
      if (match) {
        return match[0];
      }
    }
    return "";
  }

  function qualityFromItem(item) {
    var txt = (
      (item.resolution ||
        item.video_resolution ||
        item.container_extension ||
        item.stream_type ||
        "") + ""
    ).toLowerCase();
    if (/4k|2160/.test(txt)) {
      return "4K";
    }
    if (/1080|fhd/.test(txt)) {
      return "1080p";
    }
    if (/720/.test(txt)) {
      return "720p";
    }
    return "";
  }

  function buildMetaLine(item) {
    var parts = [];
    var year = yearFromItem(item);
    var quality = qualityFromItem(item);
    if (year) {
      parts.push(year);
    }
    if (quality) {
      parts.push(quality);
    }
    if (item.genre) {
      parts.push(item.genre);
    }
    return parts.join(" · ");
  }

  // All ratings are normalised to IMDb's 10-point scale.
  function ratingValueFromItem(item) {
    var tenScale = [
      item.rating_10,
      item.imdb_rating,
      item.imdbRating,
      item.rating,
      item.vote_average
    ];
    var i;
    var val;
    for (i = 0; i < tenScale.length; i++) {
      val = parseFloat(tenScale[i]);
      if (isFinite(val) && val > 0) {
        return Math.max(0, Math.min(10, val));
      }
    }
    val = parseFloat(item.rating_5based || item.rating_5);
    if (isFinite(val) && val > 0) {
      return Math.max(0, Math.min(10, val * 2));
    }
    return 0;
  }

  function ratingBadgeValue(record, item) {
    var live = state.ratingLive[record.uid];
    if (live && typeof live.value === "number" && live.value > 0) {
      return live.value;
    }
    return ratingValueFromItem(item || record.raw || {});
  }

  function updateRatingBadgeForUid(uid, value) {
    var cards = document.querySelectorAll('[data-record-uid="' + uid + '"]');
    Array.prototype.forEach.call(cards, function (card) {
      var poster = card.querySelector(".poster");
      if (!poster) {
        return;
      }
      var badge = poster.querySelector(".poster-badge--rating");
      if (value > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "poster-badge poster-badge--rating";
          poster.appendChild(badge);
        }
        badge.textContent = "★ " + value.toFixed(1);
      } else if (badge && badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    });
  }

  function extractRealtimeRating(data) {
    var sources = [];
    if (data) {
      sources.push(data);
      if (data.info) {
        sources.push(data.info);
      }
      if (data.movie_data) {
        sources.push(data.movie_data);
      }
      if (data.series_info) {
        sources.push(data.series_info);
      }
    }
    var i;
    for (i = 0; i < sources.length; i++) {
      var value = ratingValueFromItem(sources[i] || {});
      if (value > 0) {
        return value;
      }
    }
    return 0;
  }

  // A 4-digit number is only a release year if it is not in the future; this keeps
  // titles like "Blade Runner 2049" and "1917" intact.
  function plausibleYear(value) {
    var year = parseInt(value, 10);
    var max = new Date().getFullYear() + 2;
    return year >= 1900 && year <= max ? year : 0;
  }

  // IPTV titles carry provider noise ("EN | Inception 2010 4K MULTI") that never
  // matches IMDb. Strip it down to the bare title before looking the film up.
  function cleanLookupTitle(raw) {
    var text = String(raw || "");
    var stripped;
    text = text.replace(/[\(\[][^\)\]]*[\)\]]/g, " ");
    text = text.replace(/^\s*[A-Z]{2,3}\s*[-|:]\s*/, "");
    text = text.replace(/[_\.]+/g, " ");
    text = text.replace(
      /\b(4k|uhd|fhd|hd|sd|hq|1080p|720p|2160p|480p|x264|x265|hevc|web-?dl|webrip|bluray|brrip|hdrip|dvdrip|multi|dual|subbed|dubbed|imax|remux|10bit|hdr10|hdr|dolby|atmos|vip)\b/gi,
      " "
    );
    stripped = text.replace(/\b(19|20)\d{2}\b/g, function (match) {
      return plausibleYear(match) ? " " : match;
    });
    stripped = trim(stripped.replace(/\s*[-|:]+\s*$/, "").replace(/\s{2,}/g, " "));
    if (stripped) {
      text = stripped;
    }
    text = text.replace(/\s*[-|:]+\s*$/, "");
    text = text.replace(/\s{2,}/g, " ");
    return trim(text);
  }

  function extractTitleYear(raw) {
    var text = String(raw || "");
    var match = text.match(/[\(\[](19|20)\d{2}[\)\]]/);
    var year = match ? plausibleYear(match[0].replace(/[^\d]/g, "")) : 0;
    var all;
    var i;
    if (year) {
      return year;
    }
    all = text.match(/\b(19|20)\d{2}\b/g) || [];
    for (i = all.length - 1; i >= 0; i--) {
      year = plausibleYear(all[i]);
      if (year) {
        return year;
      }
    }
    return 0;
  }

  function imdbLookupTitle(record) {
    var raw = (record && record.raw) || {};
    var base = (record && record.title) || raw.name || raw.title || raw.movie_title || "";
    return cleanLookupTitle(base);
  }

  function extractImdbRating(data) {
    var raw = data && data.imdbRating ? String(data.imdbRating) : "";
    var val = parseFloat(raw);
    if (!isFinite(val) || val <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(10, val));
  }

  function omdbApiKey() {
    return trim(state.settings.omdbApiKey || "") || "ef4e2333";
  }

  function fetchImdbFreeRating(record) {
    var rawTitle = (record && record.title) || "";
    var title = imdbLookupTitle(record);
    var year = extractTitleYear(rawTitle) || yearFromItem((record && record.raw) || {});
    var type = record && record.view === "series" ? "series" : "movie";
    var base = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(omdbApiKey());
    if (!title) {
      return Promise.resolve(0);
    }

    function fetchJSONQuick(url, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.timeout = timeoutMs;
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) {
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              reject(e);
            }
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

    function byTitle(withYear) {
      var url = base + "&type=" + encodeURIComponent(type) + "&t=" + encodeURIComponent(title);
      if (withYear && year) {
        url += "&y=" + encodeURIComponent(String(year));
      }
      return fetchJSONQuick(url, 6000).then(
        function (data) {
          if (!data || data.Response === "False") {
            return 0;
          }
          return extractImdbRating(data);
        },
        function () {
          return 0;
        }
      );
    }

    // Exact-title lookups miss on slightly-off titles; fall back to search then fetch by id.
    function bySearch() {
      var url = base + "&type=" + encodeURIComponent(type) + "&s=" + encodeURIComponent(title);
      return fetchJSONQuick(url, 6000).then(
        function (data) {
          var list = data && data.Search;
          if (!list || !list.length || !list[0].imdbID) {
            return 0;
          }
          return fetchJSONQuick(base + "&i=" + encodeURIComponent(list[0].imdbID), 6000).then(
            function (detail) {
              return extractImdbRating(detail);
            },
            function () {
              return 0;
            }
          );
        },
        function () {
          return 0;
        }
      );
    }

    return byTitle(true)
      .then(function (value) {
        if (value > 0 || !year) {
          return value;
        }
        return byTitle(false);
      })
      .then(function (value) {
        return value > 0 ? value : bySearch();
      });
  }

  function ratingCacheKey(record) {
    var raw = (record && record.raw) || {};
    var year = extractTitleYear((record && record.title) || "") || yearFromItem(raw) || "";
    return (
      (record.view === "series" ? "s:" : "m:") + imdbLookupTitle(record).toLowerCase() + ":" + year
    );
  }

  function ratingCacheStore() {
    if (!ratingCacheData) {
      ratingCacheData = loadObject(KEY_RATING_CACHE) || {};
    }
    return ratingCacheData;
  }

  function readRatingCache(key) {
    var entry = ratingCacheStore()[key];
    if (!entry || typeof entry.v !== "number") {
      return null;
    }
    if (Date.now() - (entry.t || 0) > RATING_CACHE_TTL) {
      return null;
    }
    return entry.v;
  }

  function writeRatingCache(key, value) {
    var store = ratingCacheStore();
    store[key] = { v: value, t: Date.now() };
    if (ratingCacheSaveTimer) {
      clearTimeout(ratingCacheSaveTimer);
    }
    ratingCacheSaveTimer = setTimeout(function () {
      ratingCacheSaveTimer = null;
      var keys = Object.keys(store);
      if (keys.length > 2000) {
        keys
          .sort(function (a, b) {
            return (store[a].t || 0) - (store[b].t || 0);
          })
          .slice(0, keys.length - 2000)
          .forEach(function (old) {
            delete store[old];
          });
      }
      saveJson(KEY_RATING_CACHE, store);
    }, 1500);
  }

  function clearRatingCache() {
    ratingCacheData = {};
    state.ratingLive = {};
    saveJson(KEY_RATING_CACHE, {});
  }

  function fetchRealtimeRating(record) {
    var source = activeSource();
    var key;
    if (record.view !== "movies" && record.view !== "series") {
      return Promise.resolve(0);
    }
    key = ratingCacheKey(record);
    return fetchImdbFreeRating(record).then(function (imdbValue) {
      var url = "";
      if (imdbValue > 0) {
        writeRatingCache(key, imdbValue);
        return imdbValue;
      }
      if (!source || source.type !== "xtream") {
        return 0;
      }
      if (record.view === "movies" && record.streamId) {
        url = xtreamApi(source, "get_vod_info", "&vod_id=" + encodeURIComponent(record.streamId));
      } else if (record.view === "series" && record.seriesId) {
        url = xtreamApi(
          source,
          "get_series_info",
          "&series_id=" + encodeURIComponent(record.seriesId)
        );
      }
      if (!url) {
        return 0;
      }
      return fetchJSON(url).then(
        function (data) {
          var value = extractRealtimeRating(data);
          writeRatingCache(key, value);
          return value;
        },
        function () {
          return 0;
        }
      );
    });
  }

  function queueRealtimeRatings(records) {
    var source = activeSource();
    var fastStartupEnabled = state.settings.fastStartup !== false;
    var maxDuringFastStartup = 8;
    var concurrency = fastStartupEnabled ? 1 : 2;
    if (!source || !records || !records.length) {
      return;
    }
    // Avoid startup stalls on TV: fetch external ratings only in focused media views.
    if (state.view !== "movies" && state.view !== "series") {
      return;
    }
    var now = Date.now();
    var ttl = 30000;
    var tasks = [];
    var dedupe = {};
    Array.prototype.forEach.call(records, function (record) {
      if (!record || (record.view !== "movies" && record.view !== "series")) {
        return;
      }
      if (dedupe[record.uid]) {
        return;
      }
      dedupe[record.uid] = true;
      var live = state.ratingLive[record.uid];
      if (live && now - live.updatedAt < ttl) {
        updateRatingBadgeForUid(record.uid, live.value);
        return;
      }
      var stored = readRatingCache(ratingCacheKey(record));
      if (stored !== null) {
        state.ratingLive[record.uid] = { value: stored, updatedAt: now };
        updateRatingBadgeForUid(record.uid, stored);
        if (record.raw && stored > 0) {
          record.raw.rating_10 = stored;
        }
        return;
      }
      tasks.push(record);
    });
    if (fastStartupEnabled && tasks.length > maxDuringFastStartup) {
      tasks = tasks.slice(0, maxDuringFastStartup);
    }
    if (!tasks.length) {
      return;
    }
    runWithConcurrency(tasks, concurrency, function (record) {
      if (state.ratingFetch[record.uid]) {
        return state.ratingFetch[record.uid];
      }
      state.ratingFetch[record.uid] = fetchRealtimeRating(record).then(
        function (value) {
          delete state.ratingFetch[record.uid];
          state.ratingLive[record.uid] = {
            value: value,
            updatedAt: Date.now()
          };
          updateRatingBadgeForUid(record.uid, value);
          if (record.raw && value > 0) {
            record.raw.rating_10 = value;
          }
        },
        function () {
          delete state.ratingFetch[record.uid];
        }
      );
      return state.ratingFetch[record.uid];
    });
  }

  function clonePlain(value) {
    var out = {};
    var key;
    for (key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== "function") {
        out[key] = value[key];
      }
    }
    return out;
  }

  function showToast(message, success, timeout) {
    var existing = document.getElementById("tvn-toast");
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    var toast = document.createElement("div");
    toast.id = "tvn-toast";
    toast.className = "toast";
    toast.innerHTML =
      '<span class="toast-icon">' +
      (success === false ? "&#9888;" : "&#10004;") +
      "</span><span>" +
      escapeHtml(message) +
      "</span>";
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, timeout || 2200);
  }

  function startSyncProgress(label, total) {
    if (!dom.syncProgress) {
      return;
    }
    dom.syncProgress.className = "sync-progress";
    dom.syncProgressLabel.textContent = label || "Syncing";
    dom.syncProgressCount.textContent = "0 / " + String(total || 0);
    dom.syncProgressFill.style.width = "0%";
  }

  function updateSyncProgress(done, total) {
    if (!dom.syncProgress) {
      return;
    }
    var safeTotal = Math.max(1, total || 1);
    var safeDone = Math.max(0, Math.min(safeTotal, done || 0));
    dom.syncProgressCount.textContent = String(safeDone) + " / " + String(total || 0);
    dom.syncProgressFill.style.width = Math.round((safeDone / safeTotal) * 100) + "%";
  }

  function finishSyncProgress(label) {
    if (!dom.syncProgress) {
      return;
    }
    if (label) {
      dom.syncProgressLabel.textContent = label;
    }
    setTimeout(function () {
      if (dom.syncProgress) {
        dom.syncProgress.className = "sync-progress hidden";
      }
    }, 650);
  }

  function activeSourceCache() {
    var source = activeSource();
    if (!source) {
      return null;
    }
    if (!state.sourceCache[source.id]) {
      var persisted = readPersistedSourceMeta(source.id);
      state.sourceCache[source.id] = {
        categories: { live: [], movies: [], series: [] },
        items: { live: {}, movies: {}, series: {} },
        itemRequests: {},
        counts:
          persisted && persisted.counts
            ? {
                live: clonePlain(persisted.counts.live || {}),
                movies: clonePlain(persisted.counts.movies || {}),
                series: clonePlain(persisted.counts.series || {})
              }
            : { live: {}, movies: {}, series: {} },
        seriesInfo: {},
        recentMovies:
          persisted && persisted.recentMovies ? persisted.recentMovies.slice(0, 20) : [],
        synced:
          persisted && persisted.synced
            ? {
                live: !!persisted.synced.live,
                movies: !!persisted.synced.movies,
                series: !!persisted.synced.series
              }
            : { live: false, movies: false, series: false },
        loadedM3u: false,
        hydrated: false,
        hydratePromise: null
      };
    }
    return state.sourceCache[source.id];
  }

  function ensureCacheSyncState(cache) {
    if (!cache) {
      return;
    }
    if (!cache.synced || typeof cache.synced !== "object") {
      cache.synced = { live: false, movies: false, series: false };
      return;
    }
    cache.synced.live = !!cache.synced.live;
    cache.synced.movies = !!cache.synced.movies;
    cache.synced.series = !!cache.synced.series;
  }

  function isViewSynced(view) {
    var cache = activeSourceCache();
    ensureCacheSyncState(cache);
    return !!(cache && cache.synced && cache.synced[view]);
  }

  function ensureSourceCacheHydrated() {
    var source = activeSource();
    var cache = activeSourceCache();
    if (!source || !cache) {
      return Promise.resolve();
    }
    if (cache.hydrated) {
      return Promise.resolve();
    }
    if (cache.hydratePromise) {
      return cache.hydratePromise;
    }
    cache.hydratePromise = cacheDatabase.loadSource(source.id).then(
      function (saved) {
        if (saved && typeof saved === "object") {
          ensureCacheSyncState(cache);
          cache.categories = saved.categories || cache.categories;
          if (source.type === "m3u") {
            cache.items = saved.items || cache.items;
          }
          cache.counts = saved.counts || cache.counts;
          if (source.type === "m3u") {
            cache.seriesInfo = saved.seriesInfo || cache.seriesInfo;
          }
          cache.loadedM3u = !!saved.loadedM3u;
          if (saved.meta && saved.meta.updatedAt) {
            state.homeSummary.updatedAt.live =
              saved.meta.updatedAt.live || state.homeSummary.updatedAt.live;
            state.homeSummary.updatedAt.movies =
              saved.meta.updatedAt.movies || state.homeSummary.updatedAt.movies;
            state.homeSummary.updatedAt.series =
              saved.meta.updatedAt.series || state.homeSummary.updatedAt.series;
          }
          if (saved.meta && saved.meta.synced) {
            cache.synced = {
              live: !!saved.meta.synced.live,
              movies: !!saved.meta.synced.movies,
              series: !!saved.meta.synced.series
            };
          }
          if (saved.meta && saved.meta.recentMovies) {
            cache.recentMovies = saved.meta.recentMovies.slice(0, 20);
          }
        }
        cache.hydrated = true;
        cache.hydratePromise = null;
      },
      function () {
        cache.hydrated = true;
        cache.hydratePromise = null;
      }
    );
    return cache.hydratePromise;
  }

  function readPersistedCacheBucket() {
    var bucket = loadObject(KEY_CACHE_COUNTS);
    return bucket && typeof bucket === "object" ? bucket : {};
  }

  function readPersistedSourceMeta(sourceId) {
    var bucket = readPersistedCacheBucket();
    return bucket[String(sourceId)] || null;
  }

  function writePersistedSourceMeta(sourceId, meta) {
    var bucket = readPersistedCacheBucket();
    bucket[String(sourceId)] = meta;
    saveJson(KEY_CACHE_COUNTS, bucket);
  }

  function removePersistedSourceMeta(sourceId) {
    var bucket = readPersistedCacheBucket();
    delete bucket[String(sourceId)];
    saveJson(KEY_CACHE_COUNTS, bucket);
  }

  function sumCountMap(map) {
    var total = 0;
    var key;
    map = map || {};
    for (key in map) {
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        var val = parseCountValue(map[key]);
        if (val >= 0) {
          total += val;
        }
      }
    }
    return total;
  }

  function persistActiveCacheCounts() {
    var source = activeSource();
    var cache = activeSourceCache();
    var persistItems;
    var persistSeriesInfo;
    if (!source || !cache) {
      return;
    }
    ensureCacheSyncState(cache);

    if (cachePersistTimers[source.id]) {
      clearTimeout(cachePersistTimers[source.id]);
    }

    // Persisting full Xtream item payloads causes heavy structured-clone work on TV CPUs.
    // Keep the DB payload lean for Xtream and rely on category/count caches for fast dashboards.
    persistItems = source.type === "m3u" ? cache.items : { live: {}, movies: {}, series: {} };
    persistSeriesInfo = source.type === "m3u" ? cache.seriesInfo : {};

    cachePersistTimers[source.id] = setTimeout(function () {
      // Debounced: a synchronous localStorage read+write per category made sync crawl.
      writePersistedSourceMeta(source.id, {
        counts: {
          live: clonePlain(cache.counts.live || {}),
          movies: clonePlain(cache.counts.movies || {}),
          series: clonePlain(cache.counts.series || {})
        },
        synced: {
          live: !!(cache.synced && cache.synced.live),
          movies: !!(cache.synced && cache.synced.movies),
          series: !!(cache.synced && cache.synced.series)
        },
        recentMovies: (cache.recentMovies || []).slice(0, 20),
        updatedAt: {
          live: state.homeSummary.updatedAt.live || 0,
          movies: state.homeSummary.updatedAt.movies || 0,
          series: state.homeSummary.updatedAt.series || 0
        }
      });
      cacheDatabase.saveSource(source.id, {
        categories: cache.categories,
        items: persistItems,
        counts: cache.counts,
        seriesInfo: persistSeriesInfo,
        loadedM3u: cache.loadedM3u,
        meta: {
          updatedAt: {
            live: state.homeSummary.updatedAt.live || 0,
            movies: state.homeSummary.updatedAt.movies || 0,
            series: state.homeSummary.updatedAt.series || 0
          },
          synced: {
            live: !!(cache.synced && cache.synced.live),
            movies: !!(cache.synced && cache.synced.movies),
            series: !!(cache.synced && cache.synced.series)
          },
          recentMovies: (cache.recentMovies || []).slice(0, 20)
        }
      });
      cachePersistTimers[source.id] = null;
    }, 900);
  }

  function hydrateHomeSummaryFromCache() {
    var source = activeSource();
    var cache = activeSourceCache();
    var persisted;
    if (!source || !cache) {
      return;
    }
    persisted = readPersistedSourceMeta(source.id) || {};
    ensureCacheSyncState(cache);
    state.homeSummary.counts.live = sumCountMap(cache.counts.live);
    state.homeSummary.counts.movies = sumCountMap(cache.counts.movies);
    state.homeSummary.counts.series = sumCountMap(cache.counts.series);
    if (source.type === "xtream") {
      if (cache.categories.live && cache.categories.live.length && cache.synced.live !== true) {
        state.homeSummary.counts.live = viewCountFromCategories("live", cache.categories.live);
      }
      if (
        cache.categories.movies &&
        cache.categories.movies.length &&
        cache.synced.movies !== true
      ) {
        state.homeSummary.counts.movies = viewCountFromCategories(
          "movies",
          cache.categories.movies
        );
      }
      if (
        cache.categories.series &&
        cache.categories.series.length &&
        cache.synced.series !== true
      ) {
        state.homeSummary.counts.series = viewCountFromCategories(
          "series",
          cache.categories.series
        );
      }
    }
    state.homeSummary.updatedAt.live = (persisted.updatedAt && persisted.updatedAt.live) || 0;
    state.homeSummary.updatedAt.movies = (persisted.updatedAt && persisted.updatedAt.movies) || 0;
    state.homeSummary.updatedAt.series = (persisted.updatedAt && persisted.updatedAt.series) || 0;
  }

  function setActiveSource(id) {
    state.activeSourceId = id;
    saveSources();
    resetViewState();
    syncSourceButton();
    closeSourceMenu();
    renderCurrentView();
  }

  function resetViewState() {
    state.searchQuery = "";
    dom.search.value = "";
    state.categorySearch.live = "";
    state.categorySearch.movies = "";
    state.categorySearch.series = "";
    state.live.selectedCategoryId = null;
    state.live.items = [];
    state.live.activeUid = null;
    state.live.rendered = 0;
    state.live.epg = [];
    state.movies.selectedCategoryId = null;
    state.movies.items = [];
    state.movies.selectedUid = null;
    state.movies.rendered = 0;
    state.series.selectedCategoryId = null;
    state.series.items = [];
    state.series.selectedUid = null;
    state.series.rendered = 0;
    state.ratingLive = {};
    state.ratingFetch = {};
    state.homeSummary = {
      counts: {
        live: 0,
        movies: 0,
        series: 0
      },
      updatedAt: {
        live: 0,
        movies: 0,
        series: 0
      },
      loading: false,
      sourceId: "",
      recentLoading: false,
      recentLoaded: false,
      recentSourceId: "",
      recentSessionLoaded: state.homeSummary ? !!state.homeSummary.recentSessionLoaded : false
    };
    stopInlinePlayer();
  }

  function syncSourceButton() {
    var source = activeSource();
    dom.sourceMenuBtn.textContent = source ? source.name : "Add source";
  }

  function findSourceById(id) {
    var i;
    for (i = 0; i < state.sources.length; i++) {
      if (state.sources[i].id === id) {
        return state.sources[i];
      }
    }
    return null;
  }

  function clearSourceForm() {
    document.getElementById("src-name").value = "";
    document.getElementById("src-server").value = "";
    document.getElementById("src-user").value = "";
    document.getElementById("src-pass").value = "";
    document.getElementById("m3u-name").value = "";
    document.getElementById("m3u-url").value = "";
    document.getElementById("m3u-user-agent").value = "";
  }

  function fillSourceForm(source) {
    clearSourceForm();
    if (!source) {
      return;
    }
    if (source.type === "xtream") {
      setSourceTab("xtream");
      document.getElementById("src-name").value = source.name || "";
      document.getElementById("src-server").value = source.server || "";
      document.getElementById("src-user").value = source.user || "";
      document.getElementById("src-pass").value = source.pass || "";
    } else {
      setSourceTab("m3u");
      document.getElementById("m3u-name").value = source.name || "";
      document.getElementById("m3u-url").value = source.url || "";
      document.getElementById("m3u-user-agent").value = source.userAgent || "";
    }
  }

  function syncSourceModalMode() {
    var saveBtn = document.getElementById("source-save");
    if (saveBtn) {
      saveBtn.textContent = state.sourceEditId ? "Update Source" : "Save Source";
    }
  }

  function openSourceModal(editSourceId) {
    state.sourceEditId = editSourceId || "";
    if (state.sourceEditId) {
      fillSourceForm(findSourceById(state.sourceEditId));
    } else {
      clearSourceForm();
      setSourceTab(state.sourceTab || "xtream");
    }
    syncSourceModalMode();
    dom.sourceModal.classList.add("open");
    clearSourceError();
    // Longer delay so webOS 3.x spatial nav settles before we claim focus
    setTimeout(function () {
      var first = dom.sourceModal.querySelector(".tab-btn.active, .tab-btn");
      if (first) safeFocus(first);
    }, 300);
  }

  function closeSourceModal() {
    if (!state.sources.length) {
      return;
    }
    state.sourceEditId = "";
    syncSourceModalMode();
    dom.sourceModal.classList.remove("open");
    clearSourceError();
  }

  function showSourceError(message) {
    dom.sourceError.textContent = message;
    dom.sourceError.classList.add("show");
  }

  function clearSourceError() {
    dom.sourceError.textContent = "";
    dom.sourceError.classList.remove("show");
  }

  function setSourceTab(tab) {
    state.sourceTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".tab-btn"), function (btn) {
      if (btn.getAttribute("data-source-tab") === tab) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
    document.getElementById("source-form-xtream").className =
      "source-form-block" + (tab === "xtream" ? " active" : "");
    document.getElementById("source-form-m3u").className =
      "source-form-block" + (tab === "m3u" ? " active" : "");
  }

  function buildSourceObject() {
    var existing = state.sourceEditId ? findSourceById(state.sourceEditId) : null;
    if (state.sourceTab === "xtream") {
      var name = trim(document.getElementById("src-name").value) || "Xtream Source";
      var server = trim(document.getElementById("src-server").value);
      var user = trim(document.getElementById("src-user").value);
      var pass = trim(document.getElementById("src-pass").value);
      if (!server || !user || !pass) {
        throw new Error("Fill in the Xtream server, username and password.");
      }
      return {
        id: existing ? existing.id : makeId(),
        type: "xtream",
        name: name,
        server: server,
        user: user,
        pass: pass
      };
    }
    var m3uName = trim(document.getElementById("m3u-name").value) || "M3U Playlist";
    var m3uUrl = trim(document.getElementById("m3u-url").value);
    var ua = trim(document.getElementById("m3u-user-agent").value);
    if (!m3uUrl) {
      throw new Error("Enter a remote M3U URL.");
    }
    return {
      id: existing ? existing.id : makeId(),
      type: "m3u",
      name: m3uName,
      url: m3uUrl,
      userAgent: ua
    };
  }

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
        if (xhr.readyState !== 4) {
          return;
        }
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
    return fetchText(url).then(function (text) {
      return JSON.parse(text);
    });
  }

  // XHR with arbitrary method, headers, and optional JSON body.
  function xhrJSON(method, url, headers, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.timeout = 15000;
      var k;
      for (k in headers || {}) {
        try {
          xhr.setRequestHeader(k, headers[k]);
        } catch (e) {}
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(new Error("JSON parse error"));
          }
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
      xhr.send(body != null ? JSON.stringify(body) : null);
    });
  }

  function xtreamApi(source, action, extra) {
    var url =
      trim(source.server).replace(/\/+$/, "") +
      "/player_api.php?username=" +
      encodeURIComponent(source.user) +
      "&password=" +
      encodeURIComponent(source.pass);
    if (action) {
      url += "&action=" + action;
    }
    if (extra) {
      url += extra;
    }
    return url;
  }

  function xtreamStreamUrl(source, type, id, ext) {
    var path = type === "live" ? "live" : type === "movies" ? "movie" : "series";
    return (
      trim(source.server).replace(/\/+$/, "") +
      "/" +
      path +
      "/" +
      encodeURIComponent(source.user) +
      "/" +
      encodeURIComponent(source.pass) +
      "/" +
      id +
      "." +
      ext
    );
  }

  function validateSource(source) {
    if (source.type === "xtream") {
      return fetchJSON(xtreamApi(source, "", "")).then(function (data) {
        var auth = data && data.user_info ? data.user_info.auth : 0;
        var validAuth = auth === 1 || auth === "1" || auth === true || auth === "true";
        if (!validAuth) {
          throw new Error("Xtream authentication failed.");
        }
        if (data.user_info && data.user_info.exp_date) {
          source.expiry = String(data.user_info.exp_date);
        }
      });
    }
    return fetchText(source.url, source.userAgent).then(function (text) {
      if (text.indexOf("#EXTM3U") === -1 && text.indexOf("#EXTINF") === -1) {
        throw new Error("That URL did not return a valid M3U playlist.");
      }
    });
  }

  function upsertSource(source) {
    var next = [];
    var updated = false;
    Array.prototype.forEach.call(state.sources, function (entry) {
      if (entry.id === source.id) {
        next.push(source);
        updated = true;
      } else {
        next.push(entry);
      }
    });
    if (!updated) {
      next.push(source);
    }
    state.sources = next;
    state.activeSourceId = source.id;
    cacheDatabase.deleteSource(source.id);
    removePersistedSourceMeta(source.id);
    delete homeCountSyncState[source.id];
    delete state.sourceCache[source.id];
    saveSources();
    resetViewState();
    syncSourceButton();
    renderSourceMenu();
    state.sourceEditId = "";
    syncSourceModalMode();
    closeSourceModal();
    renderCurrentView();
  }

  function deleteSource(sourceId) {
    var next = [];
    Array.prototype.forEach.call(state.sources, function (entry) {
      if (entry.id !== sourceId) {
        next.push(entry);
      }
    });
    state.sources = next;
    delete state.sourceCache[sourceId];
    cacheDatabase.deleteSource(sourceId);
    removePersistedSourceMeta(sourceId);
    delete homeCountSyncState[sourceId];
    if (state.activeSourceId === sourceId) {
      state.activeSourceId = next.length ? next[0].id : "";
    }
    saveSources();
    resetViewState();
    syncSourceButton();
    renderSourceMenu();
    renderCurrentView();
  }

  function renderSourceMenu() {
    var html = "";
    Array.prototype.forEach.call(state.sources, function (source) {
      var accountTypeLabel = source.type === "xtream" ? "Xtream account" : "Playlist account";
      html +=
        '<button class="source-item focusable' +
        (source.id === state.activeSourceId ? " active" : "") +
        '" type="button" tabindex="0" data-source-id="' +
        source.id +
        '">' +
        '<span class="source-item-main">' +
        '<span class="source-title">' +
        escapeHtml(source.name) +
        '</span><span class="source-subline">' +
        escapeHtml(accountTypeLabel) +
        "</span></span></button>";
    });
    if (!html) {
      html = '<div class="status-box"><p>No sources saved.</p></div>';
    }
    dom.sourceMenu.innerHTML = html;
    Array.prototype.forEach.call(
      dom.sourceMenu.querySelectorAll("[data-source-id]"),
      function (btn) {
        btn.addEventListener("click", function () {
          setActiveSource(btn.getAttribute("data-source-id"));
        });
      }
    );
  }

  function openSourceMenu() {
    renderSourceMenu();
    dom.sourceMenu.classList.add("open");
  }

  function closeSourceMenu() {
    dom.sourceMenu.classList.remove("open");
  }

  function parseM3u(text) {
    var lines = String(text || "")
      .replace(/\r/g, "")
      .split("\n");
    var current = null;
    var i;
    var result = {
      categories: { live: [], movies: [], series: [] },
      items: { live: {}, movies: {}, series: {} }
    };
    var seen = { live: {}, movies: {}, series: {} };
    for (i = 0; i < lines.length; i++) {
      var line = trim(lines[i]);
      if (!line) {
        continue;
      }
      if (line.indexOf("#EXTINF:") === 0) {
        current = buildM3uItem(line);
      } else if (line.charAt(0) !== "#" && current) {
        current.url = line;
        var type = classifyM3uItem(current);
        var category =
          current.group ||
          (type === "live" ? "All channels" : type === "movies" ? "All movies" : "All series");
        if (!seen[type][category]) {
          seen[type][category] = true;
          result.categories[type].push({
            category_id: category,
            category_name: category
          });
          result.items[type][category] = [];
        }
        result.items[type][category].push(current);
        current = null;
      }
    }
    if (!result.categories.live.length) {
      result.categories.live = [{ category_id: "All channels", category_name: "All channels" }];
      result.items.live["All channels"] = [];
    }
    return result;
  }

  function buildM3uItem(extinf) {
    var group = readM3uAttr(extinf, "group-title") || "";
    var logo = readM3uAttr(extinf, "tvg-logo") || "";
    var name = extinf.split(",");
    name = name.length ? trim(name[name.length - 1]) : "Channel";
    return {
      name: name,
      title: name,
      group: group,
      stream_icon: logo,
      stream_id: makeId(),
      container_extension: guessExtension(name, "")
    };
  }

  function readM3uAttr(line, attr) {
    var match = line.match(new RegExp(attr + '="([^"]+)"', "i"));
    return match ? match[1] : "";
  }

  function classifyM3uItem(item) {
    var group = (item.group || "").toLowerCase();
    var url = (item.url || "").toLowerCase();
    var name = (item.name || "").toLowerCase();
    if (/series|season|episode/.test(group) || /s\d\de\d\d/.test(name)) {
      return "series";
    }
    if (/movie|vod|film|cinema/.test(group) || /\.(mp4|mkv|avi|mov)(\?|$)/.test(url)) {
      return "movies";
    }
    return "live";
  }

  function guessExtension(name, url) {
    var match = String(url || name || "").match(/\.([a-z0-9]{2,5})(\?|$)/i);
    return match ? match[1] : "mp4";
  }

  function ensureCategories(view, force) {
    var source = activeSource();
    var cache = activeSourceCache();
    if (!source || !cache) {
      return Promise.resolve([]);
    }
    return ensureSourceCacheHydrated().then(function () {
      ensureCacheSyncState(cache);
      if (source.type === "m3u") {
        if (!force && cache.synced[view] !== true) {
          return [];
        }
        if (cache.loadedM3u && !force) {
          return cache.categories[view];
        }
        return fetchText(source.url, source.userAgent).then(function (text) {
          var parsed = parseM3u(text);
          cache.categories = parsed.categories;
          cache.items = parsed.items;
          cache.synced.live = true;
          cache.synced.movies = true;
          cache.synced.series = true;
          cache.loadedM3u = true;
          persistActiveCacheCounts();
          return cache.categories[view];
        });
      }
      if (!force && cache.synced[view] !== true) {
        return [];
      }
      if (cache.categories[view] && cache.categories[view].length && !force) {
        applyCategoryHintCounts(view, cache.categories[view]);
        return cache.categories[view];
      }
      var action =
        view === "live"
          ? "get_live_categories"
          : view === "movies"
            ? "get_vod_categories"
            : "get_series_categories";
      return fetchJSON(xtreamApi(source, action, "")).then(function (data) {
        cache.categories[view] =
          Object.prototype.toString.call(data) === "[object Array]" ? data : [];
        applyCategoryHintCounts(view, cache.categories[view]);
        persistActiveCacheCounts();
        return cache.categories[view];
      });
    });
  }

  function ensureItems(view, categoryId, force) {
    var source = activeSource();
    var cache = activeSourceCache();
    var key = String(categoryId);
    var requestKey = view + ":" + key + (force ? ":refresh" : "");
    if (!source || !cache) {
      return Promise.resolve([]);
    }
    return ensureSourceCacheHydrated().then(function () {
      if (source.type === "m3u") {
        return ensureCategories(view, force).then(function () {
          return cache.items[view][key] || [];
        });
      }
      if (cache.items[view][key] && !force) {
        return cache.items[view][key];
      }
      if (cache.itemRequests && cache.itemRequests[requestKey]) {
        return cache.itemRequests[requestKey];
      }
      var action =
        view === "live" ? "get_live_streams" : view === "movies" ? "get_vod_streams" : "get_series";
      var request = fetchJSON(
        xtreamApi(source, action, "&category_id=" + encodeURIComponent(categoryId))
      ).then(function (data) {
        cache.items[view][key] =
          Object.prototype.toString.call(data) === "[object Array]" ? data : [];
        cache.counts[view][key] = cache.items[view][key].length;
        persistActiveCacheCounts();
        return cache.items[view][key];
      });
      if (!cache.itemRequests) {
        cache.itemRequests = {};
      }
      cache.itemRequests[requestKey] = request;
      return request.then(
        function (items) {
          delete cache.itemRequests[requestKey];
          return items;
        },
        function (err) {
          delete cache.itemRequests[requestKey];
          throw err;
        }
      );
    });
  }

  function buildRecord(view, item, options) {
    var source = activeSource();
    options = options || {};
    var uid =
      source.id +
      ":" +
      view +
      ":" +
      (options.id ||
        item.stream_id ||
        item.series_id ||
        item.id ||
        item.url ||
        item.name ||
        makeId());
    var record = {
      uid: uid,
      sourceId: source.id,
      sourceName: source.name,
      view: view,
      title: item.name || item.title || item.movie_title || options.title || "Untitled",
      subtitle: options.subtitle || item.group || item.genre || "",
      categoryId: options.categoryId || item.category_id || item.group || "",
      poster: item.stream_icon || item.cover || item.cover_big || item.movie_image || "",
      streamId: item.stream_id || null,
      seriesId: item.series_id || null,
      episodeId: item.id || null,
      ext: options.ext || item.container_extension || guessExtension(item.name, item.url || ""),
      playbackUrl: options.playbackUrl || item.url || "",
      raw: clonePlain(item)
    };
    state.recordsByUid[uid] = record;
    return record;
  }

  function playbackUrl(record) {
    var source = activeSource();
    if (record.view === "live") {
      return source.type === "xtream"
        ? xtreamStreamUrl(source, "live", record.streamId, "m3u8")
        : record.playbackUrl;
    }
    if (record.view === "movies") {
      return source.type === "xtream"
        ? xtreamStreamUrl(source, "movies", record.streamId, record.ext || "mp4")
        : record.playbackUrl;
    }
    return record.playbackUrl;
  }

  function moviePlaybackCandidates(record, url) {
    var candidates = [url];
    var source = activeSource();
    var ext = String(record && record.ext || "").toLowerCase();
    if (
      source &&
      source.type === "xtream" &&
      record &&
      record.streamId &&
      ext &&
      ext !== "mp4" &&
      ext !== "webm" &&
      ext !== "ogg" &&
      ext !== "m3u8" &&
      ext !== "ts"
    ) {
      candidates.push(xtreamStreamUrl(source, "movies", record.streamId, "mp4"));
    }
    return candidates;
  }

  function isHlsUrl(url) {
    return /\.m3u8($|\?)/i.test(String(url || ""));
  }

  function canUseNativeHls(video) {
    if (!video || !video.canPlayType) {
      return false;
    }
    return !!(
      video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL")
    );
  }

  // Returns true only if the browser's native video pipeline can decode MPEG-TS.
  // webOS 3.x / LG TVs report "maybe" or "probably". Chrome/Firefox return "".
  // We use this to skip the .ts candidate on desktop browsers so we never feed
  // a live TS stream into video.src on a browser that will stall silently.
  function canBrowserPlayTs() {
    try {
      var v = document.createElement("video");
      if (!v.canPlayType) {
        return false;
      }
      return !!(
        v.canPlayType("video/mp2t") || v.canPlayType('video/mp2t; codecs="avc1.42E01E, mp4a.40.2"')
      );
    } catch (e) {
      return false;
    }
  }

  // Returns a custom Hls.js loader class that rewrites https:// CDN URLs to http://.
  // This works around ERR_SSL_VERSION_OR_CIPHER_MISMATCH errors where the IPTV CDN
  // uses TLS ciphers that modern Chrome has deprecated.
  // Safe on webOS because webOS uses native HLS (video.src) and never invokes Hls.js.
  // Returns true when mpegts.js is loaded AND the browser supports MSE.
  // mpegts.js streams raw MPEG-TS over XHR directly from the origin server,
  // completely bypassing any CDN — and therefore bypassing CDN SSL issues.
  function canUseMpegTs() {
    return !!(window.mpegts && mpegts.isSupported && mpegts.isSupported());
  }

  function createSslFallbackHlsLoader() {
    try {
      var Base =
        window.Hls &&
        Hls.DefaultConfig &&
        typeof Hls.DefaultConfig.loader === "function" &&
        Hls.DefaultConfig.loader;
      if (!Base) {
        return undefined;
      }
      var CdnHttpLoader = function (config) {
        Base.call(this, config);
      };
      CdnHttpLoader.prototype = Object.create(Base.prototype);
      CdnHttpLoader.prototype.constructor = CdnHttpLoader;
      CdnHttpLoader.prototype.load = function (context, config, callbacks) {
        if (context && context.url && /^https:\/\//i.test(context.url)) {
          context.url = context.url.replace(/^https:\/\//i, "http://");
        }
        Base.prototype.load.call(this, context, config, callbacks);
      };
      return CdnHttpLoader;
    } catch (e) {
      return undefined;
    }
  }

  function livePlaybackCandidates(record) {
    var source = activeSource();
    var list = [];
    var seen = {};
    var raw = (record && record.raw) || {};
    var formatPref = state.settings.liveStreamFormat || "default";

    function push(url) {
      var key = trim(url);
      if (!key || seen[key]) {
        return;
      }
      seen[key] = true;
      list.push(key);
    }

    if (!record) {
      return list;
    }

    if (source && source.type === "xtream" && record.streamId) {
      var extHint = String(raw.container_extension || "").toLowerCase();
      // Note: record.ext is intentionally excluded here — for live channels
      // guessExtension() defaults to "mp4" (a VOD extension) which causes
      // spurious 141.mp4 requests that return 405 from Xtream servers.
      // raw.stream_type is also excluded because "live" is a stream type, not
      // a container format.
      var direct = trim(raw.direct_source || raw.direct_url || raw.stream_url || "");
      if (/^https?:\/\//i.test(direct)) {
        push(direct);
      }
      if (formatPref === "ts") {
        if (canBrowserPlayTs()) {
          push(xtreamStreamUrl(source, "live", record.streamId, "ts"));
        }
        // m3u8 is the primary HLS path; .ts via mpegts.js is the CDN-bypass fallback.
        push(xtreamStreamUrl(source, "live", record.streamId, "m3u8"));
        if (!canBrowserPlayTs() && canUseMpegTs()) {
          push(xtreamStreamUrl(source, "live", record.streamId, "ts"));
        }
      } else if (formatPref === "hls") {
        push(xtreamStreamUrl(source, "live", record.streamId, "m3u8"));
        if (canUseMpegTs()) {
          push(xtreamStreamUrl(source, "live", record.streamId, "ts"));
        }
      } else {
        push(xtreamStreamUrl(source, "live", record.streamId, "m3u8"));
        if (extHint && extHint !== "m3u8" && extHint !== "ts" && extHint !== "live") {
          push(xtreamStreamUrl(source, "live", record.streamId, extHint));
        }
        if (canBrowserPlayTs()) {
          push(xtreamStreamUrl(source, "live", record.streamId, "ts"));
        } else if (canUseMpegTs()) {
          push(xtreamStreamUrl(source, "live", record.streamId, "ts"));
        }
      }
    }

    if (!(source && source.type === "xtream" && record.view === "live")) {
      push(playbackUrl(record));
    }
    return list;
  }

  function filtered(items) {
    var query = trim(state.searchQuery).toLowerCase();
    var list = items || [];
    var view = arguments[1] || "";
    if (query && (view === "live" || view === "movies" || view === "series")) {
      list = viewSearchPool(view, list);
    }
    if (!query) {
      return list.slice();
    }
    return list.filter(function (item) {
      var hay = (
        (item.name || item.title || item.movie_title || "") +
        " " +
        (item.group || item.plot || item.description || "")
      ).toLowerCase();
      return hay.indexOf(query) !== -1;
    });
  }

  function itemDedupeKey(item, fallback) {
    return String(
      item.stream_id ||
        item.series_id ||
        item.id ||
        item.url ||
        item.name ||
        item.title ||
        fallback ||
        ""
    );
  }

  // Cheap fingerprint of the cached catalogue: only walks categories, never items.
  function contentSignature() {
    var source = activeSource();
    var cache = activeSourceCache();
    var sig;
    if (!source || !cache) {
      return "";
    }
    sig = source.id;
    Array.prototype.forEach.call(["live", "movies", "series"], function (view) {
      var store = (cache.items && cache.items[view]) || {};
      var keys = Object.keys(store);
      var total = 0;
      var i;
      for (i = 0; i < keys.length; i++) {
        total += (store[keys[i]] || []).length;
      }
      sig += "|" + view + ":" + keys.length + ":" + total;
    });
    return sig;
  }

  var searchPoolCache = { sig: "", pools: {} };

  function viewSearchPool(view, fallbackItems) {
    var sig = contentSignature();
    if (sig && searchPoolCache.sig === sig && searchPoolCache.pools[view]) {
      return searchPoolCache.pools[view];
    }
    var cache = activeSourceCache();
    var store = (cache && cache.items && cache.items[view]) || {};
    var merged = [];
    var seen = {};

    Object.keys(store).forEach(function (categoryId) {
      var list = store[categoryId] || [];
      Array.prototype.forEach.call(list, function (item, index) {
        var key = itemDedupeKey(item, categoryId + ":" + index);
        if (!key || seen[key]) {
          return;
        }
        seen[key] = true;
        merged.push(item);
      });
    });

    Array.prototype.forEach.call(fallbackItems || [], function (item, index) {
      var key = itemDedupeKey(item, "fallback:" + index);
      if (!key || seen[key]) {
        return;
      }
      seen[key] = true;
      merged.push(item);
    });

    if (sig) {
      if (searchPoolCache.sig !== sig) {
        searchPoolCache = { sig: sig, pools: {} };
      }
      searchPoolCache.pools[view] = merged;
    }
    return merged;
  }

  function matchesRecordSearch(record, query) {
    if (!query) {
      return true;
    }
    var hay = (
      (record.title || "") +
      " " +
      (record.subtitle || "") +
      " " +
      (record.sourceName || "")
    ).toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function parseAddedTime(value) {
    if (!value) {
      return 0;
    }
    if (/^\d+$/.test(String(value))) {
      var num = parseInt(value, 10);
      return num > 1000000000 ? num * 1000 : num;
    }
    var parsed = Date.parse(String(value));
    return isNaN(parsed) ? 0 : parsed;
  }

  function recentlyAddedMovies(limit) {
    var cache = activeSourceCache();
    var source = activeSource();
    var merged = [];
    var dedupe = {};
    if (!cache || !source) {
      return [];
    }
    if (cache.recentMovies && cache.recentMovies.length) {
      return cache.recentMovies.slice(0, limit || 20);
    }
    Object.keys(cache.items.movies || {}).forEach(function (categoryId) {
      var list = cache.items.movies[categoryId] || [];
      Array.prototype.forEach.call(list, function (item) {
        var key = String(item.stream_id || item.id || item.name || "");
        if (!key || dedupe[key]) {
          return;
        }
        dedupe[key] = true;
        var record = buildRecord("movies", item, {
          subtitle: buildMetaLine(item),
          categoryId: categoryId
        });
        record._addedAt = parseAddedTime(item.added || item.release_date || item.releasedate);
        merged.push(record);
      });
    });
    merged.sort(function (a, b) {
      return (b._addedAt || 0) - (a._addedAt || 0);
    });
    cache.recentMovies = merged.slice(0, 20);
    return cache.recentMovies.slice(0, limit || 20);
  }

  function refreshRecentMoviesCache() {
    var cache = activeSourceCache();
    if (!cache) {
      return [];
    }
    cache.recentMovies = [];
    return recentlyAddedMovies(20);
  }

  function currentCategoryName(categories, categoryId) {
    var i;
    for (i = 0; i < categories.length; i++) {
      if (String(categories[i].category_id) === String(categoryId)) {
        return categories[i].category_name || "Category";
      }
    }
    return "Category";
  }

  // Looks up the category name for a record using the cached categories for its view.
  function recordCategoryName(record) {
    if (!record || !record.categoryId) return "";
    var cache = activeSourceCache();
    var cats = (cache && cache.categories && cache.categories[record.view]) || [];
    for (var i = 0; i < cats.length; i++) {
      if (String(cats[i].category_id) === String(record.categoryId)) {
        return cats[i].category_name || "";
      }
    }
    return "";
  }

  function filteredCategoriesForView(view, categories) {
    var query = trim((state.categorySearch && state.categorySearch[view]) || "").toLowerCase();
    var list = categories || [];
    if (!ENABLE_CATEGORY_SEARCH) {
      return list.slice();
    }
    if (!query) {
      return list.slice();
    }
    return list.filter(function (category) {
      return (
        String(category.category_name || "")
          .toLowerCase()
          .indexOf(query) !== -1
      );
    });
  }

  function syncSearchPlaceholder() {
    if (dom.search) {
      dom.search.placeholder = "Search Movies, Live and Series...";
    }
  }

  function renderCurrentView() {
    setRail(state.view);
    syncSearchPlaceholder();
    if (!activeSource() && state.view !== "settings") {
      renderNoSource();
      return;
    }
    if (state.view === "home") {
      var homeQuery = trim(state.searchQuery).toLowerCase();
      if (homeQuery && homeQuery !== state.homeSearch.lastQuery) {
        triggerHomeSearch();
      } else {
        renderHome();
      }
    } else if (state.view === "live") {
      renderLive();
    } else if (state.view === "movies") {
      renderMovies();
    } else if (state.view === "series") {
      renderSeries();
    } else if (state.view === "favorites") {
      renderFavoritesSections();
    } else if (state.view === "history") {
      renderCollection("History", state.history);
    } else {
      renderSettings();
    }
  }

  function renderNoSource() {
    dom.workspace.innerHTML =
      '<div class="empty-state"><h2>No source selected</h2><p>Add an Xtream or M3U source to begin.</p><button id="empty-add" class="btn primary focusable" type="button" tabindex="0">Add source</button></div>';
    document.getElementById("empty-add").addEventListener("click", openSourceModal);
    focusFirst("#empty-add");
  }

  function heroPanel(title, text) {
    return (
      '<div class="hero-panel"><h2>' +
      escapeHtml(title) +
      "</h2><p>" +
      escapeHtml(text) +
      "</p></div>"
    );
  }

  function statCard(label, value) {
    return (
      '<div class="stat-card"><div class="muted">' +
      escapeHtml(label) +
      '</div><div class="stat-value">' +
      escapeHtml(value) +
      "</div></div>"
    );
  }

  function continueItems() {
    var list = [];
    var key;
    for (key in state.positions) {
      if (
        Object.prototype.hasOwnProperty.call(state.positions, key) &&
        state.positions[key].record
      ) {
        var record = clonePlain(state.positions[key].record);
        record._resume = state.positions[key];
        list.push(record);
      }
    }
    list.sort(function (a, b) {
      return b._resume.updatedAt - a._resume.updatedAt;
    });
    return list.slice(0, 300);
  }

  function posterCard(record) {
    var subtitle = record._resume
      ? formatTime(record._resume.currentTime) + " / " + formatTime(record._resume.duration)
      : trim(record.subtitle || "");
    var hasTitleOverlay =
      record.view === "movies" || record.view === "series" || record.view === "episode";
    var badges = "";
    if (isFavorite(record.uid)) {
      badges += '<span class="poster-badge poster-badge--favorite">★</span>';
    }
    if (record._resume || state.positions[record.uid]) {
      badges += '<span class="poster-badge poster-badge--resume">Resume</span>';
    }
    var rating = ratingBadgeValue(record, record.raw || {});
    if (rating > 0) {
      badges +=
        '<span class="poster-badge poster-badge--rating">★ ' + rating.toFixed(1) + "</span>";
    }
    state.recordsByUid[record.uid] = record;
    var posterClass =
      "poster-card focusable" +
      (record.view === "live" ? " poster-card--live" : "") +
      (hasTitleOverlay ? " poster-card--title-overlay" : "");
    return (
      '<button class="' +
      posterClass +
      '" type="button" tabindex="0" data-record-uid="' +
      escapeHtml(record.uid) +
      '">' +
      '<div class="poster">' +
      badges +
      (record.poster
        ? '<img src="' +
          encodeAttr(safeImgUrl(record.poster)) +
          '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />'
        : "") +
      (hasTitleOverlay
        ? '<div class="poster-title-overlay">' + escapeHtml(record.title) + "</div></div></button>"
        : '</div><div class="poster-body"><div class="poster-title">' +
          escapeHtml(record.title) +
          "</div>" +
          (subtitle ? '<div class="poster-meta">' + escapeHtml(subtitle) + "</div>" : "") +
          "</div></button>")
    );
  }

  function bindRecordButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll("[data-record-uid]"), function (btn) {
      btn.addEventListener("click", function () {
        var record = state.recordsByUid[btn.getAttribute("data-record-uid")];
        if (record) {
          openRecord(record);
        }
      });
    });
  }

  function shelfArrowNav(direction) {
    var active = document.activeElement;
    if (!active) {
      return false;
    }
    var row = active.closest(".shelf-row, .episode-row");
    if (!row) {
      return false;
    }
    var cards = row.querySelectorAll("[data-record-uid]");
    if (!cards.length) {
      return false;
    }
    var index = Array.prototype.indexOf.call(cards, active);
    if (index < 0) {
      return false;
    }
    var next = direction === "right" ? index + 1 : index - 1;
    if (next < 0) {
      // Let the global focus router handle rail jump from the first card.
      return false;
    }
    if (next >= cards.length) {
      return true;
    }
    focusNode(cards[next]);
    return true;
  }

  function buildShelf(title, records) {
    return buildShelfWithMessage(title, records, "No items yet.");
  }

  function buildShelfWithMessage(title, records, emptyMessage) {
    var html =
      '<div class="shelf"><div class="shelf-head"><div class="section-title">' +
      escapeHtml(title) +
      '</div><div class="section-count">' +
      records.length +
      "</div></div>";
    if (!records.length) {
      return (
        html +
        '<div class="status-box"><p>' +
        escapeHtml(emptyMessage || "No items yet.") +
        "</p></div></div>"
      );
    }
    html += '<div class="shelf-row">';
    Array.prototype.forEach.call(records, function (record) {
      html += posterCard(record);
    });
    html += "</div></div>";
    return html;
  }

  function homeClockTime() {
    var now = new Date();
    var hours = now.getHours();
    var meridian = hours >= 12 ? "PM" : "AM";
    var hour12 = hours % 12;
    if (hour12 === 0) {
      hour12 = 12;
    }
    return pad(hour12) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()) + " " + meridian;
  }

  function homeClockDate() {
    var now = new Date();
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (
      days[now.getDay()] +
      ", " +
      now.getDate() +
      " " +
      months[now.getMonth()] +
      " " +
      now.getFullYear()
    );
  }

  // Fetches user_info for existing Xtream sources that don't yet have expiry stored.
  function ensureXtreamExpiry(source) {
    if (!source || source.type !== "xtream" || source.expiry) return;
    fetchJSON(xtreamApi(source, "", "")).then(
      function (data) {
        if (data && data.user_info && data.user_info.exp_date) {
          source.expiry = String(data.user_info.exp_date);
          saveSources();
          var node = document.getElementById("home-expiry-value");
          if (node) node.textContent = formatExpiryDate(source.expiry);
        }
      },
      function () {}
    );
  }

  function formatExpiryDate(ts) {
    if (!ts) return "";
    var t = parseInt(ts, 10);
    if (!t || isNaN(t)) return "";
    var d = new Date(t * 1000);
    if (isNaN(d.getTime())) return "";
    var months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];
    return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
  }

  // Fetches user_info for existing Xtream sources that don't yet have expiry stored.
  function ensureXtreamExpiry(source) {
    if (!source || source.type !== "xtream" || source.expiry) return;
    fetchJSON(xtreamApi(source, "", "")).then(
      function (data) {
        if (data && data.user_info && data.user_info.exp_date) {
          source.expiry = String(data.user_info.exp_date);
          saveSources();
          var node = document.getElementById("home-expiry-value");
          if (node) node.textContent = formatExpiryDate(source.expiry);
        }
      },
      function () {}
    );
  }

  function formatLastUpdateLabel(value) {
    var diff;
    var minutes;
    var hours;
    var days;
    if (!value) {
      return "Last Update: not updated";
    }
    diff = Math.max(0, Date.now() - value);
    minutes = Math.floor(diff / 60000);
    if (minutes < 1) {
      return "Last Update: just now";
    }
    if (minutes < 60) {
      return "Last Update: " + String(minutes) + " minute" + (minutes === 1 ? "" : "s") + " ago";
    }
    hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return "Last Update: " + String(hours) + " hour" + (hours === 1 ? "" : "s") + " ago";
    }
    days = Math.floor(hours / 24);
    return "Last Update: " + String(days) + " day" + (days === 1 ? "" : "s") + " ago";
  }

  function homeCategoryIcon(view) {
    if (view === "live") {
      return "▶";
    }
    if (view === "movies") {
      return "▣";
    }
    return (
      '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<rect x="4" y="5" width="16" height="3" rx="1"></rect>' +
      '<rect x="4" y="10.5" width="16" height="3" rx="1"></rect>' +
      '<rect x="4" y="16" width="16" height="3" rx="1"></rect>' +
      "</svg>"
    );
  }

  function refreshIconSvg(extraClass) {
    var iconClass = "icon-svg icon-refresh";
    if (extraClass) {
      iconClass += " " + extraClass;
    }
    return (
      '<svg class="' +
      iconClass +
      '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M20 12a8 8 0 1 1-2.35-5.65"></path>' +
      '<path d="M20 4v6h-6"></path>' +
      "</svg>"
    );
  }

  function mediaControlIconSvg(name, solid) {
    var cls = "icon-svg" + (solid ? " icon-solid" : "");
    if (name === "prev") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M18 6L9 12l9 6V6z"></path>' +
        '<path d="M6 6v12"></path>' +
        "</svg>"
      );
    }
    if (name === "next") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M6 6l9 6-9 6V6z"></path>' +
        '<path d="M18 6v12"></path>' +
        "</svg>"
      );
    }
    if (name === "rew") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M19 6l-7 6 7 6V6z"></path>' +
        '<path d="M12 6L5 12l7 6V6z"></path>' +
        "</svg>"
      );
    }
    if (name === "fwd") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M5 6l7 6-7 6V6z"></path>' +
        '<path d="M12 6l7 6-7 6V6z"></path>' +
        "</svg>"
      );
    }
    if (name === "fullscreen") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M8 3H3v5"></path>' +
        '<path d="M16 3h5v5"></path>' +
        '<path d="M21 16v5h-5"></path>' +
        '<path d="M3 16v5h5"></path>' +
        "</svg>"
      );
    }
    if (name === "close") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M6 6l12 12"></path>' +
        '<path d="M18 6L6 18"></path>' +
        "</svg>"
      );
    }
    if (name === "pause") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<rect x="6" y="5" width="4" height="14" rx="1"></rect>' +
        '<rect x="14" y="5" width="4" height="14" rx="1"></rect>' +
        "</svg>"
      );
    }
    if (name === "play") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M8 5l11 7-11 7V5z"></path>' +
        "</svg>"
      );
    }
    if (name === "favorite") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M12 3.5l2.6 5.2 5.8.8-4.2 4.1 1 5.8L12 16.9 6.8 19.4l1-5.8L3.6 9.5l5.8-.8L12 3.5z"></path>' +
        "</svg>"
      );
    }
    if (name === "back") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M19 12H5"></path>' +
        '<path d="M11 6l-6 6 6 6"></path>' +
        "</svg>"
      );
    }
    if (name === "plus") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M12 5v14"></path>' +
        '<path d="M5 12h14"></path>' +
        "</svg>"
      );
    }
    if (name === "film") {
      return (
        '<svg class="' +
        cls +
        '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<rect x="3" y="5" width="18" height="14" rx="2"></rect>' +
        '<path d="M3 10h18"></path>' +
        '<path d="M8 5v5"></path>' +
        '<path d="M16 5v5"></path>' +
        "</svg>"
      );
    }
    return "";
  }

  function setOverlayFavoriteButton(isOn) {
    if (!dom.overlayFavorite) {
      return;
    }
    dom.overlayFavorite.innerHTML = mediaControlIconSvg("favorite", !!isOn);
    dom.overlayFavorite.setAttribute("title", isOn ? "Favorite: on" : "Favorite");
  }

  function syncOverlayControlIcons() {
    if (dom.overlayPrev) {
      dom.overlayPrev.innerHTML = mediaControlIconSvg("prev");
    }
    if (dom.overlayRew) {
      dom.overlayRew.innerHTML = mediaControlIconSvg("rew");
    }
    if (dom.overlayFwd) {
      dom.overlayFwd.innerHTML = mediaControlIconSvg("fwd");
    }
    if (dom.overlayFullscreenBtn) {
      dom.overlayFullscreenBtn.innerHTML = mediaControlIconSvg("fullscreen");
    }
    if (dom.overlayNext) {
      dom.overlayNext.innerHTML = mediaControlIconSvg("next");
    }
    if (dom.overlayClose) {
      dom.overlayClose.innerHTML = mediaControlIconSvg("close");
    }
  }

  function parseCountValue(value) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) && parsed >= 0 ? parsed : -1;
  }

  function categoryCountFromCache(view, categoryId) {
    var cache = activeSourceCache();
    var key = String(categoryId);
    var cached;
    if (cache && cache.counts && cache.counts[view]) {
      cached = parseCountValue(cache.counts[view][key]);
      if (cached >= 0) {
        return cached;
      }
    }
    if (cache && cache.items && cache.items[view] && cache.items[view][key]) {
      cached = cache.items[view][key].length;
      if (cache && cache.counts && cache.counts[view]) {
        cache.counts[view][key] = cached;
      }
      return cached;
    }
    return -1;
  }

  function viewCountFromCategories(view, categories) {
    var cache = activeSourceCache();
    var total = 0;
    Array.prototype.forEach.call(categories || [], function (category) {
      var catId = String(category.category_id);
      var hinted = parseCountValue(category.stream_count || category.count);
      if (hinted >= 0) {
        total += hinted;
        if (cache && cache.counts && cache.counts[view]) {
          cache.counts[view][catId] = hinted;
        }
        return;
      }
      var cached = categoryCountFromCache(view, catId);
      if (cached >= 0) {
        total += cached;
      }
    });
    return total;
  }

  function categoryHintForView(view, categoryId) {
    var cache = activeSourceCache();
    var categories = (cache && cache.categories && cache.categories[view]) || [];
    var key = String(categoryId);
    var i;
    for (i = 0; i < categories.length; i += 1) {
      if (String(categories[i].category_id) === key) {
        return parseCountValue(categories[i].stream_count || categories[i].count);
      }
    }
    return -1;
  }

  function applyCategoryHintCounts(view, categories) {
    var source = activeSource();
    if (!source || source.type !== "xtream") {
      return;
    }
    state.homeSummary.counts[view] = viewCountFromCategories(view, categories);
    persistActiveCacheCounts();
  }

  function refreshHomeSummaryCount(view, updatedAt) {
    var cache = activeSourceCache();
    if (!cache || !cache.counts || !cache.counts[view]) {
      return;
    }
    state.homeSummary.counts[view] = sumCountMap(cache.counts[view]);
    if (updatedAt) {
      state.homeSummary.updatedAt[view] = updatedAt;
    }
  }

  function warmRecentAddedMovies(force) {
    var source = activeSource();
    var alreadyCached;
    var fastStartupEnabled = state.settings.fastStartup !== false;
    var warmLimit = force || !fastStartupEnabled ? 0 : 8;
    var warmConcurrency = force || !fastStartupEnabled ? 4 : 2;
    if (!source || state.homeSummary.recentLoading) {
      return;
    }
    if (!force && state.homeSummary.recentSessionLoaded) {
      return;
    }
    if (
      !force &&
      state.homeSummary.recentLoaded &&
      state.homeSummary.recentSourceId === source.id
    ) {
      return;
    }
    alreadyCached = recentlyAddedMovies(1).length > 0;
    if (!force && alreadyCached) {
      state.homeSummary.recentLoaded = true;
      state.homeSummary.recentSessionLoaded = true;
      return;
    }
    state.homeSummary.recentLoading = true;
    state.homeSummary.recentSessionLoaded = true;
    state.homeSummary.recentLoaded = false;
    state.homeSummary.recentSourceId = source.id;
    ensureCategories("movies")
      .then(
        function (categories) {
          var all = categories || [];
          var list = all.slice();
          if (warmLimit > 0 && list.length > warmLimit) {
            list = list.slice(0, warmLimit);
          }
          return runWithConcurrency(list, warmConcurrency, function (category) {
            return ensureItems("movies", String(category.category_id)).then(function () {});
          });
        },
        function () {}
      )
      .then(
        function () {
          state.homeSummary.recentLoading = false;
          state.homeSummary.recentLoaded = true;
          if (state.view === "home" && !trim(state.searchQuery)) {
            renderHome();
          }
        },
        function () {
          state.homeSummary.recentLoading = false;
          state.homeSummary.recentLoaded = false;
        }
      );
  }

  function scheduleWarmRecentAddedMovies() {
    if (state.settings.fastStartup === false) {
      warmRecentAddedMovies(false);
      return;
    }
    if (recentWarmTimer) {
      clearTimeout(recentWarmTimer);
    }
    recentWarmTimer = setTimeout(function () {
      recentWarmTimer = null;
      warmRecentAddedMovies(false);
    }, 1200);
  }

  function warmHomeCountsFromCategories() {
    var source = activeSource();
    var views = ["live", "movies", "series"];
    var changed = false;
    if (!source || source.type !== "xtream") {
      return;
    }
    if (homeCountSyncState[source.id] === "running" || homeCountSyncState[source.id] === "done") {
      return;
    }
    homeCountSyncState[source.id] = "running";
    Promise.all(
      views.map(function (view) {
        return ensureCategories(view).then(
          function (categories) {
            var total = viewCountFromCategories(view, categories || []);
            if (state.homeSummary.counts[view] !== total) {
              state.homeSummary.counts[view] = total;
              changed = true;
            }
          },
          function () {}
        );
      })
    ).then(
      function () {
        homeCountSyncState[source.id] = "done";
        if (!changed) {
          return;
        }
        persistActiveCacheCounts();
        if (state.view === "home" && !trim(state.searchQuery)) {
          renderHome();
        }
      },
      function () {
        homeCountSyncState[source.id] = "";
      }
    );
  }

  function refreshHomeSection(view) {
    var source = activeSource();
    var labelView;
    var cache;
    if (!source) {
      return Promise.resolve();
    }
    if (view !== "live" && view !== "movies" && view !== "series") {
      return Promise.resolve();
    }
    if (state.homeSummary.loading) {
      return Promise.resolve();
    }
    state.homeSummary.loading = true;
    state.homeSummary.sourceId = source.id;
    labelView = view.charAt(0).toUpperCase() + view.slice(1);
    cache = activeSourceCache();
    ensureCacheSyncState(cache);

    return ensureCategories(view, true)
      .then(function (categories) {
        var totalByView = 0;
        var tasks = [];

        Array.prototype.forEach.call(categories || [], function (cat) {
          tasks.push({ view: view, categoryId: String(cat.category_id) });
        });

        if (cache) {
          cache.items[view] = {};
          cache.counts[view] = {};
          if (view === "movies") {
            cache.recentMovies = [];
          }
          if (view === "series") {
            cache.seriesInfo = {};
          }
          cache.synced[view] = false;
        }

        if (!tasks.length) {
          state.homeSummary.counts[view] = 0;
          state.homeSummary.updatedAt[view] = Date.now();
          if (cache && cache.synced) {
            cache.synced[view] = true;
          }
          syncHomeTopCard(view);
          persistActiveCacheCounts();
          return;
        }

        if (view === "movies") {
          state.homeSummary.recentLoading = true;
        }
        startSyncProgress("Refreshing " + labelView, tasks.length);
        var done = 0;
        return runWithConcurrency(tasks, SYNC_CONCURRENCY, function (task) {
          return ensureItems(task.view, task.categoryId, true).then(
            function (items) {
              var count = (items || []).length;
              var activeCache = activeSourceCache();
              if (
                activeCache &&
                activeCache.counts &&
                activeCache.counts[task.view] &&
                activeCache.counts[task.view][task.categoryId] !== count
              ) {
                activeCache.counts[task.view][task.categoryId] = count;
              }
              totalByView += count;
              done += 1;
              updateSyncProgress(done, tasks.length);
            },
            function () {
              done += 1;
              updateSyncProgress(done, tasks.length);
            }
          );
        }).then(function () {
          finishSyncProgress("Refresh complete");
          state.homeSummary.counts[view] = totalByView;
          state.homeSummary.updatedAt[view] = Date.now();
          if (cache && cache.synced) {
            cache.synced[view] = true;
          }
          syncHomeTopCard(view);
          persistActiveCacheCounts();
          state.homeSummary.recentLoaded = true;
          state.homeSummary.recentSourceId = source.id;
          state.homeSummary.recentSessionLoaded = true;
          state.homeSummary.recentLoading = false;
        });
      })
      .then(
        function () {
          state.homeSummary.loading = false;
          if (state.view === "home" && !trim(state.searchQuery)) {
            renderHome();
          }
        },
        function () {
          state.homeSummary.loading = false;
          state.homeSummary.recentLoading = false;
          finishSyncProgress("Refresh complete");
          if (state.view === "home" && !trim(state.searchQuery)) {
            renderHome();
          }
        }
      );
  }

  function buildHomeTopCards() {
    var countLive = String(state.homeSummary.counts.live || 0);
    var countMovies = String(state.homeSummary.counts.movies || 0);
    var countSeries = String(state.homeSummary.counts.series || 0);
    var liveUpdate = formatLastUpdateLabel(state.homeSummary.updatedAt.live);
    var moviesUpdate = formatLastUpdateLabel(state.homeSummary.updatedAt.movies);
    var seriesUpdate = formatLastUpdateLabel(state.homeSummary.updatedAt.series);
    var src = activeSource();
    var expiryText = src && src.expiry ? formatExpiryDate(src.expiry) : "";
    var expiryHtml =
      src && src.type === "xtream"
        ? '<div class="home-top-expiry"><span class="home-top-expiry-label">Expires</span>' +
          '<span class="home-top-expiry-value" id="home-expiry-value">' +
          escapeHtml(expiryText || "—") +
          "</span></div>"
        : "";
    return (
      '<div class="home-top-shell">' +
      '<div class="home-top-head"><div class="home-top-head-title">Dashboard</div>' +
      expiryHtml +
      "</div>" +
      '<div class="home-top-grid">' +
      '<div class="home-top-card"><button class="home-top-open focusable" type="button" tabindex="0" data-home-open="live"><span class="home-top-icon home-top-icon-right" aria-hidden="true">' +
      homeCategoryIcon("live") +
      '</span><div class="home-top-title">LIVE</div><div class="home-top-count" data-home-count="live">' +
      escapeHtml(countLive) +
      '</div><div class="home-top-meta" data-home-updated="live"><span class="home-top-meta-ic" aria-hidden="true">' +
      refreshIconSvg("icon-refresh-xs") +
      "</span>" +
      escapeHtml(liveUpdate) +
      '</div></button><button class="home-top-refresh btn focusable" type="button" tabindex="0" data-home-refresh="live">' +
      refreshIconSvg("icon-refresh-sm") +
      "</button></div>" +
      '<div class="home-top-card"><button class="home-top-open focusable" type="button" tabindex="0" data-home-open="movies"><span class="home-top-icon home-top-icon-right" aria-hidden="true">' +
      homeCategoryIcon("movies") +
      '</span><div class="home-top-title">MOVIES</div><div class="home-top-count" data-home-count="movies">' +
      escapeHtml(countMovies) +
      '</div><div class="home-top-meta" data-home-updated="movies"><span class="home-top-meta-ic" aria-hidden="true">' +
      refreshIconSvg("icon-refresh-xs") +
      "</span>" +
      escapeHtml(moviesUpdate) +
      '</div></button><button class="home-top-refresh btn focusable" type="button" tabindex="0" data-home-refresh="movies">' +
      refreshIconSvg("icon-refresh-sm") +
      "</button></div>" +
      '<div class="home-top-card"><button class="home-top-open focusable" type="button" tabindex="0" data-home-open="series"><span class="home-top-icon home-top-icon-right" aria-hidden="true">' +
      homeCategoryIcon("series") +
      '</span><div class="home-top-title">SERIES</div><div class="home-top-count" data-home-count="series">' +
      escapeHtml(countSeries) +
      '</div><div class="home-top-meta" data-home-updated="series"><span class="home-top-meta-ic" aria-hidden="true">' +
      refreshIconSvg("icon-refresh-xs") +
      "</span>" +
      escapeHtml(seriesUpdate) +
      '</div></button><button class="home-top-refresh btn focusable" type="button" tabindex="0" data-home-refresh="series">' +
      refreshIconSvg("icon-refresh-sm") +
      "</button></div>" +
      "</div></div>"
    );
  }

  function syncHomeTopCard(view) {
    var countNode;
    var metaNode;
    if (state.view !== "home" || trim(state.searchQuery)) {
      return;
    }
    countNode = document.querySelector('[data-home-count="' + view + '"]');
    metaNode = document.querySelector('[data-home-updated="' + view + '"]');
    if (countNode) {
      countNode.textContent = String(state.homeSummary.counts[view] || 0);
    }
    if (metaNode) {
      metaNode.innerHTML =
        '<span class="home-top-meta-ic" aria-hidden="true">' +
        refreshIconSvg("icon-refresh-xs") +
        "</span>" +
        escapeHtml(formatLastUpdateLabel(state.homeSummary.updatedAt[view]));
    }
  }

  function updateHomeClockDisplay() {
    var timeNode = document.getElementById("home-time-value");
    var dateNode = document.getElementById("home-date-value");
    var topbarTimeNode = dom.topbarTime;
    var topbarDateNode = dom.topbarDate;
    var nowTime = homeClockTime();
    var nowDate = homeClockDate();
    if (timeNode) {
      timeNode.textContent = nowTime;
    }
    if (dateNode) {
      dateNode.textContent = nowDate;
    }
    if (topbarTimeNode) {
      topbarTimeNode.textContent = nowTime;
    }
    if (topbarDateNode) {
      topbarDateNode.textContent = nowDate;
    }
  }

  function startAppClockTicker() {
    updateHomeClockDisplay();
    if (appClockTimer) {
      clearInterval(appClockTimer);
    }
    appClockTimer = setInterval(function () {
      updateHomeClockDisplay();
    }, 1000);
  }

  function bindHomeTopCards() {
    Array.prototype.forEach.call(
      dom.workspace.querySelectorAll("[data-home-open]"),
      function (btn) {
        btn.addEventListener("click", function () {
          state.view = btn.getAttribute("data-home-open");
          renderCurrentView();
        });
      }
    );
    Array.prototype.forEach.call(
      dom.workspace.querySelectorAll("[data-home-refresh]"),
      function (btn) {
        btn.addEventListener("click", function () {
          var view = btn.getAttribute("data-home-refresh");
          refreshHomeSection(view);
        });
      }
    );
  }

  function renderHome() {
    var query = trim(state.searchQuery).toLowerCase();
    var source = activeSource();
    ensureXtreamExpiry(source);
    var moviesSynced = isViewSynced("movies");
    var recentList = state.history.slice(0, 10);
    var continueList = continueItems().slice(0, 10);
    var recentAddedList = recentlyAddedMovies(12);
    var html = '<div class="home-wrap">';

    if (query) {
      var searchResults = state.homeSearch.results || [];
      var shown = searchResults.slice(0, HOME_SEARCH_RENDER_LIMIT);
      // Keep the user's place while results stream in and the grid is re-rendered.
      var focusedUid =
        document.activeElement && document.activeElement.getAttribute
          ? document.activeElement.getAttribute("data-record-uid")
          : null;
      html +=
        '<div class="shelf"><div class="shelf-head"><div class="section-title">Search results' +
        (state.homeSearch.loading ? " (searching…)" : "") +
        '</div><div class="section-count">' +
        searchResults.length +
        "</div></div>";
      if (!shown.length) {
        html +=
          '<div class="status-box" style="height:220px;"><p>' +
          (state.homeSearch.loading
            ? 'Searching for "' + escapeHtml(query) + '"…'
            : "No matches found.") +
          "</p></div>";
      } else {
        html += '<div class="grid-wrap">';
        Array.prototype.forEach.call(shown, function (record) {
          html += posterCard(record);
        });
        html += "</div>";
      }
      html += "</div></div>";
      dom.workspace.innerHTML = html;
      bindRecordButtons(dom.workspace);
      if (!state.homeSearch.loading) {
        queueRealtimeRatings(shown);
      }
      var restore = focusedUid
        ? dom.workspace.querySelector('[data-record-uid="' + focusedUid + '"]')
        : null;
      if (restore) {
        safeFocus(restore);
      } else if (!state.homeSearch.focused && shown.length) {
        state.homeSearch.focused = true;
        focusFirst(".poster-card");
      }
      return;
    }

    if (source && state.homeSummary.sourceId !== source.id) {
      state.homeSummary.sourceId = source.id;
      hydrateHomeSummaryFromCache();
      state.homeSummary.recentLoading = false;
      state.homeSummary.recentLoaded = false;
      state.homeSummary.recentSourceId = source.id;
      ensureSourceCacheHydrated().then(function () {
        hydrateHomeSummaryFromCache();
        if (state.view === "home" && !trim(state.searchQuery)) {
          renderHome();
        }
      });
    }

    warmHomeCountsFromCategories();

    html += buildHomeTopCards();

    html += buildShelf("Recently watched", recentList);
    html += buildShelf("Continue watching", continueList);
    html += buildShelfWithMessage(
      "Recently added Movies",
      recentAddedList,
      state.homeSummary.recentLoading
        ? "Loading...."
        : moviesSynced
          ? "No items yet."
          : "Sync Movies on Dashboard to load items."
    );
    html += "</div>";
    dom.workspace.innerHTML = html;
    bindHomeTopCards();
    updateHomeClockDisplay();
    bindRecordButtons(dom.workspace);
    queueRealtimeRatings(recentList.concat(continueList, recentAddedList));
    focusFirst(".poster-card");
  }

  // scrollIntoView({block:"nearest"}) requires Chrome 60+; webOS 3.x ignores options
  // and scrolls to top. This replicates "nearest" using getBoundingClientRect.
  function scrollIntoViewNearest(el, container) {
    if (!el || !container) return;
    try {
      var er = el.getBoundingClientRect();
      var cr = container.getBoundingClientRect();
      if (er.top < cr.top) {
        container.scrollTop -= cr.top - er.top + 4;
      } else if (er.bottom > cr.bottom) {
        container.scrollTop += er.bottom - cr.bottom + 4;
      }
    } catch (e) {}
  }

  function renderCategories(containerId, categories, activeId, onSelect) {
    var html = "";
    Array.prototype.forEach.call(categories, function (category) {
      var catId = String(category.category_id);
      var count = category.stream_count || category.count || "…";
      html +=
        '<button class="category-btn focusable' +
        (catId === String(activeId) ? " active" : "") +
        '" type="button" tabindex="0" data-category-id="' +
        escapeHtml(catId) +
        '"><span class="category-label">' +
        escapeHtml(category.category_name || "Untitled") +
        '</span><span class="category-count">' +
        escapeHtml(String(count)) +
        "</span>" +
        "</button>";
    });
    var container = document.getElementById(containerId);
    var activeBtn = null;
    var scrollPane = container.parentNode;
    while (scrollPane && scrollPane.scrollHeight <= scrollPane.clientHeight) {
      scrollPane = scrollPane.parentNode;
    }
    // Use state-persisted scroll if available (the DOM was rebuilt so scrollPane.scrollTop is 0)
    var savedScroll = 0;
    if (containerId === "live-categories" && state.live && state.live._savedCatScroll > 0) {
      savedScroll = state.live._savedCatScroll;
      state.live._savedCatScroll = 0;
    } else if (
      containerId === "movie-categories" &&
      state.movies &&
      state.movies._savedCatScroll > 0
    ) {
      savedScroll = state.movies._savedCatScroll;
      state.movies._savedCatScroll = 0;
    } else if (
      containerId === "series-categories" &&
      state.series &&
      state.series._savedCatScroll > 0
    ) {
      savedScroll = state.series._savedCatScroll;
      state.series._savedCatScroll = 0;
    } else {
      savedScroll = scrollPane ? scrollPane.scrollTop : 0;
    }
    container.innerHTML = html;
    Array.prototype.forEach.call(container.querySelectorAll("[data-category-id]"), function (btn) {
      if (btn.getAttribute("data-category-id") === String(activeId)) {
        activeBtn = btn;
      }
      btn.addEventListener("click", function () {
        onSelect(btn.getAttribute("data-category-id"));
      });
    });
    if (activeBtn) {
      if (scrollPane && savedScroll > 0) {
        // Defer to let the browser complete layout after innerHTML change
        // (setting scrollTop before layout is complete caps it at 0)
        var _sp = scrollPane;
        var _ss = savedScroll;
        var _ab = activeBtn;
        setTimeout(function () {
          _sp.scrollTop = _ss;
          scrollIntoViewNearest(_ab, _sp);
        }, 0);
      } else {
        scrollIntoViewNearest(activeBtn, scrollPane || container.parentNode);
      }
      if (!document.activeElement || document.activeElement === document.body) {
        focusNode(activeBtn);
      }
    }
  }

  function loadCategoryCounts(view, categories, containerId) {
    var cache = activeSourceCache();
    if (!cache || !categories || !categories.length) {
      return;
    }
    var index = 0;

    function writeCount(catId, value) {
      cache.counts[view][String(catId)] = value;
      var btn = document.querySelector(
        "#" + containerId + ' [data-category-id="' + String(catId) + '"]'
      );
      if (!btn) {
        return;
      }
      var node = btn.querySelector(".category-count");
      if (node) {
        node.textContent = String(value);
      }
    }

    function next() {
      if (index >= categories.length) {
        return;
      }
      var category = categories[index++];
      var catId = String(category.category_id);
      if (cache.counts[view][catId] !== undefined) {
        writeCount(catId, cache.counts[view][catId]);
        setTimeout(next, 0);
        return;
      }
      ensureItems(view, catId)
        .then(
          function (items) {
            writeCount(catId, items.length);
          },
          function () {
            writeCount(catId, "?");
          }
        )
        .then(function () {
          setTimeout(next, 0);
        });
    }

    next();
  }

  function renderLive() {
    dom.workspace.innerHTML =
      '<div class="split-layout"><div class="category-pane"><div class="section-toolbar"><div class="section-title">Categories</div></div><div class="category-search-wrap"><input id="live-category-search" class="category-search-input focusable" type="text" tabindex="0" placeholder="Search categories" /></div><div id="live-categories" class="pane-scroll"></div></div><div class="list-pane" id="live-list-pane"><div class="section-toolbar"><div class="section-title">Channels</div><button id="live-refresh-list" class="btn focusable" type="button" tabindex="0" title="Refresh list">' +
      refreshIconSvg("icon-refresh-sm") +
      '</button></div><div id="live-list" class="pane-scroll"></div></div><div class="detail-pane live-detail-pane"><div id="live-detail"></div></div></div>';
    document.getElementById("live-categories").innerHTML =
      '<div class="status-box"><p>Loading....</p></div>';
    document.getElementById("live-list").innerHTML =
      '<div class="status-box"><p>Loading....</p></div>';
    document.getElementById("live-detail").innerHTML =
      '<div class="detail-card"><h2>Live preview</h2><p class="muted">Loading....</p></div>';
    ensureCategories("live").then(function (categories) {
      var liveCategoryInput = document.getElementById("live-category-search");
      function renderLiveCategoriesOnly() {
        var visibleCategories = filteredCategoriesForView("live", categories);
        if (!visibleCategories.length) {
          document.getElementById("live-categories").innerHTML =
            '<div class="status-box"><p>No categories match this search.</p></div>';
          return;
        }
        renderCategories(
          "live-categories",
          visibleCategories,
          state.live.selectedCategoryId,
          function (catId) {
            // Only reload channels/detail — never rebuild the category list itself
            state.live.selectedCategoryId = catId;
            state.live.activeUid = null;
            // Update active highlight in-place without scroll disruption
            Array.prototype.forEach.call(
              document.querySelectorAll("#live-categories .category-btn"),
              function (btn) {
                var active = btn.getAttribute("data-category-id") === String(catId);
                if (active) {
                  btn.classList.add("active");
                } else {
                  btn.classList.remove("active");
                }
              }
            );
            document.getElementById("live-list").innerHTML =
              '<div class="status-box"><p>Loading....</p></div>';
            document.getElementById("live-detail").innerHTML =
              '<div class="detail-card"><h2>Live preview</h2><p class="muted">Loading....</p></div>';
            ensureItems("live", state.live.selectedCategoryId).then(function (items) {
              state.live.items = items;
              if (items.length) {
                var firstRecord = buildRecord("live", items[0], {
                  subtitle: items[0].group || items[0].category_name || "Live channel",
                  categoryId: items[0].category_id || state.live.selectedCategoryId
                });
                state.live.activeUid = firstRecord.uid;
                state.inline.record = firstRecord;
                state.inline.list = items;
                state.inline.index = 0;
              }
              renderLiveList();
              renderLiveDetail();
              if (state.inline.record) loadLiveEpg(state.inline.record);
            });
          }
        );
        loadCategoryCounts("live", visibleCategories, "live-categories");
      }
      if (!categories.length) {
        var liveSynced = isViewSynced("live");
        document.getElementById("live-categories").innerHTML =
          '<div class="status-box"><p>' +
          (liveSynced
            ? "No live categories."
            : "No synced live data yet. Sync LIVE on Dashboard first.") +
          "</p></div>";
        document.getElementById("live-list").innerHTML =
          '<div class="status-box"><p>' +
          (liveSynced
            ? "No channels available."
            : "Run LIVE sync from Dashboard to load channels.") +
          "</p></div>";
        document.getElementById("live-detail").innerHTML =
          '<div class="detail-card"><h2>Live preview</h2><p class="muted">' +
          (liveSynced
            ? "Select a channel when content becomes available."
            : "Sync LIVE first, then select a channel.") +
          "</p></div>";
        return;
      }
      if (!state.live.selectedCategoryId) {
        state.live.selectedCategoryId = String(categories[0].category_id);
      }
      syncSearchPlaceholder();
      if (liveCategoryInput) {
        liveCategoryInput.value = state.categorySearch.live || "";
        liveCategoryInput.addEventListener("input", function () {
          state.categorySearch.live = liveCategoryInput.value;
          renderLiveCategoriesOnly();
        });
      }
      renderLiveCategoriesOnly();
      document.getElementById("live-refresh-list").addEventListener("click", function () {
        refreshSubcategory("live", state.live.selectedCategoryId).then(function () {
          state.live.activeUid = null;
          state.inline.record = null;
          renderLive();
        });
      });
      ensureItems("live", state.live.selectedCategoryId).then(function (items) {
        state.live.items = items;
        if (state.live.activeUid) {
          var activeRecord = state.recordsByUid[state.live.activeUid];
          if (activeRecord) {
            state.inline.record = activeRecord;
            state.inline.list = items;
            state.inline.index = indexByUid(items, activeRecord.uid, "live");
          }
        } else if (items.length) {
          // Auto-play first channel when switching to a new category
          var firstItem = items[0];
          var firstRecord = buildRecord("live", firstItem, {
            subtitle: firstItem.group || firstItem.category_name || "Live channel",
            categoryId: firstItem.category_id || state.live.selectedCategoryId
          });
          state.live.activeUid = firstRecord.uid;
          state.inline.record = firstRecord;
          state.inline.list = items;
          state.inline.index = 0;
        }
        renderLiveList();
        renderLiveDetail();
        if (state.inline.record && !state.live.epg.length) {
          loadLiveEpg(state.inline.record);
        }
      });
    });
  }

  function renderLiveList() {
    var list = document.getElementById("live-list");
    var items = filtered(state.live.items, "live");
    if (!items.length) {
      list.innerHTML = '<div class="status-box"><p>No channels match this search.</p></div>';
      return;
    }
    var count = Math.min(PAGE_CHANNELS, items.length);
    var activeIndex = state.live.activeUid ? indexByUid(items, state.live.activeUid, "live") : -1;
    if (activeIndex >= count) {
      // Make sure the playing channel is materialised so focus can land on it
      count = Math.min(items.length, Math.ceil((activeIndex + 1) / PAGE_CHANNELS) * PAGE_CHANNELS);
    }
    state.live.rendered = count;
    list.innerHTML = buildLiveCards(items.slice(0, count));
    if (count < items.length) {
      list.insertAdjacentHTML("beforeend", '<div class="sentinel"><div class="spin"></div></div>');
    }
    bindLiveCards(items);
    if (state.live.activeUid) {
      focusFirst('#live-list [data-record-uid="' + state.live.activeUid + '"]');
    }
    document.getElementById("live-list").onscroll = function () {
      if (state.live.rendered >= items.length) {
        return;
      }
      var pane = document.getElementById("live-list");
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 180) {
        appendLiveCards(items);
      }
    };
  }

  function buildLiveCards(items) {
    var html = "";
    Array.prototype.forEach.call(items, function (item) {
      var record = buildRecord("live", item, {
        subtitle: item.group || item.category_name || "Live channel",
        categoryId: item.category_id || state.live.selectedCategoryId
      });
      html +=
        '<button class="channel-card focusable' +
        (record.uid === state.live.activeUid ? " active" : "") +
        '" type="button" tabindex="0" data-record-uid="' +
        escapeHtml(record.uid) +
        '"><div class="channel-card-top"><div class="logo-box"><span class="logo-fallback">' +
        escapeHtml(logoFallbackText(record.title)) +
        "</span>" +
        (record.poster
          ? '<img src="' +
            encodeAttr(safeImgUrl(record.poster)) +
            '" data-logo-original="' + encodeAttr(record.poster) +
            '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />'
          : "") +
        '</div><div class="card-main"><div class="card-title">' +
        escapeHtml(record.title) +
        '</div><div class="card-subtitle">' +
        escapeHtml(record.subtitle || "Live") +
        "</div></div></div></button>";
    });
    return html;
  }

  function appendLiveCards(items) {
    var list = document.getElementById("live-list");
    var start = state.live.rendered;
    var end = Math.min(start + PAGE_CHANNELS, items.length);
    var sentinel = list.querySelector(".sentinel");
    if (sentinel && sentinel.parentNode) {
      sentinel.parentNode.removeChild(sentinel);
    }
    list.insertAdjacentHTML("beforeend", buildLiveCards(items.slice(start, end)));
    state.live.rendered = end;
    if (end < items.length) {
      list.insertAdjacentHTML("beforeend", '<div class="sentinel"><div class="spin"></div></div>');
    }
    bindLiveCards(items);
  }

  function bindLiveCards(items) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#live-list [data-record-uid]"),
      function (btn) {
        if (btn.getAttribute("data-bound") === "1") {
          return;
        }
        btn.setAttribute("data-bound", "1");
        btn.addEventListener("click", function () {
          var record = state.recordsByUid[btn.getAttribute("data-record-uid")];
          if (record) {
            if (state.live.activeUid === record.uid && state.inline.record) {
              openOverlayPlayer(record, items, indexByUid(items, record.uid, "live"));
              return;
            }
            state.live.activeUid = record.uid;
            state.inline.record = record;
            state.inline.list = items;
            state.inline.index = indexByUid(items, record.uid, "live");
            pushHistory(record);
            renderLiveList();
            renderLiveDetail();
            loadLiveEpg(record);
          }
        });
      }
    );
  }

  function indexByUid(items, uid, view) {
    var i;
    for (i = 0; i < items.length; i++) {
      if (itemUid(view, items[i]) === uid) {
        return i;
      }
    }
    return -1;
  }

  // Same uid formula as buildRecord, without mutating state.recordsByUid.
  function itemUid(view, item) {
    var source = activeSource();
    if (!source || !item) {
      return "";
    }
    return (
      source.id +
      ":" +
      view +
      ":" +
      (item.stream_id || item.series_id || item.id || item.url || item.name || "")
    );
  }

  // The channel list shown in the pane is the single source of truth for CH+/CH- order.
  function syncInlineListToDisplay() {
    var items = filtered(state.live.items, "live");
    state.inline.list = items;
    state.inline.index = state.inline.record
      ? indexByUid(items, state.inline.record.uid, "live")
      : -1;
    return items;
  }

  function renderLiveDetail() {
    var detail = document.getElementById("live-detail");
    if (!state.inline.record) {
      detail.innerHTML =
        '<div class="detail-card"><h2>Live preview</h2><p class="muted">Select a live channel to start inline playback.</p></div>';
      return;
    }
    var record = state.inline.record;
    detail.innerHTML =
      '<div class="player-panel"><div class="inline-video-wrap"><video id="inline-video" class="focusable" tabindex="0" autoplay playsinline webkit-playsinline></video><div id="inline-state" class="inline-video-empty"><p>Loading....</p></div><div class="inline-overlay-controls"><button id="inline-ov-prev" class="btn icon-only focusable" type="button" tabindex="0" title="Previous channel">' +
      mediaControlIconSvg("prev") +
      '</button><button id="inline-ov-full" class="btn primary icon-only focusable" type="button" tabindex="0" title="Fullscreen">' +
      mediaControlIconSvg("fullscreen") +
      '</button><button id="inline-ov-next" class="btn icon-only focusable" type="button" tabindex="0" title="Next channel">' +
      mediaControlIconSvg("next") +
      '</button><button id="inline-ov-fav" class="btn icon-only focusable" type="button" tabindex="0" title="Favorite">' +
      mediaControlIconSvg("favorite", isFavorite(record.uid)) +
      '</button></div></div></div><div class="epg-panel"><h2>Program guide</h2><div id="live-epg">' +
      buildEpgHtml() +
      "</div></div>";
    document.getElementById("inline-ov-prev").addEventListener("click", function () {
      changeInlineChannel(-1);
    });
    document.getElementById("inline-ov-next").addEventListener("click", function () {
      changeInlineChannel(1);
    });
    document.getElementById("inline-ov-full").addEventListener("click", function () {
      openOverlayPlayer(record, state.inline.list, state.inline.index);
    });
    document.getElementById("inline-ov-fav").addEventListener("click", function () {
      toggleFavorite(record, true);
    });
    attachInlineLivePlayer();
  }

  function buildEpgHtml() {
    if (!state.live.epg.length) {
      return '<div class="status-box"><p>No EPG data available.</p></div>';
    }
    var html = "";
    var now = Date.now();
    Array.prototype.forEach.call(state.live.epg, function (entry, index) {
      var isLiveNow =
        entry.start > 0 && entry.stop > entry.start
          ? now >= entry.start && now < entry.stop
          : index === 0;
      html +=
        '<div class="epg-card' +
        (isLiveNow ? " live-now" : "") +
        '"><div><strong>' +
        escapeHtml(entry.timeRange) +
        "</strong>" +
        (isLiveNow ? '<span class="pill-live">LIVE</span>' : "") +
        '</div><div style="margin-top:8px;font-size:20px;">' +
        escapeHtml(entry.title) +
        '</div><div class="epg-meta" style="margin-top:8px;">' +
        escapeHtml(entry.description || "") +
        "</div>" +
        (isLiveNow
          ? '<div class="progress-track" style="margin-top:10px;"><div class="progress-fill" style="width:' +
            entry.progress +
            '%"></div></div>'
          : "") +
        "</div>";
    });
    return html;
  }

  function attachInlineLivePlayer() {
    stopInlinePlayer();
    var video = document.getElementById("inline-video");
    var stateBox = document.getElementById("inline-state");
    if (!video || !state.inline.record) {
      return;
    }
    var candidates = livePlaybackCandidates(state.inline.record);
    var candidateIndex = 0;
    var reconnecting = false;
    var failCount = 0;

    function revealInlineVideo() {
      // Remove the overlay entirely from DOM so nothing sits over the video element.
      // display:none is sometimes unreliable on webOS 3.x flex containers.
      if (stateBox && stateBox.parentNode) {
        stateBox.parentNode.removeChild(stateBox);
        stateBox = null;
      }
      try {
        video.style.visibility = "visible";
        video.style.opacity = "1";
        // webOS positions the hardware video plane from the element geometry it
        // saw at attach time; force a reflow so the plane lands on the preview box.
        video.style.width = "99.9%";
        void video.offsetHeight;
        video.style.width = "100%";
      } catch (e0) {}
    }

    function activeUrl() {
      if (!candidates.length) {
        return "";
      }
      return candidates[candidateIndex] || candidates[0];
    }

    function resetInlineMedia() {
      if (state.inline.hls) {
        try {
          state.inline.hls.destroy();
        } catch (e) {}
        state.inline.hls = null;
      }
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (e2) {}
    }

    function nextCandidate() {
      if (candidateIndex + 1 < candidates.length) {
        candidateIndex += 1;
        return true;
      }
      return false;
    }

    function clearInlineRecovery() {
      if (state.inline.restartTimer) {
        clearTimeout(state.inline.restartTimer);
        state.inline.restartTimer = null;
      }
      if (state.inline.stallWatch) {
        clearInterval(state.inline.stallWatch);
        state.inline.stallWatch = null;
      }
    }

    function scheduleInlineReconnect(reason) {
      if (reconnecting || !state.inline.record) {
        return;
      }
      reconnecting = true;
      clearInlineRecovery();
      var switchedCandidate = nextCandidate();
      if (switchedCandidate) {
        failCount = 0;
      } else {
        failCount += 1;
      }
      if (failCount >= 3) {
        if (stateBox) {
          stateBox.className = "inline-video-empty";
          stateBox.innerHTML = "<p>Stream unavailable</p>";
        }
        reconnecting = false;
        return;
      }
      if (stateBox) {
        stateBox.className = "inline-video-empty";
        stateBox.innerHTML = "<p>Loading....</p>";
      }
      state.inline.restartTimer = setTimeout(
        function () {
          reconnecting = false;
          if (state.inline.record && state.view === "live") {
            startInlinePlayback();
          }
        },
        reason === "fatal" ? 2500 : 3500
      );
    }

    function startInlineWatchdog() {
      clearInlineRecovery();
      state.inline.lastTime = -1;
      state.inline.stallWatch = setInterval(function () {
        if (!state.inline.record || state.view !== "live") {
          clearInlineRecovery();
          return;
        }
        if (video.paused || video.seeking || video.readyState < 2) {
          return;
        }
        var now = Math.floor(video.currentTime || 0);
        if (now === state.inline.lastTime) {
          scheduleInlineReconnect("stall");
          return;
        }
        state.inline.lastTime = now;
      }, 15000);
    }

    function startInlinePlayback() {
      var url = activeUrl();
      if (!url) {
        if (stateBox) {
          stateBox.className = "inline-video-empty";
          stateBox.innerHTML = "<p>Loading....</p>";
        }
        return;
      }

      resetInlineMedia();
      if (stateBox) {
        stateBox.className = "inline-video-empty";
        stateBox.innerHTML = "<p>Loading....</p>";
      }
      try {
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        video.setAttribute("preload", "auto");
        video.muted = false;
        video.style.visibility = "visible";
        video.style.opacity = "1";
      } catch (e0) {}
      video.volume = state.settings.volume;

      if (isHlsUrl(url) && canUseNativeHls(video)) {
        video.src = url;
        video.onloadedmetadata = function () {
          revealInlineVideo();
          tryPlay(video);
          startInlineWatchdog();
        };
      } else if (isHlsUrl(url) && window.Hls && Hls.isSupported()) {
        var cdnLoader = createSslFallbackHlsLoader();
        var inlineHlsCfg = {
          enableWorker: false,
          startLevel: -1,
          maxBufferLength: 14,
          maxMaxBufferLength: 26
        };
        if (cdnLoader) {
          inlineHlsCfg.loader = cdnLoader;
        }
        state.inline.hls = new Hls(inlineHlsCfg);
        state.inline.hls.loadSource(url);
        state.inline.hls.attachMedia(video);
        state.inline.hls.on(Hls.Events.MANIFEST_PARSED, function () {
          revealInlineVideo();
          tryPlay(video);
          startInlineWatchdog();
        });
        state.inline.hls.on(Hls.Events.ERROR, function (evt, data) {
          if (!data) {
            return;
          }
          if (data.fatal) {
            console.error(
              "[inline HLS] fatal error:",
              data.type,
              data.details,
              "url:",
              activeUrl()
            );
            // Try soft codec recovery first; only full-teardown if it fails again
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !state.inline._hlsRecovered) {
              state.inline._hlsRecovered = true;
              try {
                state.inline.hls.recoverMediaError();
              } catch (e) {}
            } else {
              state.inline._hlsRecovered = false;
              scheduleInlineReconnect("fatal");
            }
          }
        });
      } else if (!isHlsUrl(url) && !canBrowserPlayTs() && canUseMpegTs()) {
        // Non-HLS URL on a browser without native TS support (e.g. Chrome).
        // mpegts.js fetches raw TS bytes over XHR directly from the origin server,
        // bypassing any CDN — and therefore bypassing CDN SSL issues.
        // webOS is excluded because canBrowserPlayTs() returns truthy there and
        // the native hardware player handles MPEG-TS far better than JS.
        state.inline.mpegts = mpegts.createPlayer(
          { type: "mpegts", url: url, isLive: true },
          {
            enableWorker: false,
            lazyLoad: false,
            liveBufferLatencyChasing: true
          }
        );
        state.inline.mpegts.attachMediaElement(video);
        state.inline.mpegts.load();
        state.inline.mpegts.on(mpegts.Events.ERROR, function (type, detail) {
          console.error("[inline mpegts] error:", type, detail);
          scheduleInlineReconnect("fatal");
        });
        video.onplaying = function () {
          revealInlineVideo();
          startInlineWatchdog();
        };
        tryPlay(video);
      } else {
        video.src = url;
        video.oncanplay = function () {
          revealInlineVideo();
          tryPlay(video);
          startInlineWatchdog();
        };
      }

      video.oncanplay = function () {
        revealInlineVideo();
        tryPlay(video);
        startInlineWatchdog();
      };
      video.onloadeddata = function () {
        revealInlineVideo();
      };
      video.onplaying = function () {
        revealInlineVideo();
      };
      video.ontimeupdate = function () {
        if ((video.currentTime || 0) > 0 || video.readyState >= 2) {
          revealInlineVideo();
        }
      };

      // onstalled fires constantly on webOS during normal buffering — do not reconnect on it
      video.onstalled = null;
      video.onwaiting = function () {
        if (video.currentTime > 0) {
          revealInlineVideo();
        }
      };
      video.onerror = function () {
        scheduleInlineReconnect("error");
      };

      // Fallback: some webOS streams play audio before reliable canplay events fire.
      setTimeout(function () {
        if (!state.inline.record || state.view !== "live") {
          return;
        }
        if ((video.currentTime || 0) > 0 || video.readyState >= 1 || !video.paused) {
          revealInlineVideo();
        }
      }, 600);

      // Hard fallback: if not paused after 1.5 s, the stream is playing — just reveal.
      setTimeout(function () {
        if (!state.inline.record || state.view !== "live") {
          return;
        }
        if (!video.error && !video.paused) {
          revealInlineVideo();
        }
      }, 1500);

      // Final safety: after 3 s reveal regardless if no error, letting user see the video.
      setTimeout(function () {
        if (!state.inline.record || state.view !== "live") {
          return;
        }
        if (!video.error) {
          revealInlineVideo();
        }
      }, 3000);
    }

    startInlinePlayback();
  }

  function stopInlinePlayer() {
    var video = document.getElementById("inline-video");
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (e) {}
    }
    if (state.inline.hls) {
      try {
        state.inline.hls.destroy();
      } catch (e2) {}
      state.inline.hls = null;
    }
    if (state.inline.mpegts) {
      try {
        state.inline.mpegts.unload();
        state.inline.mpegts.detachMediaElement();
        state.inline.mpegts.destroy();
      } catch (e3) {}
      state.inline.mpegts = null;
    }
    if (state.inline.restartTimer) {
      clearTimeout(state.inline.restartTimer);
      state.inline.restartTimer = null;
    }
    if (state.inline.stallWatch) {
      clearInterval(state.inline.stallWatch);
      state.inline.stallWatch = null;
    }
  }

  function extractEpgEntries(data) {
    if (!data) {
      return [];
    }
    if (Object.prototype.toString.call(data) === "[object Array]") {
      return data;
    }
    if (
      data.epg_listings &&
      Object.prototype.toString.call(data.epg_listings) === "[object Array]"
    ) {
      return data.epg_listings;
    }
    if (data.listings && Object.prototype.toString.call(data.listings) === "[object Array]") {
      return data.listings;
    }
    if (data.js && Object.prototype.toString.call(data.js) === "[object Array]") {
      return data.js;
    }
    if (
      data.js &&
      data.js.data &&
      Object.prototype.toString.call(data.js.data) === "[object Array]"
    ) {
      return data.js.data;
    }
    if (data.epg && Object.prototype.toString.call(data.epg) === "[object Array]") {
      return data.epg;
    }
    return [];
  }

  function normalizeEpgEntries(entries) {
    var now = Date.now();
    var list = Array.prototype.map
      .call(entries || [], function (entry) {
        var start = parseMaybeTime(
          entry.start || entry.start_timestamp || entry.time || entry.start_time || entry.begin
        );
        var stop = parseMaybeTime(
          entry.end ||
            entry.stop ||
            entry.stop_timestamp ||
            entry.time_to ||
            entry.end_time ||
            entry.finish
        );
        var title = normalizeEpgText(
          entry.title || entry.name || entry.programme || entry.label,
          ""
        );
        var description = normalizeEpgText(
          entry.description || entry.descr || entry.plot || entry.info,
          ""
        );
        if (!start || !stop || stop <= start) {
          return null;
        }
        // Guard against providers returning absurd windows (whole-day placeholders)
        if (stop - start > 12 * 3600 * 1000) {
          return null;
        }
        if (!title) {
          return null;
        }
        return {
          title: title,
          description: description,
          start: start,
          stop: stop,
          timeRange: formatClock(start) + " - " + formatClock(stop),
          progress:
            now > start && stop > start
              ? Math.max(0, Math.min(100, ((now - start) / (stop - start)) * 100))
              : 0
        };
      })
      .filter(function (entry) {
        return !!entry;
      })
      .sort(function (a, b) {
        return a.start - b.start;
      });

    var upcoming = list.filter(function (entry) {
      return entry.stop > now;
    });
    return (upcoming.length ? upcoming : list).slice(0, 8);
  }

  function loadLiveEpg(record) {
    var source = activeSource();
    state.live.epg = [];
    // Token guards against a slow response for a previous channel overwriting the guide
    state.live.epgToken = (state.live.epgToken || 0) + 1;
    var token = state.live.epgToken;
    var epgEl = document.getElementById("live-epg");
    if (epgEl) {
      epgEl.innerHTML = buildEpgHtml();
    }
    if (!source || source.type !== "xtream" || !record || !record.streamId) {
      return;
    }

    function applyEntries(entries) {
      if (token !== state.live.epgToken) {
        return false;
      }
      var normalized = normalizeEpgEntries(entries);
      if (!normalized.length) {
        return false;
      }
      state.live.epg = normalized;
      var liveEpg = document.getElementById("live-epg");
      if (liveEpg) {
        liveEpg.innerHTML = buildEpgHtml();
      }
      return true;
    }

    function loadFullTable() {
      fetchJSON(
        xtreamApi(
          source,
          "get_simple_data_table",
          "&stream_id=" + encodeURIComponent(record.streamId)
        )
      ).then(
        function (data) {
          applyEntries(extractEpgEntries(data));
        },
        function () {}
      );
    }

    fetchJSON(
      xtreamApi(
        source,
        "get_short_epg",
        "&stream_id=" + encodeURIComponent(record.streamId) + "&limit=12"
      )
    ).then(function (data) {
      if (token !== state.live.epgToken) {
        return;
      }
      if (!applyEntries(extractEpgEntries(data))) {
        loadFullTable();
      }
    }, loadFullTable);
  }

  function parseMaybeTime(value) {
    if (!value) {
      return 0;
    }
    if (/^\d+$/.test(String(value))) {
      var num = parseInt(value, 10);
      if (num >= 1000000000000) {
        return num;
      }
      if (num >= 1000000000) {
        return num * 1000;
      }
      return 0;
    }
    var text = String(value);
    var parsed = Date.parse(text);
    if (isNaN(parsed)) {
      parsed = Date.parse(text.replace(/ /g, "T"));
    }
    return isNaN(parsed) ? 0 : parsed;
  }

  function formatClock(ms) {
    if (!ms) {
      return "--:--";
    }
    var date = new Date(ms);
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function changeInlineChannel(step) {
    var items = syncInlineListToDisplay();
    if (!items.length) {
      return;
    }
    var nextIndex;
    if (state.inline.index < 0) {
      nextIndex = 0;
    } else {
      nextIndex = state.inline.index + step;
      if (nextIndex < 0) {
        nextIndex = items.length - 1;
      }
      if (nextIndex >= items.length) {
        nextIndex = 0;
      }
    }
    var nextItem = items[nextIndex];
    var nextRecord = buildRecord("live", nextItem, {
      subtitle: nextItem.group || nextItem.category_name || "Live channel",
      categoryId: nextItem.category_id || state.live.selectedCategoryId
    });
    state.live.activeUid = nextRecord.uid;
    state.inline.record = nextRecord;
    state.inline.index = nextIndex;
    pushHistory(nextRecord);
    renderLiveList();
    renderLiveDetail();
    loadLiveEpg(nextRecord);
  }

  function buildGridCards(view, items, activeUid) {
    var html = '<div class="grid-wrap">';
    Array.prototype.forEach.call(items, function (item) {
      var record = buildRecord(view, item, { subtitle: buildMetaLine(item) });
      var hasTitleOverlay = view === "movies" || view === "series" || view === "episode";
      var badges = "";
      if (isFavorite(record.uid)) {
        badges += '<span class="poster-badge poster-badge--favorite">★</span>';
      }
      if (state.positions[record.uid]) {
        badges += '<span class="poster-badge poster-badge--resume">Resume</span>';
      }
      var rating = ratingBadgeValue(record, item);
      if (rating > 0) {
        badges +=
          '<span class="poster-badge poster-badge--rating">★ ' + rating.toFixed(1) + "</span>";
      }
      html +=
        '<button class="poster-card content-card focusable' +
        (hasTitleOverlay ? " poster-card--title-overlay" : "") +
        (record.uid === activeUid ? " active" : "") +
        '" type="button" tabindex="0" data-record-uid="' +
        escapeHtml(record.uid) +
        '"><div class="poster">' +
        badges +
        (record.poster
          ? '<img src="' +
            encodeAttr(safeImgUrl(record.poster)) +
            '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />'
          : "") +
        (hasTitleOverlay
          ? '<div class="poster-title-overlay">' + escapeHtml(record.title) + "</div></div></button>"
          : '</div><div class="poster-body"><div class="poster-title">' +
            escapeHtml(record.title) +
            "</div>" +
            (record.subtitle
              ? '<div class="poster-meta">' + escapeHtml(record.subtitle) + "</div>"
              : "") +
            "</div></button>");
    });
    html += "</div>";
    return html;
  }

  function renderMoviesFromState() {
    var pane = document.getElementById("movie-grid");
    if (!pane) {
      renderMovies();
      return;
    }
    var cache = activeSourceCache();
    var categories = (cache && cache.categories && cache.categories.movies) || [];
    var filteredItems = filtered(state.movies.items || [], "movies");
    state.movies.rendered = Math.min(PAGE_GRID, filteredItems.length);
    pane.innerHTML =
      '<div class="section-toolbar"><div class="section-title">' +
      escapeHtml(currentCategoryName(categories, state.movies.selectedCategoryId)) +
      '</div><div><span class="section-count">' +
      filteredItems.length +
      ' items</span><button id="movie-refresh-list" class="btn focusable" type="button" tabindex="0" title="Refresh list" style="margin-left:10px;">' +
      refreshIconSvg("icon-refresh-sm") +
      "</button></div></div>" +
      (filteredItems.length
        ? buildGridCards(
            "movies",
            filteredItems.slice(0, state.movies.rendered),
            state.movies.selectedUid
          )
        : '<div class="status-box"><p>No movies match this search.</p></div>');
    if (state.movies.rendered < filteredItems.length) {
      pane.insertAdjacentHTML("beforeend", '<div class="sentinel"><div class="spin"></div></div>');
    }
    document.getElementById("movie-refresh-list").addEventListener("click", function () {
      refreshSubcategory("movies", state.movies.selectedCategoryId).then(function () {
        renderMovies();
      });
    });
    bindMovieGrid(filteredItems);
    queueRealtimeRatings(filteredItems.slice(0, state.movies.rendered));
    pane.onscroll = function () {
      if (state.movies.rendered >= filteredItems.length) {
        return;
      }
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 180) {
        appendMovieGrid(filteredItems);
      }
    };
  }

  function renderSeriesFromState() {
    var pane = document.getElementById("series-grid");
    if (!pane) {
      renderSeries();
      return;
    }
    var cache = activeSourceCache();
    var categories = (cache && cache.categories && cache.categories.series) || [];
    var filteredItems = filtered(state.series.items || [], "series");
    state.series.rendered = Math.min(PAGE_GRID, filteredItems.length);
    pane.innerHTML =
      '<div class="section-toolbar"><div class="section-title">' +
      escapeHtml(currentCategoryName(categories, state.series.selectedCategoryId)) +
      '</div><div><span class="section-count">' +
      filteredItems.length +
      ' items</span><button id="series-refresh-list" class="btn focusable" type="button" tabindex="0" title="Refresh list" style="margin-left:10px;">' +
      refreshIconSvg("icon-refresh-sm") +
      "</button></div></div>" +
      (filteredItems.length
        ? buildGridCards(
            "series",
            filteredItems.slice(0, state.series.rendered),
            state.series.selectedUid
          )
        : '<div class="status-box"><p>No series match this search.</p></div>');
    if (state.series.rendered < filteredItems.length) {
      pane.insertAdjacentHTML("beforeend", '<div class="sentinel"><div class="spin"></div></div>');
    }
    document.getElementById("series-refresh-list").addEventListener("click", function () {
      refreshSubcategory("series", state.series.selectedCategoryId).then(function () {
        renderSeries();
      });
    });
    bindSeriesGrid(filteredItems);
    queueRealtimeRatings(filteredItems.slice(0, state.series.rendered));
    pane.onscroll = function () {
      if (state.series.rendered >= filteredItems.length) {
        return;
      }
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 180) {
        appendSeriesGrid(filteredItems);
      }
    };
  }

  function renderMovies() {
    dom.workspace.innerHTML =
      '<div class="split-layout split-layout--wide"><div class="category-pane"><div class="section-toolbar"><div class="section-title">Movie categories</div></div><div class="category-search-wrap"><input id="movie-category-search" class="category-search-input focusable" type="text" tabindex="0" placeholder="Search categories" /></div><div id="movie-categories" class="pane-scroll"></div></div><div id="movie-grid" class="grid-pane"></div></div>';
    document.getElementById("movie-categories").innerHTML =
      '<div class="status-box"><p>Loading....</p></div>';
    document.getElementById("movie-grid").innerHTML =
      '<div class="status-box"><p>Loading....</p></div>';
    ensureCategories("movies").then(function (categories) {
      var movieCategoryInput = document.getElementById("movie-category-search");
      function renderMovieCategoriesOnly() {
        var visibleCategories = filteredCategoriesForView("movies", categories);
        if (!visibleCategories.length) {
          document.getElementById("movie-categories").innerHTML =
            '<div class="status-box"><p>No categories match this search.</p></div>';
          return;
        }
        renderCategories(
          "movie-categories",
          visibleCategories,
          state.movies.selectedCategoryId,
          function (catId) {
            var catEl = document.getElementById("movie-categories");
            var sp = catEl ? catEl.parentNode : null;
            while (sp && sp.scrollHeight <= sp.clientHeight) sp = sp.parentNode;
            state.movies._savedCatScroll = sp ? sp.scrollTop : 0;
            state.movies.selectedCategoryId = catId;
            syncSearchPlaceholder();
            state.movies.selectedUid = null;
            renderMovies();
          }
        );
        loadCategoryCounts("movies", visibleCategories, "movie-categories");
      }
      if (!categories.length) {
        var moviesSynced = isViewSynced("movies");
        document.getElementById("movie-categories").innerHTML =
          '<div class="status-box"><p>' +
          (moviesSynced
            ? "No movie categories."
            : "No synced movie data yet. Sync MOVIES on Dashboard first.") +
          "</p></div>";
        document.getElementById("movie-grid").innerHTML =
          '<div class="status-box"><p>' +
          (moviesSynced
            ? "No movies available."
            : "Run MOVIES sync from Dashboard to load content.") +
          "</p></div>";
        return;
      }
      if (!state.movies.selectedCategoryId) {
        state.movies.selectedCategoryId = String(categories[0].category_id);
      }
      syncSearchPlaceholder();
      if (movieCategoryInput) {
        movieCategoryInput.value = state.categorySearch.movies || "";
        movieCategoryInput.addEventListener("input", function () {
          state.categorySearch.movies = movieCategoryInput.value;
          renderMovieCategoriesOnly();
        });
      }
      renderMovieCategoriesOnly();
      ensureItems("movies", state.movies.selectedCategoryId).then(function (items) {
        state.movies.items = items;
        var filteredItems = filtered(items, "movies");
        state.movies.rendered = Math.min(PAGE_GRID, filteredItems.length);
        document.getElementById("movie-grid").innerHTML =
          '<div class="section-toolbar"><div class="section-title">' +
          escapeHtml(currentCategoryName(categories, state.movies.selectedCategoryId)) +
          '</div><div><span class="section-count">' +
          filteredItems.length +
          ' items</span><button id="movie-refresh-list" class="btn focusable" type="button" tabindex="0" title="Refresh list" style="margin-left:10px;">' +
          refreshIconSvg("icon-refresh-sm") +
          "</button></div></div>" +
          (filteredItems.length
            ? buildGridCards(
                "movies",
                filteredItems.slice(0, state.movies.rendered),
                state.movies.selectedUid
              )
            : '<div class="status-box"><p>No movies match this search.</p></div>');
        if (state.movies.rendered < filteredItems.length) {
          document
            .getElementById("movie-grid")
            .insertAdjacentHTML(
              "beforeend",
              '<div class="sentinel"><div class="spin"></div></div>'
            );
        }
        document.getElementById("movie-refresh-list").addEventListener("click", function () {
          refreshSubcategory("movies", state.movies.selectedCategoryId).then(function () {
            renderMovies();
          });
        });
        bindMovieGrid(filteredItems);
        queueRealtimeRatings(filteredItems.slice(0, state.movies.rendered));
        if (state.movies.selectedUid) {
          focusFirst('#movie-grid [data-record-uid="' + state.movies.selectedUid + '"]');
        }
        document.getElementById("movie-grid").onscroll = function () {
          var pane = document.getElementById("movie-grid");
          if (state.movies.rendered >= filteredItems.length) {
            return;
          }
          if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 180) {
            appendMovieGrid(filteredItems);
          }
        };
      });
    });
  }

  function bindMovieGrid(filteredItems) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#movie-grid [data-record-uid]"),
      function (btn) {
        btn.addEventListener("click", function () {
          var record = state.recordsByUid[btn.getAttribute("data-record-uid")];
          if (record) {
            state.movies.selectedUid = record.uid;
            openMovieDetails(
              record,
              filteredItems,
              indexByUid(filteredItems, record.uid, "movies")
            );
          }
        });
      }
    );
  }

  function appendMovieGrid(filteredItems) {
    var pane = document.getElementById("movie-grid");
    var wrap = pane.querySelector(".grid-wrap");
    if (!wrap) {
      return;
    }
    var start = state.movies.rendered;
    var end = Math.min(start + PAGE_GRID, filteredItems.length);
    var sentinel = pane.querySelector(".sentinel");
    if (sentinel && sentinel.parentNode) {
      sentinel.parentNode.removeChild(sentinel);
    }
    wrap.insertAdjacentHTML(
      "beforeend",
      buildGridCards("movies", filteredItems.slice(start, end), state.movies.selectedUid)
        .replace(/^<div class="grid-wrap">/, "")
        .replace(/<\/div>$/, "")
    );
    state.movies.rendered = end;
    queueRealtimeRatings(filteredItems.slice(start, end));
    if (end < filteredItems.length) {
      pane.insertAdjacentHTML("beforeend", '<div class="sentinel"><div class="spin"></div></div>');
    }
    bindMovieGrid(filteredItems);
  }

  function renderSeries() {
    if (state.series.selectedUid) {
      renderSeriesEpisodesPage();
      return;
    }
    dom.workspace.innerHTML =
      '<div class="split-layout split-layout--wide"><div class="category-pane"><div class="section-toolbar"><div class="section-title">Series categories</div></div><div class="category-search-wrap"><input id="series-category-search" class="category-search-input focusable" type="text" tabindex="0" placeholder="Search categories" /></div><div id="series-categories" class="pane-scroll"></div></div><div id="series-grid" class="grid-pane"></div></div>';
    document.getElementById("series-categories").innerHTML =
      '<div class="status-box"><p>Loading....</p></div>';
    document.getElementById("series-grid").innerHTML =
      '<div class="status-box"><p>Loading....</p></div>';
    ensureCategories("series").then(function (categories) {
      var seriesCategoryInput = document.getElementById("series-category-search");
      function renderSeriesCategoriesOnly() {
        var visibleCategories = filteredCategoriesForView("series", categories);
        if (!visibleCategories.length) {
          document.getElementById("series-categories").innerHTML =
            '<div class="status-box"><p>No categories match this search.</p></div>';
          return;
        }
        renderCategories(
          "series-categories",
          visibleCategories,
          state.series.selectedCategoryId,
          function (catId) {
            var catEl = document.getElementById("series-categories");
            var sp = catEl ? catEl.parentNode : null;
            while (sp && sp.scrollHeight <= sp.clientHeight) sp = sp.parentNode;
            state.series._savedCatScroll = sp ? sp.scrollTop : 0;
            state.series.selectedCategoryId = catId;
            syncSearchPlaceholder();
            state.series.selectedUid = null;
            renderSeries();
          }
        );
        loadCategoryCounts("series", visibleCategories, "series-categories");
      }
      if (!categories.length) {
        var seriesSynced = isViewSynced("series");
        document.getElementById("series-categories").innerHTML =
          '<div class="status-box"><p>' +
          (seriesSynced
            ? "No series categories."
            : "No synced series data yet. Sync SERIES on Dashboard first.") +
          "</p></div>";
        document.getElementById("series-grid").innerHTML =
          '<div class="status-box"><p>' +
          (seriesSynced
            ? "No series available."
            : "Run SERIES sync from Dashboard to load content.") +
          "</p></div>";
        return;
      }
      if (!state.series.selectedCategoryId) {
        state.series.selectedCategoryId = String(categories[0].category_id);
      }
      syncSearchPlaceholder();
      if (seriesCategoryInput) {
        seriesCategoryInput.value = state.categorySearch.series || "";
        seriesCategoryInput.addEventListener("input", function () {
          state.categorySearch.series = seriesCategoryInput.value;
          renderSeriesCategoriesOnly();
        });
      }
      renderSeriesCategoriesOnly();
      ensureItems("series", state.series.selectedCategoryId).then(function (items) {
        state.series.items = items;
        var filteredItems = filtered(items, "series");
        var restoreIndex = state.series.restoreUid
          ? indexByUid(filteredItems, state.series.restoreUid, "series")
          : -1;
        state.series.rendered = Math.min(PAGE_GRID, filteredItems.length);
        if (restoreIndex >= state.series.rendered) {
          state.series.rendered = Math.min(
            filteredItems.length,
            Math.ceil((restoreIndex + 1) / PAGE_GRID) * PAGE_GRID
          );
        }
        document.getElementById("series-grid").innerHTML =
          '<div class="section-toolbar"><div class="section-title">' +
          escapeHtml(currentCategoryName(categories, state.series.selectedCategoryId)) +
          '</div><div><span class="section-count">' +
          filteredItems.length +
          ' items</span><button id="series-refresh-list" class="btn focusable" type="button" tabindex="0" title="Refresh list" style="margin-left:10px;">' +
          refreshIconSvg("icon-refresh-sm") +
          "</button></div></div>" +
          (filteredItems.length
            ? buildGridCards(
                "series",
                filteredItems.slice(0, state.series.rendered),
                state.series.selectedUid
              )
            : '<div class="status-box"><p>No series match this search.</p></div>');
        if (state.series.rendered < filteredItems.length) {
          document
            .getElementById("series-grid")
            .insertAdjacentHTML(
              "beforeend",
              '<div class="sentinel"><div class="spin"></div></div>'
            );
        }
        document.getElementById("series-refresh-list").addEventListener("click", function () {
          refreshSubcategory("series", state.series.selectedCategoryId).then(function () {
            renderSeries();
          });
        });
        bindSeriesGrid(filteredItems);
        queueRealtimeRatings(filteredItems.slice(0, state.series.rendered));
        if (state.series.restoreUid) {
          var restoreCard = document.querySelector(
            '#series-grid [data-record-uid="' + state.series.restoreUid + '"]'
          );
          state.series.restoreUid = null;
          if (restoreCard) {
            setTimeout(function () {
              focusNode(restoreCard);
            }, 60);
          }
        }
        document.getElementById("series-grid").onscroll = function () {
          var pane = document.getElementById("series-grid");
          if (state.series.rendered >= filteredItems.length) {
            return;
          }
          if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 180) {
            appendSeriesGrid(filteredItems);
          }
        };
      });
    });
  }

  function bindSeriesGrid(filteredItems) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#series-grid [data-record-uid]"),
      function (btn) {
        btn.addEventListener("click", function () {
          state.series.selectedUid = btn.getAttribute("data-record-uid");
          loadSeriesEpisodes();
          renderSeries();
        });
      }
    );
  }

  function returnToSeriesGrid() {
    state.series.restoreUid = state.series.selectedUid;
    state.series.selectedUid = null;
    renderSeries();
  }

  function appendSeriesGrid(filteredItems) {
    var pane = document.getElementById("series-grid");
    var wrap = pane.querySelector(".grid-wrap");
    if (!wrap) {
      return;
    }
    var start = state.series.rendered;
    var end = Math.min(start + PAGE_GRID, filteredItems.length);
    var sentinel = pane.querySelector(".sentinel");
    if (sentinel && sentinel.parentNode) {
      sentinel.parentNode.removeChild(sentinel);
    }
    wrap.insertAdjacentHTML(
      "beforeend",
      buildGridCards("series", filteredItems.slice(start, end), state.series.selectedUid)
        .replace(/^<div class="grid-wrap">/, "")
        .replace(/<\/div>$/, "")
    );
    state.series.rendered = end;
    queueRealtimeRatings(filteredItems.slice(start, end));
    if (end < filteredItems.length) {
      pane.insertAdjacentHTML("beforeend", '<div class="sentinel"><div class="spin"></div></div>');
    }
    bindSeriesGrid(filteredItems);
  }

  function loadSeriesEpisodes() {
    var source = activeSource();
    var record = state.recordsByUid[state.series.selectedUid];
    var cache = activeSourceCache();
    if (!record || !source || source.type !== "xtream") {
      return;
    }
    if (cache.seriesInfo[record.seriesId]) {
      renderSeriesEpisodesPage();
      return;
    }
    fetchJSON(
      xtreamApi(source, "get_series_info", "&series_id=" + encodeURIComponent(record.seriesId))
    ).then(
      function (data) {
        cache.seriesInfo[record.seriesId] = data;
        renderSeriesEpisodesPage();
      },
      function () {
        cache.seriesInfo[record.seriesId] = { episodes: {} };
        renderSeriesEpisodesPage();
      }
    );
  }

  function renderSeriesDetail() {
    if (state.series.selectedUid) {
      return;
    }
    var pane = document.getElementById("series-detail");
    if (!state.series.selectedUid) {
      pane.innerHTML =
        '<div class="detail-card"><h2>Series details</h2><p class="muted">Select a series to load episodes.</p></div>';
      return;
    }
    var record = state.recordsByUid[state.series.selectedUid];
    var cache = activeSourceCache();
    var info = cache.seriesInfo[record.seriesId];
    if (!info) {
      pane.innerHTML =
        '<div class="detail-card"><h2>' +
        escapeHtml(record.title) +
        '</h2><p class="muted">Loading episodes…</p></div>';
      return;
    }
    var html =
      '<div class="detail-card"><div class="content-card-top"><div class="logo-box" style="width:96px;height:128px;border-radius:16px;">' +
      (record.poster
        ? '<img src="' +
          encodeAttr(safeImgUrl(record.poster)) +
          '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />'
        : "") +
      '</div><div class="card-main"><h2>' +
      escapeHtml(record.title) +
      '</h2><div class="card-subtitle">' +
      escapeHtml(buildMetaLine(record.raw) || record.sourceName) +
      '</div></div></div><p class="muted" style="margin-top:16px;line-height:1.5;">' +
      escapeHtml(record.raw.plot || record.raw.description || "Series overview.") +
      '</p><div class="detail-actions" style="margin-top:18px;"><button id="series-fav" class="btn focusable" type="button" tabindex="0">' +
      (isFavorite(record.uid) ? "Unfavorite" : "Favorite") +
      "</button></div></div>";
    var seasons = info.episodes || {};
    var keys = Object.keys(seasons);
    Array.prototype.forEach.call(keys, function (seasonKey) {
      var seasonName = seasonDisplayName(info, seasonKey, seasons[seasonKey], record.title);
      html +=
        '<div class="detail-card" style="margin-top:12px;"><div class="shelf-head"><div class="section-title">' +
        escapeHtml(seasonName) +
        '</div><div class="section-count">' +
        seasons[seasonKey].length +
        '</div></div><div class="episode-row">';
      Array.prototype.forEach.call(seasons[seasonKey], function (episode) {
        var epRecord = buildRecord("episode", episode, {
          id: episode.id,
          title: episodeLabel(episode),
          subtitle: "Season " + seasonKey + " · Episode " + (episode.episode_num || ""),
          playbackUrl: xtreamStreamUrl(
            activeSource(),
            "series",
            episode.id,
            episode.container_extension || "mp4"
          ),
          ext: episode.container_extension || "mp4"
        });
        epRecord.title = episodeLabel(episode);
        epRecord.seriesTitle = record.title;
        epRecord.playbackTitle = cleanEpisodePlaybackTitle(
          record.title,
          episode.title || episode.name,
          epRecord.title
        );
        html += posterCard(epRecord);
      });
      html += "</div></div>";
    });
    pane.innerHTML = html;
    document.getElementById("series-fav").addEventListener("click", function () {
      toggleFavorite(record);
    });
    bindRecordButtons(pane);
  }

  function episodeLabel(episode) {
    return "Episode " + (episode.episode_num || "");
  }

  function seasonDisplayName(info, seasonKey, episodes, seriesTitle) {
    var seasons = (info && info.seasons) || [];
    var key = String(seasonKey);
    var base = "Season " + key;
    var i;
    for (i = 0; i < seasons.length; i += 1) {
      var season = seasons[i] || {};
      if (
        String(season.season_number || season.season || season.number || "") === key
      ) {
        var providerName = trim(season.name || season.title || "");
        if (providerName) {
          base = providerName;
        }
        break;
      }
    }
    if (/^season\s*\d+$/i.test(base) && episodes && episodes.length) {
      var firstEpisode = episodes[0] || {};
      var firstTitle = cleanEpisodePlaybackTitle(
        seriesTitle,
        firstEpisode.title || firstEpisode.name,
        ""
      );
      if (firstTitle) {
        return base + " - " + firstTitle;
      }
    }
    return base;
  }

  function cleanEpisodePlaybackTitle(seriesTitle, episodeTitle, fallback) {
    var title = trim(episodeTitle || fallback || "");
    var escapedSeries = String(seriesTitle || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escapedSeries) {
      title = title.replace(new RegExp("^" + escapedSeries + "\\s*[-:|]\\s*", "i"), "");
    }
    title = title.replace(/^S\d{1,2}E\d{1,3}\s*[-:|]?\s*/i, "");
    return title || fallback || "Episode";
  }

  function renderSeriesEpisodesPage() {
    var record = state.recordsByUid[state.series.selectedUid];
    var cache = activeSourceCache();
    var info = record && cache ? cache.seriesInfo[record.seriesId] : null;
    if (!record) {
      state.series.selectedUid = null;
      renderSeries();
      return;
    }
    dom.workspace.innerHTML =
      '<div class="home-wrap"><div class="section-toolbar"><div class="section-title series-page-title">' +
      escapeHtml(record.title) +
      '</div><div><button id="series-back" class="btn focusable" type="button" tabindex="0">Back to series</button><button id="series-refresh-page" class="btn focusable" type="button" tabindex="0" style="margin-left:10px;">Refresh episodes</button></div></div><div class="detail-card"><p class="muted">' +
      escapeHtml(record.raw.plot || record.raw.description || "Series overview.") +
      '</p></div><div id="series-page-content"></div></div>';
    document.getElementById("series-back").addEventListener("click", function () {
      returnToSeriesGrid();
    });
    document.getElementById("series-refresh-page").addEventListener("click", function () {
      var localCache = activeSourceCache();
      if (localCache && record.seriesId) {
        delete localCache.seriesInfo[record.seriesId];
      }
      loadSeriesEpisodes();
      renderSeriesEpisodesPage();
    });
    if (!info) {
      document.getElementById("series-page-content").innerHTML =
        '<div class="status-box"><p>Loading episodes…</p></div>';
      loadSeriesEpisodes();
      return;
    }
    var html = "";
    var searchTxt = trim(state.searchQuery).toLowerCase();
    var seasons = info.episodes || {};
    var keys = Object.keys(seasons);
    if (!keys.length) {
      html = '<div class="status-box"><p>No episodes found.</p></div>';
    } else {
      Array.prototype.forEach.call(keys, function (seasonKey) {
        var seasonName = seasonDisplayName(info, seasonKey, seasons[seasonKey], record.title);
        var visibleEpisodes = seasons[seasonKey].filter(function (episode) {
          if (!searchTxt) {
            return true;
          }
          var hay = (
            (episode.title || "") +
            " " +
            (episode.plot || "") +
            " " +
            record.title
          ).toLowerCase();
          return hay.indexOf(searchTxt) !== -1;
        });
        if (!visibleEpisodes.length) {
          return;
        }
        html +=
          '<div class="detail-card" style="margin-top:14px;"><div class="shelf-head"><div class="section-title">' +
          escapeHtml(seasonName) +
          '</div><div class="section-count">' +
          visibleEpisodes.length +
          '</div></div><div class="episode-row">';
        Array.prototype.forEach.call(visibleEpisodes, function (episode) {
          var epRecord = buildRecord("episode", episode, {
            id: episode.id,
            title: episodeLabel(episode),
            subtitle: "Season " + seasonKey + " · Episode " + (episode.episode_num || ""),
            playbackUrl: xtreamStreamUrl(
              activeSource(),
              "series",
              episode.id,
              episode.container_extension || "mp4"
            ),
            ext: episode.container_extension || "mp4"
          });
          epRecord.title = episodeLabel(episode);
          epRecord.seriesTitle = record.title;
          epRecord.playbackTitle = cleanEpisodePlaybackTitle(
            record.title,
            episode.title || episode.name,
            epRecord.title
          );
          html += posterCard(epRecord);
        });
        html += "</div></div>";
      });
    }
    if (!html) {
      html = '<div class="status-box"><p>No episodes match this search.</p></div>';
    }
    document.getElementById("series-page-content").innerHTML = html;
    bindRecordButtons(document.getElementById("series-page-content"));
    focusFirst("#series-back");
  }

  function renderCollection(title, records) {
    var list = records.filter(function (record) {
      var q = trim(state.searchQuery).toLowerCase();
      if (!q) {
        return true;
      }
      var hay = (
        record.title +
        " " +
        (record.subtitle || "") +
        " " +
        (record.sourceName || "")
      ).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var html =
      '<div class="home-wrap"><div class="shelf-head"><div class="section-title">' +
      escapeHtml(title) +
      '</div><div class="section-count">' +
      list.length +
      "</div></div>";
    if (!list.length) {
      html += '<div class="status-box"><p>No items found.</p></div></div>';
      dom.workspace.innerHTML = html;
      return;
    }
    html += '<div class="grid-wrap">';
    Array.prototype.forEach.call(list, function (record) {
      html += posterCard(record);
    });
    html += "</div></div>";
    dom.workspace.innerHTML = html;
    bindRecordButtons(dom.workspace);
    queueRealtimeRatings(list);
    focusFirst(".poster-card");
  }

  function renderFavoritesSections() {
    var query = trim(state.searchQuery).toLowerCase();
    var sourceRecords = state.favorites.slice(0, 20);
    var moviesList = [];
    var seriesList = [];
    var liveList = [];
    var allForRatings = [];
    var html = '<div class="home-wrap">';

    sourceRecords.forEach(function (record) {
      if (query && !matchesRecordSearch(record, query)) {
        return;
      }
      if (record.view === "movies") {
        moviesList.push(record);
      } else if (record.view === "series" || record.view === "episode") {
        seriesList.push(record);
      } else if (record.view === "live") {
        liveList.push(record);
      }
    });

    html += buildShelfWithMessage("Favorite Movies", moviesList, "No favorite movies yet.");
    html += buildShelfWithMessage("Favorite Series", seriesList, "No favorite series yet.");
    html += buildShelfWithMessage("Favorite Live", liveList, "No favorite live channels yet.");
    html += "</div>";

    dom.workspace.innerHTML = html;
    bindRecordButtons(dom.workspace);
    allForRatings = moviesList.concat(seriesList, liveList);
    queueRealtimeRatings(allForRatings);
    focusFirst(".poster-card");
  }

  function renderSettings() {
    var html =
      '<div class="home-wrap settings-page"><div class="detail-card"><h2>Sources</h2><p class="muted">Manage your saved IPTV sources.</p><div id="settings-source-list"></div><div class="detail-actions" style="margin-top:16px;"><button id="settings-add-source" class="btn primary focusable" type="button" tabindex="0">Add source</button><button id="settings-refresh" class="btn focusable" type="button" tabindex="0">Refresh active source</button><button id="settings-clear-history" class="btn focusable" type="button" tabindex="0">Clear history</button><button id="settings-clear-data" class="btn focusable" type="button" tabindex="0">Clear all local data</button></div></div><div class="detail-card" style="margin-top:14px;"><h2>Playback</h2><p class="muted">Volume ' +
      Math.round(state.settings.volume * 100) +
      "% · Resume " +
      (state.settings.rememberPosition ? "On" : "Off") +
      '</p><div class="detail-actions" style="margin-top:16px;"><button id="settings-volume-down" class="btn focusable" type="button" tabindex="0">Volume -</button><button id="settings-volume-up" class="btn focusable" type="button" tabindex="0">Volume +</button><button id="settings-toggle-resume" class="btn focusable" type="button" tabindex="0">Toggle resume</button></div></div><div class="detail-card" style="margin-top:14px;"><h2>Streaming format</h2><p class="muted">Select preferred stream format for Live playback.</p><div class="settings-radio-group" role="radiogroup" aria-label="Streaming format"><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.liveStreamFormat === "ts" ? "true" : "false") +
      '" data-format-value="ts"><input type="radio" name="settings-stream-format" value="ts"' +
      (state.settings.liveStreamFormat === "ts" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>MPEGTS (.ts)</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.liveStreamFormat === "hls" ? "true" : "false") +
      '" data-format-value="hls"><input type="radio" name="settings-stream-format" value="hls"' +
      (state.settings.liveStreamFormat === "hls" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>HLS (.m3u8)</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.liveStreamFormat === "default" ? "true" : "false") +
      '" data-format-value="default"><input type="radio" name="settings-stream-format" value="default"' +
      (state.settings.liveStreamFormat === "default" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Default</span></label></div></div><div class="detail-card" style="margin-top:14px;"><h2>Card style</h2><p class="muted">Choose how content cards are rendered.</p><div class="settings-radio-group" role="radiogroup" aria-label="Card style"><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.cardDensity === "premium" ? "true" : "false") +
      '" data-density-value="premium"><input type="radio" name="settings-card-style" value="premium"' +
      (state.settings.cardDensity === "premium" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Premium</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.cardDensity === "compact" ? "true" : "false") +
      '" data-density-value="compact"><input type="radio" name="settings-card-style" value="compact"' +
      (state.settings.cardDensity === "compact" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Compact</span></label></div></div><div class="detail-card" style="margin-top:14px;"><h2>Theme</h2><p class="muted">Choose visual appearance.</p><div class="settings-radio-group" role="radiogroup" aria-label="Theme"><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.theme === "dark" ? "true" : "false") +
      '" data-theme-value="dark"><input type="radio" name="settings-theme" value="dark"' +
      (state.settings.theme === "dark" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Dark</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.theme === "light" ? "true" : "false") +
      '" data-theme-value="light"><input type="radio" name="settings-theme" value="light"' +
      (state.settings.theme === "light" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Light</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.theme === "oled" ? "true" : "false") +
      '" data-theme-value="oled"><input type="radio" name="settings-theme" value="oled"' +
      (state.settings.theme === "oled" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>OLED Neon</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.theme === "magenta" ? "true" : "false") +
      '" data-theme-value="magenta"><input type="radio" name="settings-theme" value="magenta"' +
      (state.settings.theme === "magenta" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Purple Magenta</span></label><label class="settings-radio-option focusable" tabindex="0" role="radio" aria-checked="' +
      (state.settings.theme === "aurora" ? "true" : "false") +
      '" data-theme-value="aurora"><input type="radio" name="settings-theme" value="aurora"' +
      (state.settings.theme === "aurora" ? " checked" : "") +
      ' /><span class="settings-radio-dot"></span><span>Aurora</span></label></div></div><div class="detail-card" style="margin-top:14px;"><h2>System controls</h2><p class="muted">Startup and account session actions.</p><div class="detail-actions" style="margin-top:16px;"><button id="settings-fast-startup" class="btn focusable" type="button" tabindex="0">Fast startup: ' +
      (state.settings.fastStartup !== false ? "ON" : "OFF") +
      '</button><button id="settings-force-logout" class="btn focusable" type="button" tabindex="0">Force logout</button></div></div>' +
      '<div class="detail-card" style="margin-top:14px;"><h2>Subtitles</h2><p class="muted">English subtitles via OpenSubtitles.com. Get a free API key at <b>opensubtitles.com</b> &rarr; Account Settings.</p><div class="detail-actions" style="margin-top:12px;"><label class="settings-input-label">OpenSubtitles API Key</label><input id="settings-os-api-key" class="settings-text-input focusable" type="text" tabindex="0" placeholder="Paste your API key here" value="' +
      escapeHtml(state.settings.osApiKey || "") +
      '" /></div></div>' +
      '<div class="detail-card" style="margin-top:14px;"><h2>Ratings</h2><p class="muted">Movie and series scores come from IMDb via OMDb. Get a free key at <b>omdbapi.com</b> &rarr; API Key. Without your own key the shared demo key is used, which is rate limited and often returns nothing.</p><div class="detail-actions" style="margin-top:12px;"><label class="settings-input-label">OMDb API Key</label><input id="settings-omdb-api-key" class="settings-text-input focusable" type="text" tabindex="0" placeholder="Paste your API key here" value="' +
      escapeHtml(state.settings.omdbApiKey || "") +
      '" /></div><div class="detail-actions" style="margin-top:12px;"><button id="settings-clear-ratings" class="btn focusable" type="button" tabindex="0">Clear cached ratings</button></div></div></div>';
    dom.workspace.innerHTML = html;
    var sourceHtml = "";
    Array.prototype.forEach.call(state.sources, function (source) {
      sourceHtml +=
        '<div class="source-item ' +
        (source.id === state.activeSourceId ? "active" : "") +
        '" style="margin-top:10px;"><div class="source-item-main"><span>' +
        escapeHtml(source.name) +
        '</span><span class="source-subline">' +
        escapeHtml(source.type === "xtream" ? source.server : source.url) +
        '</span></div><div class="source-item-actions"><button class="btn focusable source-edit-btn" type="button" tabindex="0" data-edit-source-id="' +
        escapeHtml(source.id) +
        '">Edit</button><button class="btn focusable source-delete-btn" type="button" tabindex="0" data-delete-source-id="' +
        escapeHtml(source.id) +
        '">Delete</button></div></div>';
    });
    document.getElementById("settings-source-list").innerHTML =
      sourceHtml || '<p class="muted">No sources saved.</p>';
    document.getElementById("settings-add-source").addEventListener("click", function () {
      window.location.replace("login.html?add=1");
    });
    document.getElementById("settings-refresh").addEventListener("click", function () {
      refreshAllViews().then(function () {
        showToast("Source cache refreshed", true);
        renderSettings();
      });
    });
    document.getElementById("settings-clear-history").addEventListener("click", function () {
      state.history = [];
      saveHistory();
      renderSettings();
    });
    document.getElementById("settings-clear-data").addEventListener("click", function () {
      clearAllLocalData();
    });
    document.getElementById("settings-volume-down").addEventListener("click", function () {
      changeVolume(-0.05);
      renderSettings();
    });
    document.getElementById("settings-volume-up").addEventListener("click", function () {
      changeVolume(0.05);
      renderSettings();
    });
    document.getElementById("settings-toggle-resume").addEventListener("click", function () {
      state.settings.rememberPosition = !state.settings.rememberPosition;
      saveSettings();
      renderSettings();
    });
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-format-value]"),
      function (label) {
        label.addEventListener("click", function () {
          var value = label.getAttribute("data-format-value");
          if (!value || state.settings.liveStreamFormat === value) {
            return;
          }
          state.settings.liveStreamFormat = value;
          saveSettings();
          renderSettings();
          focusFirst('[data-format-value="' + value + '"]');
        });
      }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-density-value]"),
      function (label) {
        label.addEventListener("click", function () {
          var value = label.getAttribute("data-density-value");
          if (!value || state.settings.cardDensity === value) {
            return;
          }
          state.settings.cardDensity = value;
          saveSettings();
          renderSettings();
          focusFirst('[data-density-value="' + value + '"]');
        });
      }
    );
    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-value]"), function (label) {
      label.addEventListener("click", function () {
        var value = label.getAttribute("data-theme-value");
        if (!value || state.settings.theme === value) {
          return;
        }
        state.settings.theme = value;
        saveSettings();
        renderSettings();
        focusFirst('[data-theme-value="' + value + '"]');
      });
    });
    document.getElementById("settings-fast-startup").addEventListener("click", function () {
      state.settings.fastStartup = !(state.settings.fastStartup !== false);
      saveSettings();
      renderSettings();
    });
    document.getElementById("settings-force-logout").addEventListener("click", function () {
      forceLogout();
    });
    var osKeyInput = document.getElementById("settings-os-api-key");
    if (osKeyInput) {
      osKeyInput.addEventListener("change", function () {
        state.settings.osApiKey = osKeyInput.value.trim();
        saveSettings();
      });
      osKeyInput.addEventListener("blur", function () {
        state.settings.osApiKey = osKeyInput.value.trim();
        saveSettings();
      });
    }
    var omdbKeyInput = document.getElementById("settings-omdb-api-key");
    if (omdbKeyInput) {
      var saveOmdbKey = function () {
        var next = omdbKeyInput.value.trim();
        if (next === state.settings.omdbApiKey) {
          return;
        }
        state.settings.omdbApiKey = next;
        saveSettings();
        clearRatingCache();
        showToast("Rating key saved", true);
      };
      omdbKeyInput.addEventListener("change", saveOmdbKey);
      omdbKeyInput.addEventListener("blur", saveOmdbKey);
    }
    var clearRatingsBtn = document.getElementById("settings-clear-ratings");
    if (clearRatingsBtn) {
      clearRatingsBtn.addEventListener("click", function () {
        clearRatingCache();
        showToast("Cached ratings cleared", true);
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll(".source-edit-btn"), function (btn) {
      btn.addEventListener("click", function () {
        openSourceModal(btn.getAttribute("data-edit-source-id"));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".source-delete-btn"), function (btn) {
      btn.addEventListener("click", function () {
        deleteSource(btn.getAttribute("data-delete-source-id"));
      });
    });
  }

  function isFavorite(uid) {
    var i;
    for (i = 0; i < state.favorites.length; i++) {
      if (state.favorites[i].uid === uid) {
        return true;
      }
    }
    return false;
  }

  function toggleFavorite(record, inPlace) {
    var next = [];
    var found = false;
    Array.prototype.forEach.call(state.favorites, function (entry) {
      if (entry.uid === record.uid) {
        found = true;
      } else {
        next.push(entry);
      }
    });
    if (!found) {
      next.unshift(record);
      showToast("Added to favorites", true);
    } else {
      showToast("Removed from favorites", false);
    }
    state.favorites = next.slice(0, 20);
    saveFavorites();
    if (state.overlay.record && state.overlay.record.uid === record.uid) {
      setOverlayFavoriteButton(isFavorite(record.uid));
    }
    if (inPlace) {
      // Re-rendering here would tear down the running player and blank the pane
      var inlineFav = document.getElementById("inline-ov-fav");
      if (inlineFav && state.inline.record && state.inline.record.uid === record.uid) {
        inlineFav.innerHTML = mediaControlIconSvg("favorite", isFavorite(record.uid));
      }
      return;
    }
    renderCurrentView();
  }

  function pushHistory(record) {
    var next = [record];
    Array.prototype.forEach.call(state.history, function (entry) {
      if (entry.uid !== record.uid) {
        next.push(entry);
      }
    });
    state.history = next.slice(0, 200);
    saveHistory();
  }

  function clearSearchForSelection() {
    if (!trim(state.searchQuery)) {
      return;
    }
    // Invalidate every pending scan/fetch callback before changing the view.
    state.homeSearch.token += 1;
    state.homeSearch.loading = false;
    state.homeSearch.results = [];
    state.homeSearch.lastQuery = "";
    state.homeSearch.focused = false;
    state.searchQuery = "";
    if (dom.search) {
      dom.search.value = "";
    }
  }

  function movieInfoValue(record, info, names, fallback) {
    var raw = (record && record.raw) || {};
    var data = info || {};
    var i;
    for (i = 0; i < names.length; i += 1) {
      if (data[names[i]] !== undefined && trim(data[names[i]]) !== "") {
        return data[names[i]];
      }
      if (raw[names[i]] !== undefined && trim(raw[names[i]]) !== "") {
        return raw[names[i]];
      }
    }
    return fallback || "";
  }

  function formatMovieReleaseDate(value) {
    var text = trim(String(value || ""));
    var match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    var months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    if (match) {
      return parseInt(match[3], 10) + "-" + months[parseInt(match[2], 10) - 1] + "-" + match[1];
    }
    return text || "Not available";
  }

  function movieYearValue(record, info) {
    var text = trim(String(movieInfoValue(record, info, ["releasedate", "release_date", "year"], "")));
    var match = text.match(/(19|20)\d{2}/);
    return match ? match[0] : "";
  }

  function formatMovieDuration(record, info) {
    var secs = parseInt(movieInfoValue(record, info, ["duration_secs", "episode_run_time"], ""), 10);
    var text = trim(String(movieInfoValue(record, info, ["duration", "runtime"], "")));
    var parts;
    var mins = 0;
    if (secs > 0) {
      mins = Math.round(secs / 60);
    } else if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(text)) {
      parts = text.split(":");
      mins =
        parts.length === 3
          ? parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
          : parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    } else if (/^\d+$/.test(text)) {
      mins = parseInt(text, 10);
    }
    if (!mins) {
      return text;
    }
    var hours = Math.floor(mins / 60);
    return (hours ? hours + "h " : "") + (mins % 60) + "min";
  }

  function movieBackdropUrl(record, info) {
    var data = info || {};
    var raw = (record && record.raw) || {};
    var back = data.backdrop_path || data.backdrop || raw.backdrop_path || raw.backdrop;
    if (Object.prototype.toString.call(back) === "[object Array]") {
      back = back.length ? back[0] : "";
    }
    back = trim(String(back || ""));
    if (/^\//.test(back)) {
      back = "https://image.tmdb.org/t/p/w1280" + back;
    }
    if (!back) {
      back = trim(
        String(movieInfoValue(record, info, ["cover_big", "movie_image", "cover", "stream_icon"], record.poster || ""))
      );
    }
    return back ? safeImgUrl(back) : "";
  }

  function movieActorNames(cast, limit) {
    var list = cast;
    var names = [];
    var i;
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch (e) {
        list = list.split(",");
      }
    }
    if (Object.prototype.toString.call(list) !== "[object Array]") {
      list = String(list || "").split(",");
    }
    for (i = 0; i < list.length && names.length < (limit || 4); i += 1) {
      var name = typeof list[i] === "object" ? trim(list[i].name || list[i].character || "") : trim(list[i]);
      if (name) {
        names.push(name);
      }
    }
    return names.join(", ");
  }

  function castImageUrl(value) {
    var url = trim(String(value || ""));
    if (/^\//.test(url)) {
      url = "https://image.tmdb.org/t/p/w185" + url;
    }
    return safeImgUrl(url);
  }

  function movieCastHtml(cast) {
    var list = cast;
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch (e) {
        list = list.split(",");
      }
    }
    if (Object.prototype.toString.call(list) !== "[object Array]") {
      list = String(list || "").split(",");
    }
    var html = "";
    var i;
    for (i = 0; i < list.length && i < 12; i += 1) {
      var actor = list[i];
      var name = typeof actor === "object" ? actor.name || actor.character || "" : trim(actor);
      var image = typeof actor === "object" ? castImageUrl(actor.profile_path || actor.profile || actor.image || actor.photo || actor.avatar || actor.image_url) : "";
      if (!name) continue;
      html +=
        '<div class="movie-cast-person">' +
        '<div class="movie-cast-photo" data-cast-name="' + encodeAttr(name) + '">' +
        '<span>' + escapeHtml(name.charAt(0).toUpperCase()) + "</span>" +
        (image ? '<img src="' + encodeAttr(image) + '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />' : "") +
        "</div><div>" +
        escapeHtml(name) +
        "</div></div>";
    }
    return html || '<div class="muted">Cast information is not available.</div>';
  }

  function hydrateMovieCastPhotos(modal) {
    var nodes = modal ? modal.querySelectorAll(".movie-cast-photo[data-cast-name]") : [];
    var index = 0;
    var limit = Math.min(8, nodes.length);

    function next() {
      if (!state.movieDetail.open || index >= limit) return;
      var node = nodes[index++];
      var name;
      try {
        name = decodeURIComponent(node.getAttribute("data-cast-name") || "");
      } catch (e) {
        name = node.getAttribute("data-cast-name") || "";
      }
      if (!name || node.querySelector("img")) {
        next();
        return;
      }
      fetchJSON(
        "https://en.wikipedia.org/api/rest_v1/page/summary/" +
          encodeURIComponent(name.replace(/\s+/g, "_"))
      ).then(
        function (data) {
          var image = data && data.thumbnail ? data.thumbnail.source : "";
          if (image && state.movieDetail.open && node.parentNode) {
            var photo = document.createElement("img");
            photo.src = safeImgUrl(image);
            photo.setAttribute("referrerpolicy", "no-referrer");
            photo.onerror = function () {
              if (photo.parentNode) photo.parentNode.removeChild(photo);
            };
            node.appendChild(photo);
          }
          next();
        },
        function () {
          next();
        }
      );
    }
    next();
  }

  var trailerState = { open: false, expanded: false, record: null, trailer: null };

  // Providers send anything from a bare YouTube id to a watch URL or an mp4.
  function parseTrailer(value) {
    var raw = trim(String(value || ""));
    if (!raw) {
      return null;
    }
    if (raw.indexOf("//") === 0) {
      raw = "https:" + raw;
    }
    if (/\.(mp4|m3u8|webm)(\?|$)/i.test(raw)) {
      return { kind: "video", url: raw };
    }
    var id = "";
    var match = raw.match(
      /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    if (match) {
      id = match[1];
    } else if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
      id = raw;
    }
    if (!id) {
      return null;
    }
    return {
      kind: "youtube",
      id: id,
      url:
        "https://www.youtube.com/embed/" +
        id +
        "?autoplay=1&rel=0&modestbranding=1&playsinline=1&controls=0&enablejsapi=1"
    };
  }

  // The YouTube iframe cannot be reached with a remote, so playback is driven
  // from our own buttons. The official IFrame API is used when it loads (it
  // handles the origin/handshake dance and reports real state); the raw
  // postMessage protocol stays as a fallback.
  var ytApi = { loading: false, settled: false, waiting: [] };

  function settleYouTubeApi(ok) {
    if (ytApi.settled) {
      return;
    }
    ytApi.settled = true;
    var list = ytApi.waiting;
    var i;
    ytApi.waiting = [];
    for (i = 0; i < list.length; i += 1) {
      list[i](ok);
    }
  }

  function ensureYouTubeApi(callback) {
    if (window.YT && window.YT.Player) {
      callback(true);
      return;
    }
    ytApi.waiting.push(callback);
    if (ytApi.loading) {
      return;
    }
    ytApi.loading = true;
    var previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof previous === "function") {
        try {
          previous();
        } catch (e) {}
      }
      settleYouTubeApi(true);
    };
    var script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = function () {
      settleYouTubeApi(false);
    };
    document.body.appendChild(script);
    setTimeout(function () {
      settleYouTubeApi(!!(window.YT && window.YT.Player));
    }, 8000);
  }

  function trailerFramePost(payload) {
    var frame = document.getElementById("trailer-frame");
    if (!frame || !frame.contentWindow) {
      return;
    }
    try {
      frame.contentWindow.postMessage(payload, "*");
    } catch (e) {}
  }

  function trailerFrameCommand(func) {
    trailerFramePost('{"event":"command","func":"' + func + '","args":[]}');
  }

  // YouTube discards every command until the embedding page announces itself.
  function trailerFrameHandshake() {
    trailerFramePost('{"event":"listening","id":"trailer-frame","channel":"widget"}');
  }

  function showTrailerNote(message) {
    var note = document.getElementById("trailer-note");
    if (note) {
      note.textContent = message;
      note.style.display = "block";
    }
  }

  function startTrailerFallbackFrame(trailer) {
    var mount = document.getElementById("trailer-frame-wrap");
    if (!mount) {
      return;
    }
    mount.innerHTML =
      '<iframe id="trailer-frame" tabindex="-1" frameborder="0" allow="autoplay" allowfullscreen src="' +
      encodeAttr(trailer.url) +
      '"></iframe>';
    var delays = [400, 1000, 2000, 3200];
    var i;
    for (i = 0; i < delays.length; i += 1) {
      setTimeout(function () {
        if (!trailerState.open || trailerState.userPaused) {
          return;
        }
        trailerFrameHandshake();
        trailerFrameCommand("playVideo");
      }, delays[i]);
    }
    setTimeout(function () {
      if (trailerState.open && !trailerState.userPaused) {
        trailerFrameCommand("playVideo");
      }
    }, 3600);
  }

  // window.webOS only exists when webOSTV.js is bundled, so it is NOT a reliable
  // TV probe. PalmSystem/PalmServiceBridge are injected natively by the platform.
  function isWebOSRuntime() {
    if (window.PalmSystem || window.PalmServiceBridge) {
      return true;
    }
    if (window.webOS && window.webOS.service && window.webOS.service.request) {
      return true;
    }
    return /web0s|webos/i.test(navigator.userAgent || "");
  }

  // A packaged app is served from file://, so the browser sends no http(s)
  // origin/referrer and YouTube refuses the embed ("error 153 / video player
  // configuration error"). No embed parameter can work around that.
  function canEmbedYouTube() {
    return !isWebOSRuntime() && location.protocol !== "file:";
  }

  // Luna bridge that does not need webOSTV.js: PalmServiceBridge is native.
  function lunaRequest(uri, method, params, onSuccess, onFailure) {
    try {
      if (window.webOS && window.webOS.service && window.webOS.service.request) {
        window.webOS.service.request(uri, {
          method: method,
          parameters: params || {},
          onSuccess: onSuccess || function () {},
          onFailure: onFailure || function () {}
        });
        return true;
      }
    } catch (e) {}
    try {
      if (window.PalmServiceBridge) {
        var bridge = new window.PalmServiceBridge();
        var settled = false;
        bridge.onservicecallback = function (message) {
          if (settled) {
            return;
          }
          settled = true;
          var reply = {};
          try {
            reply = JSON.parse(message || "{}");
          } catch (e2) {}
          if (reply.returnValue === false || reply.errorCode) {
            if (onFailure) onFailure(reply);
          } else if (onSuccess) {
            onSuccess(reply);
          }
        };
        bridge.call(uri + "/" + method, JSON.stringify(params || {}));
        return true;
      }
    } catch (e3) {}
    return false;
  }

  function startTrailerFrame(trailer) {
    trailerState.retries = 0;
    trailerState.userPaused = false;
    trailerState.mutedFallback = false;
    trailerState.fallbackShown = false;
    if (!canEmbedYouTube()) {
      showTrailerUnplayable(trailer);
      return;
    }
    ensureYouTubeApi(function (ok) {
      if (!trailerState.open || trailerState.trailer !== trailer) {
        return;
      }
      if (!ok) {
        startTrailerFallbackFrame(trailer);
        return;
      }
      try {
        trailerState.player = new YT.Player("trailer-frame", {
          width: "100%",
          height: "100%",
          videoId: trailer.id,
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            fs: 0,
            modestbranding: 1,
            playsinline: 1,
            iv_load_policy: 3
          },
          events: {
            onReady: function (event) {
              try {
                event.target.unMute();
                event.target.setVolume(Math.round(state.settings.volume * 100));
                event.target.playVideo();
              } catch (e) {}
              startTrailerAutoplayWatchdog();
            },
            onStateChange: onTrailerPlayerState,
            onError: function () {
              showTrailerUnplayable(trailer);
            }
          }
        });
      } catch (e2) {
        startTrailerFallbackFrame(trailer);
      }
    });
  }

  // Sound-on autoplay is refused by some engines. If nothing is rolling shortly
  // after start, drop to a muted start so the viewer always sees the trailer.
  function startTrailerAutoplayWatchdog() {
    setTimeout(function () {
      var player = trailerState.player;
      if (!trailerState.open || !player || trailerState.mutedFallback) {
        return;
      }
      var playerState = -1;
      try {
        playerState = player.getPlayerState();
      } catch (e) {}
      if (playerState === 1 || playerState === 3) {
        return;
      }
      trailerState.mutedFallback = true;
      try {
        player.mute();
        player.playVideo();
      } catch (e2) {}
    }, 1500);
    // A webOS app is served from file://, and YouTube refuses to render an
    // embed without a real http(s) referrer (blank frame or "error 153").
    setTimeout(function () {
      var player = trailerState.player;
      if (!trailerState.open || !player || trailerState.userPaused) {
        return;
      }
      var playerState = -1;
      try {
        playerState = player.getPlayerState();
      } catch (e3) {}
      if (playerState !== 1 && playerState !== 3) {
        showTrailerUnplayable(trailerState.trailer);
      }
    }, 6500);
  }

  var YOUTUBE_APP_IDS = ["youtube.leanback.v4", "com.webos.app.youtube", "youtube.leanback.v3"];

  function openYouTubeApp(id) {
    var attempt = 0;

    function launchNext() {
      if (attempt >= YOUTUBE_APP_IDS.length) {
        showTrailerNote("The YouTube app is not available on this TV.");
        return;
      }
      var appId = YOUTUBE_APP_IDS[attempt];
      attempt += 1;
      var sent = lunaRequest(
        "luna://com.webos.applicationManager",
        "launch",
        { id: appId, params: { contentTarget: "v=" + id } },
        function () {
          showTrailerNote("Opening the trailer in the YouTube app...");
        },
        launchNext
      );
      if (!sent) {
        showTrailerNote("The YouTube app is not available on this TV.");
      }
    }

    showTrailerNote("Starting the YouTube app...");
    launchNext();
  }

  function showTrailerUnplayable(trailer) {
    var stage = document.querySelector(".trailer-stage");
    if (!stage || trailerState.fallbackShown || !trailer) {
      return;
    }
    trailerState.fallbackShown = true;
    if (trailerState.player) {
      try {
        trailerState.player.destroy();
      } catch (e) {}
      trailerState.player = null;
    }
    stage.innerHTML =
      '<div class="trailer-fallback"><p>YouTube blocks embedded playback inside TV apps, so this trailer ' +
      "cannot run in the player here.</p>" +
      '<button id="trailer-open-yt" class="btn primary focusable" type="button" tabindex="0">' +
      "Open in YouTube app</button></div>" +
      '<div id="trailer-note" class="trailer-note"></div>';
    var open = document.getElementById("trailer-open-yt");
    if (open) {
      open.addEventListener("click", function () {
        openYouTubeApp(trailer.id);
      });
      focusNode(open);
    }
    setTrailerPlaying(false);
  }

  function onTrailerPlayerState(event) {
    var player = trailerState.player;
    if (!trailerState.open || !player) {
      return;
    }
    if (event.data === 1) {
      setTrailerPlaying(true);
      return;
    }
    if (event.data === 0) {
      setTrailerPlaying(false);
      return;
    }
    if (event.data === 2) {
      // The embed often self-pauses a second after an autoplay start; nudge it
      // back unless the viewer was the one who paused.
      if (!trailerState.userPaused && trailerState.retries < 3) {
        trailerState.retries += 1;
        setTimeout(function () {
          if (trailerState.open && !trailerState.userPaused && trailerState.player) {
            try {
              trailerState.player.playVideo();
            } catch (e3) {}
          }
        }, 250);
        return;
      }
      setTrailerPlaying(false);
    }
  }

  function setTrailerPlaying(playing) {
    trailerState.playing = !!playing;
    var btn = document.getElementById("trailer-playpause");
    if (!btn) {
      return;
    }
    btn.innerHTML = mediaControlIconSvg(trailerState.playing ? "pause" : "play", true);
    btn.setAttribute("title", trailerState.playing ? "Pause" : "Play");
  }

  function toggleTrailerPlayback() {
    if (!trailerState.open) {
      return;
    }
    var video = document.getElementById("trailer-video");
    if (video) {
      if (video.paused) {
        tryPlay(video);
        setTrailerPlaying(true);
      } else {
        video.pause();
        setTrailerPlaying(false);
      }
      return;
    }
    var wantPlay = !trailerState.playing;
    trailerState.userPaused = !wantPlay;
    var player = trailerState.player;
    if (player && typeof player.playVideo === "function") {
      try {
        if (wantPlay) {
          player.playVideo();
        } else {
          player.pauseVideo();
        }
      } catch (e) {}
      setTrailerPlaying(wantPlay);
      return;
    }
    trailerFrameHandshake();
    trailerFrameCommand(wantPlay ? "playVideo" : "pauseVideo");
    setTrailerPlaying(wantPlay);
  }

  function trailerStageHtml(trailer) {
    if (trailer.kind === "video") {
      return (
        '<video id="trailer-video" class="trailer-video" preload="auto" ' +
        'playsinline webkit-playsinline tabindex="-1"></video>'
      );
    }
    // The API replaces the inner mount node with its own iframe.
    return '<div id="trailer-frame-wrap" class="trailer-frame"><div id="trailer-frame"></div></div>';
  }

  // Try with sound first (webOS allows it); fall back to a muted start rather
  // than leaving the viewer with a still frame.
  function playTrailerVideo(video) {
    var promise;
    try {
      promise = video.play();
    } catch (e) {
      promise = null;
    }
    if (promise && typeof promise.then === "function") {
      promise.then(
        function () {},
        function () {
          // Sound-on autoplay refused: a muted start beats a frozen frame.
          video.muted = true;
          try {
            video.play();
          } catch (e2) {}
        }
      );
    }
  }

  function startTrailerVideo(trailer) {
    var video = document.getElementById("trailer-video");
    if (!video) {
      return;
    }
    video.muted = false;
    video.volume = state.settings.volume;
    if (isHlsUrl(trailer.url) && !canUseNativeHls(video) && window.Hls && Hls.isSupported()) {
      trailerState.hls = new Hls({ enableWorker: false });
      trailerState.hls.loadSource(trailer.url);
      trailerState.hls.attachMedia(video);
      trailerState.hls.on(Hls.Events.MANIFEST_PARSED, function () {
        playTrailerVideo(video);
      });
      return;
    }
    video.src = trailer.url;
    video.oncanplay = function () {
      playTrailerVideo(video);
    };
    video.onplay = function () {
      setTrailerPlaying(true);
    };
    video.onpause = function () {
      setTrailerPlaying(false);
    };
    video.onerror = function () {
      var note = document.getElementById("trailer-note");
      if (note) {
        note.textContent = "This trailer could not be played.";
        note.style.display = "block";
      }
    };
  }

  function openTrailerPopup(record, trailer) {
    if (!trailer) {
      return;
    }
    closeTrailerPopup(false);
    var modal = document.getElementById("trailer-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "trailer-modal";
      document.body.appendChild(modal);
    }
    trailerState.open = true;
    trailerState.expanded = false;
    trailerState.record = record;
    trailerState.trailer = trailer;
    var playable = trailer.kind === "video" || canEmbedYouTube();
    modal.className = "trailer-modal open";
    modal.innerHTML =
      '<div class="trailer-card"><div class="trailer-head">' +
      '<div class="trailer-title">Trailer - ' +
      escapeHtml(record.title) +
      "</div>" +
      (playable
        ? '<button id="trailer-playpause" class="btn icon-only focusable" type="button" tabindex="0" title="Pause">' +
          mediaControlIconSvg("pause", true) +
          "</button>" +
          '<button id="trailer-expand" class="btn icon-only focusable" type="button" tabindex="0" title="Expand">' +
          mediaControlIconSvg("fullscreen") +
          "</button>"
        : "") +
      '<button id="trailer-close" class="btn icon-only focusable" type="button" tabindex="0" title="Close">' +
      mediaControlIconSvg("close") +
      "</button></div>" +
      '<div class="trailer-stage">' +
      trailerStageHtml(trailer) +
      '<div id="trailer-note" class="trailer-note"></div></div>' +
      '<div class="trailer-hint">Arrow keys move &middot; OK play/pause &middot; BACK to close</div>' +
      "</div>";
    setTrailerPlaying(true);
    if (trailer.kind === "video") {
      startTrailerVideo(trailer);
    } else {
      startTrailerFrame(trailer);
    }
    var playPause = document.getElementById("trailer-playpause");
    var expand = document.getElementById("trailer-expand");
    if (playPause) {
      playPause.addEventListener("click", toggleTrailerPlayback);
    }
    if (expand) {
      expand.addEventListener("click", toggleTrailerExpanded);
    }
    document.getElementById("trailer-close").addEventListener("click", function () {
      closeTrailerPopup(true);
    });
    setTimeout(function () {
      if (!trailerState.open || trailerState.fallbackShown) {
        return;
      }
      var play = document.getElementById("trailer-playpause") || document.getElementById("trailer-close");
      if (play) focusNode(play);
    }, 60);
  }

  function toggleTrailerExpanded() {
    var modal = document.getElementById("trailer-modal");
    if (!trailerState.open || !modal) {
      return;
    }
    trailerState.expanded = !trailerState.expanded;
    modal.className = "trailer-modal open" + (trailerState.expanded ? " trailer-expanded" : "");
    var expand = document.getElementById("trailer-expand");
    if (expand) {
      expand.setAttribute("title", trailerState.expanded ? "Restore" : "Expand");
      focusNode(expand);
    }
  }

  function closeTrailerPopup(restoreFocus) {
    var modal = document.getElementById("trailer-modal");
    if (!trailerState.open) {
      return;
    }
    trailerState.open = false;
    trailerState.expanded = false;
    trailerState.playing = false;
    trailerState.mutedFallback = false;
    trailerState.fallbackShown = false;
    trailerState.userPaused = false;
    trailerState.retries = 0;
    trailerState.record = null;
    trailerState.trailer = null;
    if (trailerState.player) {
      try {
        trailerState.player.destroy();
      } catch (e0) {}
      trailerState.player = null;
    }
    if (trailerState.hls) {
      try {
        trailerState.hls.destroy();
      } catch (e) {}
      trailerState.hls = null;
    }
    var video = document.getElementById("trailer-video");
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (e2) {}
    }
    // Blanking the frame first stops YouTube audio before the node is dropped.
    var frame = document.getElementById("trailer-frame");
    if (frame) {
      try {
        frame.src = "about:blank";
      } catch (e3) {}
    }
    if (modal) {
      modal.className = "trailer-modal";
      modal.innerHTML = "";
    }
    if (restoreFocus !== false) {
      setTimeout(function () {
        var btn =
          document.getElementById("movie-detail-trailer") ||
          document.getElementById("movie-detail-play");
        if (btn) focusNode(btn);
      }, 60);
    }
  }

  function renderMovieDetails(record, info, list, index) {
    var modal = document.getElementById("movie-detail-modal");
    if (!modal || !state.movieDetail.open || state.movieDetail.record !== record) {
      return;
    }
    var director = movieInfoValue(record, info, ["director", "directed_by"], "Not available");
    var duration = formatMovieDuration(record, info);
    var genre = trim(String(movieInfoValue(record, info, ["genre", "category_name"], "")));
    var country = trim(String(movieInfoValue(record, info, ["country", "o_name", "origin_country"], "")));
    var year = movieYearValue(record, info);
    var releaseDate = formatMovieReleaseDate(movieInfoValue(record, info, ["releasedate", "release_date", "year"], ""));
    var summary = movieInfoValue(record, info, ["plot", "description", "overview"], "No summary is available for this movie.");
    var poster = movieInfoValue(record, info, ["movie_image", "cover_big", "cover", "stream_icon"], record.poster);
    var backdrop = movieBackdropUrl(record, info);
    var castValue = movieInfoValue(record, info, ["cast", "actors"], "");
    var actors = movieActorNames(castValue, 4);
    var rating = ratingValueFromItem(info || record.raw || {}) || ratingValueFromItem(record.raw || {});
    var ratingText = rating > 0 ? rating.toFixed(1) + " / 10" : "Not rated";
    var starCount = rating > 0 ? Math.max(1, Math.min(5, Math.round(rating / 2))) : 0;
    var stars = starCount ? "★★★★★".slice(0, starCount) + "☆☆☆☆☆".slice(starCount) : "☆☆☆☆☆";
    var trailer = parseTrailer(
      movieInfoValue(record, info, ["youtube_trailer", "trailer", "trailer_url"], "")
    );
    var displayTitle = record.title;
    var favorite = isFavorite(record.uid);
    var resume = state.positions[record.uid];
    var resumePercent = 0;
    var hasResume = !!(
      resume &&
      resume.currentTime > 10 &&
      resume.duration > 120 &&
      resume.currentTime < resume.duration - 20
    );
    if (hasResume) {
      resumePercent = Math.max(0, Math.min(100, (resume.currentTime / resume.duration) * 100));
    }
    var chips = "";
    if (year) {
      chips += '<span class="mv-chip">' + escapeHtml(year) + "</span>";
    }
    if (genre) {
      chips += '<span class="mv-chip">' + escapeHtml(genre) + "</span>";
    }
    if (duration) {
      chips += '<span class="mv-chip">' + escapeHtml(duration) + "</span>";
    }
    if (rating > 0) {
      chips += '<span class="mv-chip mv-chip-star">★ ' + escapeHtml(rating.toFixed(1)) + "</span>";
    }
    if (country) {
      chips += '<span class="mv-chip">' + escapeHtml(country) + "</span>";
    }
    modal.innerHTML =
      '<div class="movie-detail-shell">' +
      '<div class="mv-hero">' +
      (backdrop
        ? '<img src="' + encodeAttr(backdrop) + '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />'
        : "") +
      '<div class="mv-hero-fade"></div><div class="mv-hero-fade-left"></div>' +
      "</div>" +
      '<div class="mv-body">' +
      '<button id="movie-detail-close" class="mv-back focusable" type="button" tabindex="0" title="Back">' +
      mediaControlIconSvg("back") +
      "</button>" +
      '<div class="mv-main"><aside class="mv-poster-col">' +
      '<div class="mv-poster">' +
      (poster
        ? '<img src="' + encodeAttr(safeImgUrl(poster)) + '" referrerpolicy="no-referrer" onerror="imgFallback(this)" />'
        : '<div class="movie-detail-poster-empty">No poster</div>') +
      "</div>" +
      '<div class="movie-detail-rating"><span class="movie-stars">' +
      stars +
      "</span><span>" +
      escapeHtml(ratingText) +
      "</span></div></aside>" +
      '<section class="mv-content">' +
      '<h1 class="mv-title">' + escapeHtml(displayTitle) + "</h1>" +
      '<div class="mv-chips">' + chips + "</div>" +
      '<p class="mv-plot">' + escapeHtml(summary) + "</p>" +
      '<div class="mv-meta">' +
      (actors ? '<div class="mv-meta-item"><span>Actors</span><b>' + escapeHtml(actors) + "</b></div>" : "") +
      '<div class="mv-meta-item"><span>Director</span><b>' + escapeHtml(director) + "</b></div>" +
      '<div class="mv-meta-item"><span>Release date</span><b>' + escapeHtml(releaseDate) + "</b></div>" +
      "</div>" +
      '<div class="mv-actions">' +
      '<button id="movie-detail-play" class="mv-btn mv-btn-light focusable" type="button" tabindex="0">' +
      mediaControlIconSvg("play", true) +
      "<span>" + (hasResume ? "Resume Playing" : "Play") + "</span>" +
      (hasResume ? '<i class="mv-progress"><b style="width:' + resumePercent + '%"></b></i>' : "") +
      "</button>" +
      (hasResume
        ? '<button id="movie-detail-beginning" class="mv-btn mv-btn-dim focusable" type="button" tabindex="0">' +
          mediaControlIconSvg("rew") +
          "<span>Play from Beginning</span></button>"
        : "") +
      '<button id="movie-detail-favorite" class="mv-btn mv-btn-dim focusable" type="button" tabindex="0">' +
      mediaControlIconSvg(favorite ? "favorite" : "plus", favorite) +
      "<span>" + (favorite ? "In favorites" : "Add to favorites") + "</span></button>" +
      (trailer
        ? '<button id="movie-detail-trailer" class="mv-btn mv-btn-accent focusable" type="button" tabindex="0">' +
          mediaControlIconSvg("film") +
          "<span>Watch trailer</span></button>"
        : "") +
      "</div>" +
      '<div class="movie-detail-cast"><h2>Cast</h2><div class="movie-cast-row">' +
      movieCastHtml(castValue) +
      "</div></div></section></div></div></div>";
    document.getElementById("movie-detail-close").addEventListener("click", closeMovieDetails);
    document.getElementById("movie-detail-play").addEventListener("click", function () {
      openOverlayPlayer(record, list, index, hasResume);
    });
    var beginning = document.getElementById("movie-detail-beginning");
    if (beginning) {
      beginning.addEventListener("click", function () {
        delete state.positions[record.uid];
        savePositions();
        openOverlayPlayer(record, list, index, false);
      });
    }
    var trailerBtn = document.getElementById("movie-detail-trailer");
    if (trailerBtn) {
      trailerBtn.addEventListener("click", function () {
        openTrailerPopup(record, trailer);
      });
    }
    document.getElementById("movie-detail-favorite").addEventListener("click", function () {
      toggleFavorite(record, true);
      var on = isFavorite(record.uid);
      this.innerHTML =
        mediaControlIconSvg(on ? "favorite" : "plus", on) +
        "<span>" + (on ? "In favorites" : "Add to favorites") + "</span>";
    });
    hydrateMovieCastPhotos(modal);
    setTimeout(function () {
      var play = document.getElementById("movie-detail-play");
      if (play) focusNode(play);
    }, 40);
  }

  function openMovieDetails(record, list, index) {
    var modal = document.getElementById("movie-detail-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "movie-detail-modal";
      modal.className = "modal movie-detail-modal";
      document.body.appendChild(modal);
    }
    state.movieDetail.open = true;
    state.movieDetail.record = record;
    state.movieDetail.list = list || null;
    state.movieDetail.index = index === undefined ? -1 : index;
    modal.classList.add("open");
    renderMovieDetails(record, record.raw || {}, list, index);
    var source = activeSource();
    if (source && source.type === "xtream" && record.streamId) {
      fetchJSON(xtreamApi(source, "get_vod_info", "&vod_id=" + encodeURIComponent(record.streamId))).then(
        function (data) {
          if (!state.movieDetail.open || state.movieDetail.record !== record) return;
          var info = clonePlain((data && data.movie_data) || {});
          var infoFields = (data && data.info) || data || {};
          var infoKey;
          for (infoKey in infoFields) {
            if (Object.prototype.hasOwnProperty.call(infoFields, infoKey)) {
              info[infoKey] = infoFields[infoKey];
            }
          }
          renderMovieDetails(record, info, list, index);
        },
        function () {}
      );
    }
  }

  function closeMovieDetails(restoreFocus) {
    var modal = document.getElementById("movie-detail-modal");
    var record = state.movieDetail.record;
    if (!state.movieDetail.open) return;
    state.movieDetail.open = false;
    state.movieDetail.record = null;
    state.movieDetail.list = null;
    state.movieDetail.index = -1;
    if (modal) modal.classList.remove("open");
    if (restoreFocus !== false && record) {
      setTimeout(function () {
        var card = document.querySelector('[data-record-uid="' + record.uid + '"]');
        if (card) focusNode(card);
      }, 60);
    }
  }

  function openRecord(record) {
    clearSearchForSelection();
    if (record.view === "live") {
      state.view = "live";
      state.live.selectedCategoryId = record.categoryId || state.live.selectedCategoryId;
      state.live.activeUid = record.uid;
      state.inline.record = record;
      renderLive();
      return;
    }
    if (record.view === "series") {
      state.view = "series";
      state.series.selectedUid = record.uid;
      renderSeriesEpisodesPage();
      loadSeriesEpisodes();
      return;
    }
    if (record.view === "movies") {
      openMovieDetails(record, null, -1);
      return;
    }
    openOverlayPlayer(record, null, -1);
  }

  // Set while a resume seek has been requested but playback has not passed it yet.
  var pendingResumeUid = null;

  function savePosition(record, currentTime, duration) {
    if (!state.settings.rememberPosition || !record || !duration || duration < 120) {
      return;
    }
    if (currentTime <= 10 || currentTime >= duration - 20) {
      // A resume seek that has not landed yet still reports ~0s, so deleting
      // here would throw the scene away after one glitchy start.
      if (currentTime <= 10 && pendingResumeUid === record.uid) {
        return;
      }
      if (state.positions[record.uid]) {
        delete state.positions[record.uid];
        savePositions();
      }
      return;
    }
    if (pendingResumeUid === record.uid) {
      pendingResumeUid = null;
    }
    state.positions[record.uid] = {
      currentTime: currentTime,
      duration: duration,
      updatedAt: Date.now(),
      record: record
    };
    schedulePositionsSave();
  }

  function changeOverlayRecord(step) {
    if (!state.overlay.record) {
      return;
    }
    if (state.overlay.record.view === "live") {
      // Re-bind to the visible channel list so fullscreen CH+/- keeps the pane's order
      var liveItems = filtered(state.live.items, "live");
      var liveIndex = indexByUid(liveItems, state.overlay.record.uid, "live");
      if (liveItems.length && liveIndex >= 0) {
        state.overlay.list = liveItems;
        state.overlay.index = liveIndex;
      }
    }
    if (!state.overlay.list || !state.overlay.list.length || state.overlay.index < 0) {
      return;
    }
    var nextIndex = state.overlay.index + step;
    if (nextIndex < 0) {
      nextIndex = state.overlay.list.length - 1;
    }
    if (nextIndex >= state.overlay.list.length) {
      nextIndex = 0;
    }
    if (state.overlay.record.view === "live") {
      var liveItem = state.overlay.list[nextIndex];
      var liveRecord = buildRecord("live", liveItem, {
        subtitle: liveItem.group || liveItem.category_name || "Live channel",
        categoryId: liveItem.category_id || state.live.selectedCategoryId
      });
      state.live.activeUid = liveRecord.uid;
      state.inline.record = liveRecord;
      state.inline.list = state.overlay.list;
      state.inline.index = nextIndex;
      openOverlayPlayer(liveRecord, state.overlay.list, nextIndex);
      return;
    }
    var item = state.overlay.list[nextIndex];
    var nextRecord = buildRecord(state.overlay.record.view, item, {
      subtitle: buildMetaLine(item)
    });
    openOverlayPlayer(nextRecord, state.overlay.list, nextIndex);
  }

  function openOverlayPlayer(record, list, index, useResume) {
    closeOverlayPlayer(true);
    var movieDetailModal = document.getElementById("movie-detail-modal");
    if (
      movieDetailModal &&
      state.movieDetail.open &&
      state.movieDetail.record === record
    ) {
      movieDetailModal.classList.remove("open");
    }
    if (record && record.view === "live") {
      stopInlinePlayer();
    }
    state.overlay.open = true;
    state.overlay.record = record;
    state.overlay.subtitle = {
      cues: [],
      enabled: false,
      loading: false,
      error: null
    };
    syncOverlaySubtitleButton();
    var captionEl = document.getElementById("overlay-caption");
    if (captionEl) captionEl.style.display = "none";
    state.overlay.list = list;
    state.overlay.index = index;
    state.overlay.useResume = useResume !== false;
    dom.overlay.classList.add("open");
    dom.overlayTitle.textContent =
      record.view === "episode" && record.seriesTitle
        ? record.seriesTitle + " - " + (record.playbackTitle || record.title)
        : record.title;
    dom.overlaySubtitle.textContent =
      record.subtitle || recordCategoryName(record) || record.sourceName || "Playback";
    dom.overlayStatus.textContent = "Loading....";
    setOverlayFavoriteButton(isFavorite(record.uid));
    dom.overlayRew.style.display = record.view === "live" ? "none" : "inline-block";
    dom.overlayFwd.style.display = record.view === "live" ? "none" : "inline-block";
    dom.overlayPrev.style.display = list && list.length ? "inline-block" : "none";
    dom.overlayNext.style.display = list && list.length ? "inline-block" : "none";
    dom.overlayHint.textContent =
      record.view === "live"
        ? "Arrow keys move focus · OK activate · CH +/- switch channel · Back close"
        : "Arrow keys move focus · OK activate · Subtitles · Quality Auto · Back close";
    dom.overlaySubtitleBtn.style.display = record.view === "live" ? "none" : "inline-block";
    dom.overlayQualityBtn.style.display = record.view === "live" ? "none" : "inline-block";
    if (record.view === "movies" || record.view === "episode") {
      fetchMovieSubtitles(record);
    }
    showOverlayControls();
    attachOverlayPlayer(playbackUrl(record), record);
    pushHistory(record);
    focusFirst("#overlay-playpause");
  }

  function updateOverlayQualityButton() {
    if (!dom.overlayQualityBtn) {
      return;
    }
    if (!state.overlay.hls) {
      dom.overlayQualityBtn.textContent = "AUTO";
      return;
    }
    var level = state.overlay.hls.currentLevel;
    if (level < 0) {
      dom.overlayQualityBtn.textContent = "AUTO";
      return;
    }
    var info = state.overlay.hls.levels[level];
    dom.overlayQualityBtn.textContent = info && info.height ? info.height + "p" : "MAN";
  }

  function cycleOverlayQuality() {
    if (!state.overlay.hls || !state.overlay.hls.levels || !state.overlay.hls.levels.length) {
      return;
    }
    var levels = state.overlay.hls.levels;
    var next = state.overlay.hls.currentLevel + 1;
    if (state.overlay.hls.currentLevel < 0) {
      next = 0;
    }
    if (next >= levels.length) {
      state.overlay.hls.currentLevel = -1;
      showToast("Quality: Auto", true, 1200);
      updateOverlayQualityButton();
      return;
    }
    state.overlay.hls.currentLevel = next;
    updateOverlayQualityButton();
    showToast("Quality: " + (levels[next].height || "Manual") + "p", true, 1200);
  }

  function parseSrtTime(s) {
    var m = String(s || "").match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return (
      parseInt(m[1], 10) * 3600 +
      parseInt(m[2], 10) * 60 +
      parseInt(m[3], 10) +
      parseInt(m[4], 10) / 1000
    );
  }

  function parseSrt(text) {
    var cues = [];
    var blocks = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
      .split(/\n{2,}/);
    Array.prototype.forEach.call(blocks, function (block) {
      var lines = block.split("\n");
      var timingIndex = -1;
      var i;
      for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("-->") !== -1) {
          timingIndex = i;
          break;
        }
      }
      if (timingIndex < 0) return;
      var parts = lines[timingIndex].split("-->");
      if (parts.length < 2) return;
      var rawText = lines
        .slice(timingIndex + 1)
        .join("\n")
        .trim();
      if (!rawText) return;
      // Strip HTML tags and formatting
      var cleanText = rawText
        .replace(/<[^>]+>/g, "")
        .replace(/\{[^}]+\}/g, "")
        .trim();
      if (!cleanText) return;
      cues.push({
        start: parseSrtTime(parts[0].trim()),
        end: parseSrtTime(parts[1].trim()),
        text: cleanText
      });
    });
    return cues;
  }

  function updateOverlayCaption(currentTime) {
    var captionEl = document.getElementById("overlay-caption");
    var inner = captionEl && captionEl.querySelector(".overlay-caption-inner");
    if (!captionEl || !inner) return;
    var sub = state.overlay.subtitle;
    if (!sub.enabled || !sub.cues.length) {
      captionEl.style.display = "none";
      return;
    }
    var t = currentTime || 0;
    var cue = null;
    var i;
    for (i = 0; i < sub.cues.length; i++) {
      if (t >= sub.cues[i].start && t <= sub.cues[i].end) {
        cue = sub.cues[i];
        break;
      }
    }
    if (cue) {
      inner.textContent = cue.text;
      captionEl.style.display = "block";
    } else {
      captionEl.style.display = "none";
    }
  }

  function syncOverlaySubtitleButton() {
    var button = dom.overlaySubtitleBtn;
    var enabled = !!state.overlay.subtitle.enabled;
    if (!button) return;
    button.classList.toggle("subtitle-enabled", enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.setAttribute("title", enabled ? "Subtitles: ON" : "Subtitles: OFF");
  }

  function fetchMovieSubtitles(record) {
    var key = state.settings.osApiKey;
    if (!key) return;
    var sub = state.overlay.subtitle;
    sub.loading = true;
    sub.error = null;
    sub.cues = [];
    var headers = {
      "Api-Key": key,
      "Content-Type": "application/json",
      "User-Agent": "TVNavigator/1.0"
    };
    var raw = record.raw || {};
    var title = record.title || raw.name || raw.movie_title || "";
    var year = yearFromItem(raw);
    var tmdbId = raw.tmdb_id || raw.tmdb || "";
    var searchUrl =
      "https://api.opensubtitles.com/api/v1/subtitles?languages=en&type=movie&order_by=download_count";
    if (tmdbId) {
      searchUrl += "&tmdb_id=" + encodeURIComponent(String(tmdbId));
    } else {
      searchUrl += "&query=" + encodeURIComponent(title);
      if (year) searchUrl += "&year=" + encodeURIComponent(year);
    }
    xhrJSON("GET", searchUrl, headers, null)
      .then(function (data) {
        var results = (data && data.data) || [];
        var fileId = null;
        for (var i = 0; i < results.length; i++) {
          var files = results[i].attributes && results[i].attributes.files;
          if (files && files.length) {
            fileId = files[0].file_id;
            break;
          }
        }
        if (!fileId) {
          sub.loading = false;
          sub.error = "No English subtitles found";
          syncOverlaySubtitleButton();
          showToast("Subtitles not available", false, 2200);
          return;
        }
        return xhrJSON("POST", "https://api.opensubtitles.com/api/v1/download", headers, {
          file_id: fileId
        });
      })
      .then(function (dlData) {
        if (!dlData) return;
        var link = dlData.link;
        if (!link) {
          sub.loading = false;
          sub.error = "No download link";
          return;
        }
        return fetchText(link);
      })
      .then(function (srtText) {
        if (!srtText) return;
        sub.cues = parseSrt(srtText);
        sub.loading = false;
        sub.enabled = sub.cues.length > 0;
        if (!sub.enabled) {
          sub.error = "No usable subtitles found";
        }
        syncOverlaySubtitleButton();
        showToast(
          sub.enabled ? "Subtitles loaded \u2014 ON" : "Subtitles not available",
          sub.enabled,
          sub.enabled ? 1500 : 2200
        );
      })
      .then(null, function (err) {
        sub.loading = false;
        sub.error = err && err.message ? err.message : "Subtitle fetch failed";
        syncOverlaySubtitleButton();
      });
  }

  function cycleOverlaySubtitle() {
    var sub = state.overlay.subtitle;
    if (sub.loading) {
      showToast("Loading subtitles…", false, 1400);
      return;
    }
    if (sub.error && !sub.cues.length) {
      showToast(sub.error, false, 2800);
      return;
    }
    if (!sub.cues.length) {
      var key = state.settings.osApiKey;
      if (!key) {
        showToast("Add OpenSubtitles API key in Settings to enable subtitles", false, 3000);
      } else {
        showToast("No subtitles found for this title", false, 2000);
      }
      return;
    }
    sub.enabled = !sub.enabled;
    var captionEl = document.getElementById("overlay-caption");
    if (captionEl && !sub.enabled) captionEl.style.display = "none";
    syncOverlaySubtitleButton();
    showToast(sub.enabled ? "Subtitles: ON" : "Subtitles: OFF", sub.enabled, 1200);
  }

  function toggleOverlayFullscreen() {
    var elem = dom.overlay;
    var doc = document;
    if (
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement
    ) {
      if (doc.exitFullscreen) {
        doc.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      }
      return;
    }
    if (elem.requestFullscreen) {
      elem.requestFullscreen();
    } else if (elem.webkitRequestFullscreen) {
      elem.webkitRequestFullscreen();
    } else if (dom.overlayVideo.webkitEnterFullscreen) {
      try {
        dom.overlayVideo.webkitEnterFullscreen();
      } catch (e) {}
    }
  }

  function attachOverlayPlayer(url, record) {
    stopOverlayPlayerEngine();
    var video = dom.overlayVideo;
    var candidates =
      record && record.view === "live"
        ? livePlaybackCandidates(record)
        : record && record.view === "movies"
        ? moviePlaybackCandidates(record, url)
        : [url];
    var candidateIndex = 0;
    var reconnecting = false;
    var failCount = 0;

    function activeUrl() {
      if (!candidates.length) {
        return "";
      }
      return candidates[candidateIndex] || candidates[0];
    }

    function nextCandidate() {
      if (candidateIndex + 1 < candidates.length) {
        candidateIndex += 1;
        return true;
      }
      return false;
    }

    function clearOverlayRecovery() {
      if (state.overlay.restartTimer) {
        clearTimeout(state.overlay.restartTimer);
        state.overlay.restartTimer = null;
      }
      if (state.overlay.stallWatch) {
        clearInterval(state.overlay.stallWatch);
        state.overlay.stallWatch = null;
      }
    }

    function scheduleOverlayReconnect(reason) {
      if (reconnecting || !state.overlay.open || !state.overlay.record) {
        return;
      }
      reconnecting = true;
      clearOverlayRecovery();
      var switchedCandidate =
        state.overlay.record.view === "live" || state.overlay.record.view === "movies"
          ? nextCandidate()
          : false;
      if (switchedCandidate) {
        failCount = 0;
      } else {
        failCount += 1;
      }
      if (failCount >= 3) {
        dom.overlayStatus.textContent = "Stream unavailable";
        reconnecting = false;
        return;
      }
      dom.overlayStatus.textContent = "Loading....";
      state.overlay.restartTimer = setTimeout(
        function () {
          reconnecting = false;
          if (!state.overlay.open || !state.overlay.record) {
            return;
          }
          startOverlayPlayback();
        },
        reason === "fatal" ? 2500 : 3500
      );
    }

    function startOverlayWatchdog() {
      clearOverlayRecovery();
      state.overlay.lastTime = -1;
      state.overlay.stallWatch = setInterval(function () {
        if (!state.overlay.open || !state.overlay.record) {
          clearOverlayRecovery();
          return;
        }
        if (video.paused || video.seeking || video.readyState < 2) {
          return;
        }
        var now = Math.floor(video.currentTime || 0);
        if (now === state.overlay.lastTime) {
          scheduleOverlayReconnect("stall");
          return;
        }
        state.overlay.lastTime = now;
      }, 15000);
    }

    function startOverlayPlayback() {
      var currentUrl = activeUrl();
      if (!currentUrl) {
        dom.overlayStatus.textContent = "Loading....";
        return;
      }

      pendingResumeUid = null;
      stopOverlayPlayerEngine();
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (e) {}

      video.volume = state.settings.volume;
      dom.overlayStatus.textContent = "Loading....";

      if (isHlsUrl(currentUrl) && canUseNativeHls(video)) {
        video.src = currentUrl;
        updateOverlayQualityButton();
      } else if (isHlsUrl(currentUrl) && window.Hls && Hls.isSupported()) {
        var cdnLoaderOv = createSslFallbackHlsLoader();
        var overlayHlsCfg = {
          enableWorker: false,
          startLevel: -1,
          capLevelToPlayerSize: true,
          maxBufferLength: 18,
          maxMaxBufferLength: 40
        };
        if (cdnLoaderOv) {
          overlayHlsCfg.loader = cdnLoaderOv;
        }
        state.overlay.hls = new Hls(overlayHlsCfg);
        state.overlay.hls.loadSource(currentUrl);
        state.overlay.hls.attachMedia(video);
        state.overlay.hls.on(Hls.Events.MANIFEST_PARSED, function () {
          dom.overlayStatus.textContent = "";
          tryPlay(video);
          startOverlayTick();
          startOverlayWatchdog();
          updateOverlayQualityButton();
        });
        state.overlay.hls.on(Hls.Events.LEVEL_SWITCHED, function () {
          updateOverlayQualityButton();
        });
        state.overlay.hls.on(Hls.Events.ERROR, function (evt, data) {
          if (!data) {
            return;
          }
          if (data.fatal) {
            console.error(
              "[overlay HLS] fatal error:",
              data.type,
              data.details,
              "url:",
              activeUrl()
            );
            // Try soft codec recovery first; only full-teardown if it fails again
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !state.overlay._hlsRecovered) {
              state.overlay._hlsRecovered = true;
              try {
                state.overlay.hls.recoverMediaError();
              } catch (e) {}
            } else {
              state.overlay._hlsRecovered = false;
              scheduleOverlayReconnect("fatal");
            }
          }
        });
      } else if (
        !isHlsUrl(currentUrl) &&
        (record.view === "live" || /\.ts($|\?)/i.test(currentUrl) || String(record.ext || "").toLowerCase() === "ts") &&
        !canBrowserPlayTs() &&
        canUseMpegTs()
      ) {
        // Raw MPEG-TS via mpegts.js — VOD MP4 must stay on the native video path.
        state.overlay.mpegts = mpegts.createPlayer(
          { type: "mpegts", url: currentUrl, isLive: record.view === "live" },
          {
            enableWorker: false,
            lazyLoad: false,
            liveBufferLatencyChasing: true
          }
        );
        state.overlay.mpegts.attachMediaElement(video);
        state.overlay.mpegts.load();
        state.overlay.mpegts.on(mpegts.Events.ERROR, function (type, detail) {
          console.error("[overlay mpegts] error:", type, detail);
          scheduleOverlayReconnect("fatal");
        });
        video.oncanplay = function () {
          dom.overlayStatus.textContent = "";
          tryPlay(video);
          startOverlayTick();
          startOverlayWatchdog();
        };
        updateOverlayQualityButton();
      } else {
        video.src = currentUrl;
        updateOverlayQualityButton();
      }

      video.onloadedmetadata = function () {
        var resume = state.positions[record.uid];
        if (state.overlay.useResume && resume && record.view !== "live") {
          pendingResumeUid = record.uid;
          try {
            video.currentTime = resume.currentTime;
          } catch (e2) {}
        }
      };
      video.oncanplay = function () {
        dom.overlayStatus.textContent = "";
        tryPlay(video);
        startOverlayTick();
        startOverlayWatchdog();
      };
      // onstalled fires constantly during normal live buffering — do not reconnect on it
      video.onstalled = null;
      // onwaiting is normal live buffering — show loading indicator, not a full reconnect
      video.onwaiting = function () {
        if (state.overlay.record && state.overlay.record.view === "live") {
          dom.overlayStatus.textContent = "Buffering...";
        }
      };
      video.onplaying = function () {
        if (state.overlay.record && state.overlay.record.view === "live") {
          dom.overlayStatus.textContent = "";
        }
      };
      video.onerror = function () {
        scheduleOverlayReconnect("error");
      };
    }

    startOverlayPlayback();
  }

  function tryPlay(video) {
    try {
      var maybe = video.play();
      if (maybe && typeof maybe.then === "function") {
        maybe.then(
          function () {},
          function () {}
        );
      }
    } catch (e) {}
    syncOverlayPlayPause();
    showOverlayControls();
  }

  function startOverlayTick() {
    stopOverlayTick();
    state.overlay.tick = setInterval(function () {
      var video = dom.overlayVideo;
      var duration = isFinite(video.duration) ? video.duration : 0;
      var current = isFinite(video.currentTime) ? video.currentTime : 0;
      dom.overlayCurrentTime.textContent = formatTime(current);
      updateOverlayCaption(current);
      dom.overlayTotalTime.textContent =
        state.overlay.record && state.overlay.record.view === "live"
          ? "LIVE"
          : formatTime(duration);
      if (state.overlay.record && state.overlay.record.view !== "live" && duration > 0) {
        dom.overlayProgressFill.style.width =
          Math.max(0, Math.min(100, (current / duration) * 100)) + "%";
        savePosition(state.overlay.record, current, duration);
      }
      syncOverlayPlayPause();
    }, 500);
  }

  function stopOverlayTick() {
    if (state.overlay.tick) {
      clearInterval(state.overlay.tick);
      state.overlay.tick = null;
    }
  }

  function stopOverlayPlayerEngine() {
    stopOverlayTick();
    if (state.overlay.restartTimer) {
      clearTimeout(state.overlay.restartTimer);
      state.overlay.restartTimer = null;
    }
    if (state.overlay.stallWatch) {
      clearInterval(state.overlay.stallWatch);
      state.overlay.stallWatch = null;
    }
    if (state.overlay.hls) {
      try {
        state.overlay.hls.destroy();
      } catch (e) {}
      state.overlay.hls = null;
    }
    if (state.overlay.mpegts) {
      try {
        state.overlay.mpegts.unload();
        state.overlay.mpegts.detachMediaElement();
        state.overlay.mpegts.destroy();
      } catch (e2) {}
      state.overlay.mpegts = null;
    }
  }

  function restoreFocusToActiveLiveChannel() {
    var attempts = 0;

    function target() {
      return (
        (state.live.activeUid
          ? document.querySelector('#live-list [data-record-uid="' + state.live.activeUid + '"]')
          : null) || document.querySelector("#live-list [data-record-uid]")
      );
    }

    // webOS re-asserts its own focus after the overlay closes, so keep claiming it back
    function tryRestore() {
      attempts += 1;
      var node = target();
      if (node && document.activeElement !== node) {
        focusNode(node);
        scrollIntoViewNearest(node, document.getElementById("live-list"));
      }
      if (attempts < 12) {
        setTimeout(tryRestore, 100);
      }
    }

    setTimeout(tryRestore, 60);
  }

  function restoreFocusToOverlayRecord(record) {
    var attempts = 0;

    function tryRestore() {
      attempts += 1;
      var card = document.querySelector('[data-record-uid="' + record.uid + '"]');
      if (card && document.activeElement !== card) {
        focusNode(card);
        scrollIntoViewNearest(card, card.parentNode);
      }
      if (attempts < 12) {
        setTimeout(tryRestore, 100);
      }
    }

    setTimeout(tryRestore, 60);
  }

  function restoreFocusToMovieDetails() {
    var attempts = 0;

    function tryRestore() {
      attempts += 1;
      var modal = document.getElementById("movie-detail-modal");
      var play = modal && modal.querySelector("#movie-detail-play");
      if (state.movieDetail.open && modal && modal.classList.contains("open") && play) {
        focusNode(play);
      }
      if (attempts < 12 && state.movieDetail.open) {
        setTimeout(tryRestore, 100);
      }
    }

    setTimeout(tryRestore, 60);
  }

  function closeOverlayPlayer(skipInlineResume) {
    if (!state.overlay.open) {
      return;
    }
    skipInlineResume = skipInlineResume === true;
    var closingRecord = state.overlay.record;
    hideOverlayControls(true);
    if (state.overlay.record && state.overlay.record.view !== "live") {
      savePosition(state.overlay.record, dom.overlayVideo.currentTime, dom.overlayVideo.duration);
    }
    pendingResumeUid = null;
    flushPendingPositions();
    stopOverlayPlayerEngine();
    try {
      dom.overlayVideo.pause();
      dom.overlayVideo.removeAttribute("src");
      dom.overlayVideo.load();
    } catch (e) {}
    state.overlay.open = false;
    state.overlay.record = null;
    state.overlay.list = null;
    state.overlay.index = -1;
    state.overlay.useResume = true;
    dom.overlay.classList.remove("open");
    var captionClear = document.getElementById("overlay-caption");
    if (captionClear) captionClear.style.display = "none";
    if (
      !skipInlineResume &&
      closingRecord &&
      closingRecord.view === "live" &&
      state.view === "live"
    ) {
      if (state.inline.record) {
        // Channel may have been changed inside fullscreen — resync list, cards and guide
        syncInlineListToDisplay();
        renderLiveList();
        renderLiveDetail();
        loadLiveEpg(state.inline.record);
      }
      restoreFocusToActiveLiveChannel();
    } else if (!skipInlineResume && closingRecord && closingRecord.view !== "live") {
      if (state.movieDetail.open && state.movieDetail.record === closingRecord) {
        var movieDetailModal = document.getElementById("movie-detail-modal");
        if (movieDetailModal) {
          movieDetailModal.classList.add("open");
        }
        restoreFocusToMovieDetails();
      } else {
        restoreFocusToOverlayRecord(closingRecord);
      }
    }
  }

  function syncOverlayPlayPause() {
    dom.overlayPlayPause.innerHTML = dom.overlayVideo.paused
      ? mediaControlIconSvg("play", true)
      : mediaControlIconSvg("pause", true);
    dom.overlayPlayPause.setAttribute("title", dom.overlayVideo.paused ? "Play" : "Pause");
  }

  function toggleOverlayPlayback() {
    if (dom.overlayVideo.paused) {
      tryPlay(dom.overlayVideo);
    } else {
      dom.overlayVideo.pause();
    }
    syncOverlayPlayPause();
    showOverlayControls();
  }

  function overlaySeek(seconds) {
    if (!state.overlay.record || state.overlay.record.view === "live") {
      return;
    }
    try {
      dom.overlayVideo.currentTime = Math.max(
        0,
        Math.min(dom.overlayVideo.duration || 0, dom.overlayVideo.currentTime + seconds)
      );
    } catch (e) {}
    showOverlayControls();
  }

  function showOverlayControls() {
    var controls = document.getElementById("overlay-controls");
    var head = document.getElementById("overlay-head");
    if (!controls || !head) {
      return;
    }
    if (state.overlay.controlsTimer) {
      clearTimeout(state.overlay.controlsTimer);
    }
    controls.style.opacity = "1";
    controls.style.visibility = "visible";
    controls.style.pointerEvents = "auto";
    head.style.opacity = "1";
    head.style.visibility = "visible";
    state.overlay.controlsTimer = setTimeout(function () {
      controls.style.opacity = "0";
      controls.style.visibility = "hidden";
      controls.style.pointerEvents = "none";
      head.style.opacity = "0";
      head.style.visibility = "hidden";
    }, 3500);
  }

  function hideOverlayControls(clearOnly) {
    var controls = document.getElementById("overlay-controls");
    var head = document.getElementById("overlay-head");
    if (!controls || !head) {
      return;
    }
    if (state.overlay.controlsTimer) {
      clearTimeout(state.overlay.controlsTimer);
      state.overlay.controlsTimer = null;
    }
    controls.style.opacity = clearOnly ? "1" : "0";
    controls.style.visibility = clearOnly ? "visible" : "hidden";
    controls.style.pointerEvents = clearOnly ? "auto" : "none";
    head.style.opacity = clearOnly ? "1" : "0";
    head.style.visibility = clearOnly ? "visible" : "hidden";
  }

  function changeVolume(delta) {
    var volume = state.settings.volume;
    volume = Math.max(0, Math.min(1, volume + delta));
    state.settings.volume = volume;
    saveSettings();
    try {
      dom.overlayVideo.volume = volume;
    } catch (e) {}
    var inlineVideo = document.getElementById("inline-video");
    if (inlineVideo) {
      try {
        inlineVideo.volume = volume;
      } catch (e2) {}
    }
    showToast("Volume " + Math.round(volume * 100) + "%", true, 1200);
  }

  function refreshCurrentView() {
    state.searchQuery = dom.search.value;
    if (state.view === "home") {
      triggerHomeSearch();
    } else if (state.view === "live") {
      renderLiveList();
    } else if (state.view === "movies") {
      if (state.movies.items && state.movies.items.length) {
        renderMoviesFromState();
      } else {
        renderMovies();
      }
    } else if (state.view === "series") {
      if (!state.series.selectedUid && state.series.items && state.series.items.length) {
        renderSeriesFromState();
      } else {
        renderSeries();
      }
    } else if (state.view === "favorites") {
      renderFavoritesSections();
    } else if (state.view === "history") {
      renderCollection("History", state.history);
    }
  }

  function triggerHomeSearch() {
    var query = trim(state.searchQuery).toLowerCase();
    if (query && query === state.homeSearch.lastQuery && !state.homeSearch.loading) {
      renderHome();
      return;
    }
    state.homeSearch.lastQuery = query;
    if (!query) {
      state.homeSearch.loading = false;
      state.homeSearch.results = [];
      renderHome();
      return;
    }
    var token = state.homeSearch.token + 1;
    state.homeSearch.token = token;
    state.homeSearch.loading = true;
    state.homeSearch.results = [];
    state.homeSearch.focused = false;
    renderHome();
    runHomeGlobalSearch(query, token, function (results, done) {
      if (token !== state.homeSearch.token) {
        return;
      }
      state.homeSearch.results = results;
      state.homeSearch.loading = !done;
      renderHome();
    }).then(
      function () {},
      function () {
        if (token !== state.homeSearch.token) {
          return;
        }
        state.homeSearch.loading = false;
        renderHome();
      }
    );
  }

  function runWithConcurrency(items, limit, worker) {
    return new Promise(function (resolve) {
      var list = items || [];
      if (!list.length) {
        resolve();
        return;
      }
      var index = 0;
      var active = 0;
      function next() {
        if (index >= list.length && active === 0) {
          resolve();
          return;
        }
        while (active < limit && index < list.length) {
          (function (item) {
            active += 1;
            Promise.resolve(worker(item)).then(
              function () {
                active -= 1;
                next();
              },
              function () {
                active -= 1;
                next();
              }
            );
          })(list[index++]);
        }
      }
      next();
    });
  }

  function pushSearchMatches(task, items, query, dedupe, allRecords, maxResults) {
    var list = items || [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (allRecords.length >= maxResults) {
        return true;
      }
      pushSearchMatch(task, list[i], query, dedupe, allRecords);
    }
    return allRecords.length >= maxResults;
  }

  function pushSearchMatch(task, item, query, dedupe, allRecords) {
    // Test the title on its own first: it matches most queries and avoids allocating
    // the concatenated haystack for the vast majority of non-matching rows.
    var name = item.name || item.title || item.movie_title || "";
    if (query && name.toLowerCase().indexOf(query) === -1) {
      var secondary =
        item.group || item.genre || item.plot || item.description || item.category_name || "";
      if (!secondary || secondary.toLowerCase().indexOf(query) === -1) {
        return;
      }
    }
    var record = buildRecord(task.view, item, {
      subtitle:
        task.view === "live" ? item.group || item.category_name || "Live" : buildMetaLine(item),
      categoryId: task.categoryId
    });
    if (!dedupe[record.uid]) {
      dedupe[record.uid] = true;
      allRecords.push(record);
    }
  }

  // One continuous walk across every cached category. Yielding per category (the old
  // approach) cost a setTimeout tick per category, which dominated the search time.
  function scanCachedTasksChunked(
    tasks,
    cache,
    query,
    dedupe,
    allRecords,
    maxResults,
    token,
    onChunk
  ) {
    var taskIndex = 0;
    var itemIndex = 0;
    var lastEmit = 0;
    var lastEmitCount = 0;
    return new Promise(function (resolve) {
      function emit(force) {
        if (!onChunk || allRecords.length === lastEmitCount) {
          return;
        }
        var now = Date.now();
        if (!force && now - lastEmit < 200) {
          return;
        }
        lastEmit = now;
        lastEmitCount = allRecords.length;
        onChunk();
      }
      function step() {
        if (token !== state.homeSearch.token) {
          resolve(true);
          return;
        }
        var processed = 0;
        while (taskIndex < tasks.length) {
          var task = tasks[taskIndex];
          var list = (cache.items[task.view] || {})[task.categoryId] || [];
          while (itemIndex < list.length) {
            if (allRecords.length >= maxResults) {
              emit(true);
              resolve(true);
              return;
            }
            pushSearchMatch(task, list[itemIndex], query, dedupe, allRecords);
            itemIndex += 1;
            processed += 1;
            if (processed >= 2500) {
              emit(false);
              setTimeout(step, 0);
              return;
            }
          }
          taskIndex += 1;
          itemIndex = 0;
        }
        emit(true);
        resolve(allRecords.length >= maxResults);
      }
      step();
    });
  }

  function scanTaskItemsChunked(task, items, query, dedupe, allRecords, maxResults, token) {
    var list = items || [];
    var chunkSize = 220;
    var idx = 0;
    return new Promise(function (resolve) {
      function step() {
        if (token !== state.homeSearch.token) {
          resolve(true);
          return;
        }
        if (allRecords.length >= maxResults || idx >= list.length) {
          resolve(allRecords.length >= maxResults);
          return;
        }
        var end = Math.min(idx + chunkSize, list.length);
        var partial = list.slice(idx, end);
        var done = pushSearchMatches(task, partial, query, dedupe, allRecords, maxResults);
        idx = end;
        if (done) {
          resolve(true);
          return;
        }
        setTimeout(step, 0);
      }
      step();
    });
  }

  function runHomeGlobalSearch(query, token, onPartial) {
    var source = activeSource();
    var cache = activeSourceCache();
    if (!source) {
      return Promise.resolve([]);
    }
    var views = ["live", "movies", "series"];
    var catMap = { live: [], movies: [], series: [] };
    var allRecords = [];
    var maxResults = 300;
    var dedupe = {};
    return Promise.all(
      views.map(function (view) {
        return ensureCategories(view).then(function (categories) {
          catMap[view] = categories || [];
        });
      })
    ).then(function () {
      var tasks = [];
      var cachedTasks = [];
      var fetchTasks = [];
      var deepFetchAllowed = query.length >= 2;
      views.forEach(function (view) {
        (catMap[view] || []).forEach(function (category) {
          tasks.push({ view: view, categoryId: String(category.category_id) });
        });
      });
      Array.prototype.forEach.call(tasks, function (task) {
        var hasCached =
          !!cache && !!cache.items[task.view] && !!cache.items[task.view][task.categoryId];
        if (hasCached) {
          cachedTasks.push(task);
        } else if (deepFetchAllowed) {
          fetchTasks.push(task);
        }
      });

      return scanCachedTasksChunked(
        cachedTasks,
        cache,
        query,
        dedupe,
        allRecords,
        maxResults,
        token,
        function () {
          if (onPartial && token === state.homeSearch.token) {
            onPartial(allRecords.slice(0, maxResults), false);
          }
        }
      ).then(function (reachedFromCache) {
        if (onPartial && token === state.homeSearch.token) {
          onPartial(allRecords.slice(0, maxResults), reachedFromCache || fetchTasks.length === 0);
        }
        if (reachedFromCache || !fetchTasks.length || token !== state.homeSearch.token) {
          return allRecords.slice(0, maxResults);
        }

        var total = fetchTasks.length;
        var done = 0;
        startSyncProgress("Searching source", total);
        return runWithConcurrency(fetchTasks, 4, function (task) {
          if (token !== state.homeSearch.token || allRecords.length >= maxResults) {
            return;
          }
          return ensureItems(task.view, task.categoryId).then(function (items) {
            if (token !== state.homeSearch.token || allRecords.length >= maxResults) {
              return;
            }
            return scanTaskItemsChunked(
              task,
              items || [],
              query,
              dedupe,
              allRecords,
              maxResults,
              token
            ).then(function () {
              done += 1;
              updateSyncProgress(done, total);
              if (onPartial && token === state.homeSearch.token) {
                onPartial(allRecords.slice(0, maxResults), false);
              }
            });
          });
        }).then(function () {
          finishSyncProgress("Search ready");
          if (onPartial && token === state.homeSearch.token) {
            onPartial(allRecords.slice(0, maxResults), true);
          }
          return allRecords.slice(0, maxResults);
        });
      });
    });
  }

  function refreshSelectedSubcategory() {
    var source = activeSource();
    if (!source) {
      return;
    }
    if (state.view === "live" && state.live.selectedCategoryId) {
      refreshSubcategory("live", state.live.selectedCategoryId).then(function () {
        state.live.activeUid = null;
        state.inline.record = null;
        renderLive();
        showToast("Live subcategory refreshed", true);
      });
      return;
    }
    if (state.view === "movies" && state.movies.selectedCategoryId) {
      refreshSubcategory("movies", state.movies.selectedCategoryId).then(function () {
        state.movies.selectedUid = null;
        renderMovies();
        showToast("Movie subcategory refreshed", true);
      });
      return;
    }
    if (state.view === "series" && state.series.selectedCategoryId) {
      refreshSubcategory("series", state.series.selectedCategoryId).then(function () {
        state.series.selectedUid = null;
        renderSeries();
        showToast("Series subcategory refreshed", true);
      });
      return;
    }
    refreshAllViews().then(function () {
      renderCurrentView();
      showToast("Source refreshed", true);
    });
  }

  function refreshSubcategory(view, categoryId) {
    var cache = activeSourceCache();
    var now;
    if (!cache || !categoryId) {
      return Promise.resolve();
    }
    ensureCacheSyncState(cache);
    var key = String(categoryId);
    delete cache.items[view][key];
    delete cache.counts[view][key];
    if (view === "series" && state.series.selectedUid) {
      var record = state.recordsByUid[state.series.selectedUid];
      if (record && record.seriesId) {
        delete cache.seriesInfo[record.seriesId];
      }
    }
    startSyncProgress("Refreshing " + view + "", 1);
    return ensureItems(view, key, true).then(function () {
      now = Date.now();
      if (view === "movies") {
        refreshRecentMoviesCache();
      }
      cache.synced[view] = true;
      refreshHomeSummaryCount(view, now);
      persistActiveCacheCounts();
      updateSyncProgress(1, 1);
      finishSyncProgress("Refresh complete");
      if (state.view === "home" && !trim(state.searchQuery)) {
        renderHome();
      }
    });
  }

  function refreshViewCategories(view) {
    var cache = activeSourceCache();
    var now;
    if (!cache) {
      return Promise.resolve();
    }
    ensureCacheSyncState(cache);
    cache.categories[view] = [];
    cache.items[view] = {};
    cache.counts[view] = {};
    if (view === "movies") {
      cache.recentMovies = [];
    }
    if (view === "series") {
      cache.seriesInfo = {};
    }
    cache.synced[view] = false;
    return ensureCategories(view, true).then(function (categories) {
      var total = (categories || []).length;
      var done = 0;
      startSyncProgress("Refreshing " + view + "", total);
      return (categories || [])
        .reduce(function (chain, category) {
          return chain.then(function () {
            return ensureItems(view, String(category.category_id), true).then(function () {
              done += 1;
              updateSyncProgress(done, total);
            });
          });
        }, Promise.resolve())
        .then(function () {
          now = Date.now();
          if (view === "movies") {
            refreshRecentMoviesCache();
          }
          if (view === "movies") {
            refreshRecentMoviesCache();
          }
          cache.synced[view] = true;
          refreshHomeSummaryCount(view, now);
          persistActiveCacheCounts();
          finishSyncProgress("Refresh complete");
          if (state.view === "home" && !trim(state.searchQuery)) {
            renderHome();
          }
        });
    });
  }

  function refreshAllViews() {
    return refreshViewCategories("live")
      .then(function () {
        return refreshViewCategories("movies");
      })
      .then(function () {
        return refreshViewCategories("series");
      });
  }

  function focusScope(node) {
    if (!node) {
      return "global";
    }
    if (state.overlay.open && dom.overlay.contains(node)) {
      return "overlay";
    }
    if (isConfirmDialogOpen() && dom.confirmModal.contains(node)) {
      return "modal";
    }
    if (dom.sourceModal.classList.contains("open") && dom.sourceModal.contains(node)) {
      return "modal";
    }
    if (dom.sourceMenu.classList.contains("open") && dom.sourceMenu.contains(node)) {
      return "menu";
    }
    if (node.closest("#rail")) {
      return "rail";
    }
    if (node.closest("#topbar")) {
      return "topbar";
    }
    if (node.closest("#workspace")) {
      return "workspace";
    }
    return "global";
  }

  // offsetParent is null for ALL descendants of position:fixed in Chromium 38
  // (webOS 3.x). Use getBoundingClientRect to detect visibility instead.
  function isVisible(node) {
    if (!node) return false;
    var r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function firstFocusableIn(selector) {
    var host = document.querySelector(selector);
    if (!host) {
      return null;
    }
    var items = host.querySelectorAll("[tabindex]");
    var i;
    for (i = 0; i < items.length; i++) {
      if (items[i].tabIndex >= 0 && isVisible(items[i])) {
        return items[i];
      }
    }
    return null;
  }

  function safeFocus(node) {
    if (!node) {
      return;
    }
    try {
      node.focus({ preventScroll: true });
    } catch (e) {
      try {
        node.focus();
      } catch (e2) {}
    }
  }

  function focusFirst(selector) {
    setTimeout(function () {
      var node = document.querySelector(selector);
      if (node) {
        safeFocus(node);
        scrollNodeIntoHost(node);
      }
    }, 50);
  }

  function getFocusable() {
    return Array.prototype.filter.call(document.querySelectorAll("[tabindex]"), function (node) {
      return node.tabIndex >= 0 && isVisible(node);
    });
  }

  function nearestScrollHost(node) {
    var current = node;
    while (current && current !== document.body) {
      if (
        current.id === "live-list-pane" ||
        current.id === "movie-grid" ||
        current.id === "series-grid" ||
        current.id === "workspace" ||
        current.classList.contains("pane-scroll") ||
        current.classList.contains("category-pane") ||
        current.classList.contains("list-pane") ||
        current.classList.contains("detail-pane") ||
        current.classList.contains("grid-pane") ||
        current.classList.contains("shelf-row") ||
        current.classList.contains("episode-row") ||
        current.classList.contains("home-wrap") ||
        current.classList.contains("source-menu") ||
        current.classList.contains("modal-card")
      ) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  function scrollNodeIntoHost(node) {
    var host = nearestScrollHost(node);
    var verticalHost = null;
    var current;
    function applyScroll(targetHost, nodeRect) {
      var hostRect;
      if (!targetHost) {
        return;
      }
      hostRect = targetHost.getBoundingClientRect();
      if (nodeRect.top < hostRect.top) {
        targetHost.scrollTop -= hostRect.top - nodeRect.top + 14;
      } else if (nodeRect.bottom > hostRect.bottom) {
        targetHost.scrollTop += nodeRect.bottom - hostRect.bottom + 14;
      }
      if (nodeRect.left < hostRect.left) {
        targetHost.scrollLeft -= hostRect.left - nodeRect.left + 14;
      } else if (nodeRect.right > hostRect.right) {
        targetHost.scrollLeft += nodeRect.right - hostRect.right + 14;
      }
    }
    if (!host) {
      return;
    }

    var nodeRect = node.getBoundingClientRect();
    applyScroll(host, nodeRect);

    if (
      host.classList &&
      (host.classList.contains("shelf-row") || host.classList.contains("episode-row"))
    ) {
      current = host.parentNode;
      while (current && current !== document.body) {
        if (
          current.classList &&
          (current.classList.contains("home-wrap") ||
            current.classList.contains("detail-pane") ||
            current.classList.contains("grid-pane") ||
            current.classList.contains("list-pane"))
        ) {
          verticalHost = current;
          break;
        }
        current = current.parentNode;
      }
      if (verticalHost) {
        applyScroll(verticalHost, nodeRect);
      }
    }
  }

  function elementCenter(node) {
    var rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function moveFocus(direction) {
    var focusables = getFocusable();
    var active = document.activeElement;
    var railButtons;
    var railIndex;
    if (!focusables.length) {
      return;
    }
    if (focusables.indexOf(active) === -1) {
      safeFocus(focusables[0]);
      scrollNodeIntoHost(focusables[0]);
      return;
    }
    var scope = focusScope(active);
    if (scope === "rail" && direction === "right") {
      var workspaceItem = firstFocusableIn("#workspace");
      if (workspaceItem) {
        focusNode(workspaceItem);
        return;
      }
      var topbarItem = firstFocusableIn("#topbar");
      if (topbarItem) {
        focusNode(topbarItem);
        return;
      }
    }
    if (scope === "rail" && (direction === "up" || direction === "down")) {
      railButtons = document.querySelectorAll("#rail .rail-btn[tabindex]");
      railIndex = Array.prototype.indexOf.call(railButtons, active);
      if (railIndex >= 0) {
        if (direction === "up" && railIndex > 0) {
          focusNode(railButtons[railIndex - 1]);
          return;
        }
        if (direction === "down" && railIndex < railButtons.length - 1) {
          focusNode(railButtons[railIndex + 1]);
          return;
        }
      }
    }
    if (scope === "rail" && direction === "up") {
      var sourceDropdown = dom.sourceMenuBtn || firstFocusableIn("#topbar");
      if (sourceDropdown) {
        focusNode(sourceDropdown);
        return;
      }
    }
    if (scope === "topbar" && direction === "down") {
      var downItem = firstFocusableIn("#workspace");
      if (downItem) {
        focusNode(downItem);
        return;
      }
    }
    if (scope === "topbar" && direction === "left") {
      var railFromTop = document.querySelector(".rail-btn.active") || firstFocusableIn("#rail");
      var topbarHost = document.getElementById("topbar");
      var topbarRect = topbarHost ? topbarHost.getBoundingClientRect() : null;
      var nearTopbarLeft = topbarRect
        ? active.getBoundingClientRect().left <= topbarRect.left + 300
        : active.getBoundingClientRect().left < 420;
      if (railFromTop && nearTopbarLeft) {
        focusNode(railFromTop);
        return;
      }
    }
    if (scope === "workspace" && direction === "left") {
      var activeRail = document.querySelector(".rail-btn.active") || firstFocusableIn("#rail");
      var workspaceHost = document.getElementById("workspace");
      var workspaceRect = workspaceHost ? workspaceHost.getBoundingClientRect() : null;
      var nearWorkspaceLeft = workspaceRect
        ? active.getBoundingClientRect().left <= workspaceRect.left + 320
        : active.getBoundingClientRect().left < 520;
      if (activeRail && nearWorkspaceLeft) {
        focusNode(activeRail);
        return;
      }
    }
    if (scope === "workspace" && direction === "up") {
      if (state.view === "home" && active.closest(".home-top-shell")) {
        if (active.getAttribute("data-home-refresh")) {
          var homeCard = active.closest(".home-top-card");
          var openBtn = homeCard ? homeCard.querySelector("[data-home-open]") : null;
          if (openBtn) {
            focusNode(openBtn);
            return;
          }
        }
        if (!active.getAttribute("data-home-open")) {
          return;
        }
        if (dom.search) {
          focusNode(dom.search);
          return;
        }
      }
      var topbarTarget = firstFocusableIn("#topbar");
      if (topbarTarget && active.getBoundingClientRect().top < 140) {
        // Only jump to topbar if nothing in the workspace is above the active element
        var activeCenter = elementCenter(active);
        var wsHost = document.getElementById("workspace");
        var hasAbove =
          wsHost &&
          Array.prototype.some.call(wsHost.querySelectorAll("[tabindex]"), function (n) {
            return (
              n !== active &&
              n.tabIndex >= 0 &&
              isVisible(n) &&
              elementCenter(n).y < activeCenter.y - 5
            );
          });
        if (!hasAbove) {
          focusNode(topbarTarget);
          return;
        }
      }
    }

    focusables = focusables.filter(function (node) {
      var nodeScope = focusScope(node);
      if (scope === "overlay") {
        return nodeScope === "overlay";
      }
      if (scope === "modal") {
        return nodeScope === "modal";
      }
      if (scope === "menu") {
        return nodeScope === "menu" || node === dom.sourceMenuBtn;
      }
      if (scope === "topbar") {
        return nodeScope === "topbar";
      }
      if (scope === "workspace") {
        return nodeScope === "workspace";
      }
      if (scope === "rail") {
        return nodeScope === "rail";
      }
      return true;
    });
    var from = elementCenter(active);
    var vec =
      direction === "left"
        ? { x: -1, y: 0 }
        : direction === "right"
          ? { x: 1, y: 0 }
          : direction === "up"
            ? { x: 0, y: -1 }
            : { x: 0, y: 1 };
    var best = null;
    var bestScore = Infinity;
    Array.prototype.forEach.call(focusables, function (node) {
      if (node === active) {
        return;
      }
      var center = elementCenter(node);
      var dx = center.x - from.x;
      var dy = center.y - from.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!len) {
        return;
      }
      var dot = (dx * vec.x + dy * vec.y) / len;
      if (dot <= 0) {
        return;
      }
      var angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      var score = angle * 1000 + len;
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    });
    if (best) {
      focusNode(best);
      return;
    }

    if (scope === "workspace" && direction === "left") {
      var fallbackRail = document.querySelector(".rail-btn.active") || firstFocusableIn("#rail");
      if (fallbackRail) {
        focusNode(fallbackRail);
      }
    }
  }

  function linearMoveWithin(nodes, direction) {
    var active = document.activeElement;
    var visibleNodes;
    var index;
    var next;
    if (!nodes || !nodes.length || !active) {
      return false;
    }
    visibleNodes = Array.prototype.filter.call(nodes, function (node) {
      return node && node.tabIndex >= 0 && isVisible(node);
    });
    if (!visibleNodes.length) {
      return false;
    }
    index = Array.prototype.indexOf.call(visibleNodes, active);
    if (index < 0) {
      return false;
    }
    if (direction === "left" || direction === "up") {
      next = index - 1;
    } else if (direction === "right" || direction === "down") {
      next = index + 1;
    } else {
      return false;
    }
    if (next < 0 || next >= visibleNodes.length) {
      return false;
    }
    focusNode(visibleNodes[next]);
    return true;
  }

  function settingsFocusableNodes() {
    var workspace = document.getElementById("workspace");
    if (!workspace || state.view !== "settings") {
      return [];
    }
    return Array.prototype.filter.call(
      workspace.querySelectorAll(".detail-card [tabindex]"),
      function (node) {
        return node && node.tabIndex >= 0 && isVisible(node);
      }
    );
  }

  function moveSettingsFocus(direction) {
    var active = document.activeElement;
    var radioRow;
    var actionRow;
    if (state.overlay.open || state.view !== "settings" || !active) {
      return false;
    }

    if (
      active.tagName === "INPUT" &&
      active.parentNode &&
      active.parentNode.classList &&
      active.parentNode.classList.contains("settings-radio-option")
    ) {
      focusNode(active.parentNode);
      active = document.activeElement;
    }

    if (!active.closest || !active.closest("#workspace .detail-card")) {
      return false;
    }

    if (direction === "left" || direction === "right") {
      radioRow = active.closest(".settings-radio-group");
      if (radioRow) {
        return linearMoveWithin(
          radioRow.querySelectorAll(".settings-radio-option[tabindex]"),
          direction
        );
      }
      actionRow = active.closest(".detail-actions");
      if (actionRow) {
        return linearMoveWithin(actionRow.querySelectorAll(".focusable[tabindex]"), direction);
      }
    }

    if (direction === "up" || direction === "down") {
      var activeCard = active.closest ? active.closest(".detail-card") : null;
      if (!activeCard) return false;

      var activeRect = active.getBoundingClientRect();
      var activeY = activeRect.top + activeRect.height / 2;
      // Elements must differ by more than this to be considered a separate visual row
      var ROW_THRESHOLD = 15;

      // First: look for a focusable in the same card on a different visual row
      var sameCardNodes = Array.prototype.filter.call(
        activeCard.querySelectorAll("[tabindex]"),
        function (n) {
          return n !== active && n.tabIndex >= 0 && isVisible(n);
        }
      );
      var bestInCard = null;
      var bestInCardDist = Infinity;
      Array.prototype.forEach.call(sameCardNodes, function (n) {
        var r = n.getBoundingClientRect();
        var ny = r.top + r.height / 2;
        var dy = ny - activeY;
        if (direction === "down" && dy > ROW_THRESHOLD && dy < bestInCardDist) {
          bestInCardDist = dy;
          bestInCard = n;
        } else if (direction === "up" && -dy > ROW_THRESHOLD && -dy < bestInCardDist) {
          bestInCardDist = -dy;
          bestInCard = n;
        }
      });
      if (bestInCard) {
        focusNode(bestInCard);
        return true;
      }

      // Nothing else in this card — jump to the adjacent settings card
      var allCards = Array.prototype.filter.call(
        document.querySelectorAll("#workspace .detail-card"),
        function (c) {
          return isVisible(c);
        }
      );
      var cardIndex = allCards.indexOf(activeCard);
      if (cardIndex < 0) return false;
      var targetIndex = direction === "up" ? cardIndex - 1 : cardIndex + 1;
      if (targetIndex < 0 || targetIndex >= allCards.length) return false;
      var firstInTarget = firstVisibleFocusable(
        allCards[targetIndex].querySelectorAll("[tabindex]")
      );
      if (firstInTarget) {
        focusNode(firstInTarget);
        return true;
      }
      return false;
    }

    return false;
  }

  function firstVisibleFocusable(nodes) {
    var i;
    if (!nodes || !nodes.length) {
      return null;
    }
    for (i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].tabIndex >= 0 && isVisible(nodes[i])) {
        return nodes[i];
      }
    }
    return null;
  }

  function moveGridFocus(pane, direction) {
    var active = document.activeElement;
    var cards;
    var index;
    var cols;
    var next;
    if (!pane || !active || !pane.contains(active)) {
      return false;
    }
    cards = pane.querySelectorAll(".grid-wrap [data-record-uid]");
    if (!cards.length) {
      return false;
    }
    index = Array.prototype.indexOf.call(cards, active);
    if (index < 0) {
      return false;
    }
    cols = detectGridColumns(cards);
    if (direction === "left" && index % cols === 0) {
      return false;
    }
    next = index;
    if (direction === "left") {
      next = index - 1;
    } else if (direction === "right") {
      next = index + 1;
    } else if (direction === "up") {
      next = index - cols;
    } else if (direction === "down") {
      next = index + cols;
    } else {
      return false;
    }
    if (next < 0 || next >= cards.length) {
      return false;
    }
    focusNode(cards[next]);
    return true;
  }

  function moveSplitLayoutFocus(direction) {
    var active = document.activeElement;
    var layout;
    var categoryButtons;
    var listCards;
    var target;
    if (!active) {
      return false;
    }
    layout = active.closest(".split-layout");
    if (!layout) {
      return false;
    }

    if (active.classList.contains("category-search-input")) {
      if (direction === "down") {
        categoryButtons = layout.querySelectorAll(".category-btn");
        if (categoryButtons.length) {
          focusNode(categoryButtons[0]);
          return true;
        }
      }
      if (direction === "right") {
        target =
          layout.querySelector("#live-list [data-record-uid]") ||
          layout.querySelector("#movie-grid .grid-wrap [data-record-uid]") ||
          layout.querySelector("#series-grid .grid-wrap [data-record-uid]") ||
          layout.querySelector("#live-refresh-list") ||
          layout.querySelector("#movie-refresh-list") ||
          layout.querySelector("#series-refresh-list");
        if (target) {
          focusNode(target);
          return true;
        }
      }
      return false;
    }

    if (active.closest("#live-categories, #movie-categories, #series-categories")) {
      categoryButtons = layout.querySelectorAll(".category-btn");
      if (direction === "up" || direction === "down") {
        return linearMoveWithin(categoryButtons, direction);
      }
      if (direction === "right") {
        target =
          layout.querySelector("#live-list [data-record-uid]") ||
          layout.querySelector("#movie-grid .grid-wrap [data-record-uid]") ||
          layout.querySelector("#series-grid .grid-wrap [data-record-uid]") ||
          layout.querySelector("#live-refresh-list") ||
          layout.querySelector("#movie-refresh-list") ||
          layout.querySelector("#series-refresh-list");
        if (target) {
          focusNode(target);
          return true;
        }
      }
      if (direction === "left") {
        target = firstVisibleFocusable([layout.querySelector(".category-search-input")]);
        if (target) {
          focusNode(target);
          return true;
        }
      }
    }

    if (active.closest("#live-list")) {
      listCards = layout.querySelectorAll("#live-list [data-record-uid]");
      if (direction === "up" || direction === "down") {
        return linearMoveWithin(listCards, direction);
      }
      if (direction === "left") {
        target =
          layout.querySelector("#live-categories .category-btn.active") ||
          layout.querySelector("#live-categories .category-btn") ||
          layout.querySelector("#live-category-search");
        if (target) {
          focusNode(target);
          return true;
        }
      }
      if (direction === "right") {
        target =
          layout.querySelector("#live-detail .focusable") || layout.querySelector("#inline-video");
        if (target) {
          focusNode(target);
          return true;
        }
      }
    }

    if (active.closest("#movie-grid")) {
      if (moveGridFocus(layout.querySelector("#movie-grid"), direction)) {
        return true;
      }
      if (direction === "left") {
        target = firstVisibleFocusable([
          layout.querySelector("#movie-categories .category-btn.active"),
          layout.querySelector("#movie-categories .category-btn"),
          layout.querySelector("#movie-category-search")
        ]);
        if (target) {
          focusNode(target);
          return true;
        }
      }
    }

    if (active.closest("#series-grid")) {
      if (moveGridFocus(layout.querySelector("#series-grid"), direction)) {
        return true;
      }
      if (direction === "left") {
        target = firstVisibleFocusable([
          layout.querySelector("#series-categories .category-btn.active"),
          layout.querySelector("#series-categories .category-btn"),
          layout.querySelector("#series-category-search")
        ]);
        if (target) {
          focusNode(target);
          return true;
        }
      }
    }

    if (active.closest("#live-detail") && direction === "left") {
      target =
        layout.querySelector(
          '#live-list [data-record-uid="' + (state.live.activeUid || "") + '"]'
        ) || layout.querySelector("#live-list [data-record-uid]");
      if (target) {
        focusNode(target);
        return true;
      }
    }

    return false;
  }

  function moveInHorizontalActionRow(direction) {
    var active = document.activeElement;
    var row;
    var nodes;
    if (!active || (direction !== "left" && direction !== "right")) {
      return false;
    }
    row = active.closest(
      ".home-top-grid, .detail-actions, .inline-overlay-controls, .overlay-buttons"
    );
    if (!row) {
      return false;
    }
    nodes = row.querySelectorAll(".focusable");
    return linearMoveWithin(nodes, direction);
  }

  function sequencedDirectionalNavigation(direction) {
    if (moveSettingsFocus(direction)) {
      return true;
    }
    if (moveInHorizontalActionRow(direction)) {
      return true;
    }
    if (moveSplitLayoutFocus(direction)) {
      return true;
    }
    return false;
  }

  function detectGridColumns(cards) {
    if (!cards || cards.length < 2) {
      return 1;
    }
    var firstTop = cards[0].getBoundingClientRect().top;
    var i;
    var cols = 0;
    for (i = 0; i < cards.length; i++) {
      if (Math.abs(cards[i].getBoundingClientRect().top - firstTop) < 10) {
        cols += 1;
      } else {
        break;
      }
    }
    return Math.max(1, cols);
  }

  function focusNode(node) {
    if (!node) {
      return;
    }
    try {
      safeFocus(node);
      scrollNodeIntoHost(node);
    } catch (e) {}
  }

  function resetViewportScroll() {
    if (window.pageXOffset || window.pageYOffset) {
      window.scrollTo(0, 0);
    }
    if (document.documentElement) {
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    }
    if (document.body) {
      document.body.scrollTop = 0;
      document.body.scrollLeft = 0;
    }
  }

  function moveDownInLiveList() {
    var active = document.activeElement;
    if (!active || !active.closest("#live-list")) {
      return false;
    }
    var cards = document.querySelectorAll("#live-list [data-record-uid]");
    if (!cards.length) {
      return false;
    }
    var index = Array.prototype.indexOf.call(cards, active);
    if (index < 0) {
      return false;
    }
    var items = filtered(state.live.items, "live");
    var nextIndex = index + 1;
    if (nextIndex >= cards.length && state.live.rendered < items.length) {
      appendLiveCards(items);
      cards = document.querySelectorAll("#live-list [data-record-uid]");
    }
    if (nextIndex >= cards.length) {
      nextIndex = cards.length - 1;
    }
    focusNode(cards[nextIndex]);
    return true;
  }

  function moveDownInGrid(view) {
    var paneId = view === "movies" ? "movie-grid" : "series-grid";
    var pane = document.getElementById(paneId);
    var active = document.activeElement;
    if (!pane || !active || !pane.contains(active)) {
      return false;
    }
    var cards = pane.querySelectorAll(".grid-wrap [data-record-uid]");
    if (!cards.length) {
      return false;
    }
    var index = Array.prototype.indexOf.call(cards, active);
    if (index < 0) {
      return false;
    }
    var cols = detectGridColumns(cards);
    var nextIndex = index + cols;
    var items = filtered(view === "movies" ? state.movies.items : state.series.items, view);
    var rendered = view === "movies" ? state.movies.rendered : state.series.rendered;
    if (nextIndex >= cards.length && rendered < items.length) {
      if (view === "movies") {
        appendMovieGrid(items);
      } else {
        appendSeriesGrid(items);
      }
      cards = pane.querySelectorAll(".grid-wrap [data-record-uid]");
    }
    if (nextIndex >= cards.length) {
      nextIndex = cards.length - 1;
    }
    focusNode(cards[nextIndex]);
    return true;
  }

  function tryLockedPanelDownNavigation() {
    if (state.overlay.open) {
      return false;
    }
    if (moveDownInLiveList()) {
      return true;
    }
    if (moveDownInGrid("movies")) {
      return true;
    }
    if (moveDownInGrid("series")) {
      return true;
    }
    return false;
  }

  function setRail(view) {
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn[data-view]"), function (btn) {
      if (btn.getAttribute("data-view") === view) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  function handleBack() {
    if (trailerState.open) {
      closeTrailerPopup(true);
      return true;
    }
    if (state.overlay.open) {
      closeOverlayPlayer();
      return true;
    }
    if (state.movieDetail.open) {
      closeMovieDetails();
      return true;
    }
    if (isConfirmDialogOpen()) {
      closeConfirmDialog();
      return true;
    }
    if (dom.sourceMenu.classList.contains("open")) {
      closeSourceMenu();
      return true;
    }
    if (dom.sourceModal.classList.contains("open") && state.sources.length) {
      closeSourceModal();
      return true;
    }
    if (state.view !== "home") {
      if (state.view === "series" && state.series.selectedUid) {
        returnToSeriesGrid();
        return true;
      }
      state.view = "home";
      renderCurrentView();
      return true;
    }
    return false;
  }

  function handleOverlayKeys(code) {
    var active = document.activeElement;
    var inButtons = active && active.closest && !!active.closest(".overlay-buttons");
    if (!state.overlay.open) {
      return false;
    }
    showOverlayControls();
    if (inButtons) {
      if (code === 37 || code === 39) {
        return moveInHorizontalActionRow(code === 37 ? "left" : "right");
      }
      // UP/DOWN while in button row — stay in overlay, don't escape to page
      if (code === 38 || code === 40) {
        return true;
      }
      if (code === 13) {
        return false; // Let the focused button fire its own click
      }
      return false;
    }
    // Controls were hidden and focus escaped — route all directional keys into the button row
    if (code === 37 || code === 39 || code === 38 || code === 40) {
      var ppBtn = document.getElementById("overlay-playpause");
      if (ppBtn) {
        ppBtn.focus();
        if (code === 37) moveInHorizontalActionRow("left");
        if (code === 39) moveInHorizontalActionRow("right");
      }
      return true;
    }
    if (code === 13) {
      toggleOverlayPlayback();
      return true;
    }
    return false;
  }

  function trailerFocusables() {
    var modal = document.getElementById("trailer-modal");
    if (!modal) {
      return [];
    }
    return Array.prototype.filter.call(
      modal.querySelectorAll(".focusable[tabindex]"),
      function (node) {
        return node && node.tabIndex >= 0 && isVisible(node);
      }
    );
  }

  function handleTrailerKeys(code) {
    if (!trailerState.open) {
      return false;
    }
    if (code !== 37 && code !== 38 && code !== 39 && code !== 40) {
      return false;
    }
    var nodes = trailerFocusables();
    if (!nodes.length) {
      return true;
    }
    var index = Array.prototype.indexOf.call(nodes, document.activeElement);
    // Always consume arrows and wrap around, otherwise webOS spatial navigation
    // walks focus onto the page behind the popup and it can never come back.
    if (index < 0) {
      focusNode(nodes[0]);
      return true;
    }
    if (code === 37 || code === 38) {
      index = index === 0 ? nodes.length - 1 : index - 1;
    } else {
      index = index === nodes.length - 1 ? 0 : index + 1;
    }
    focusNode(nodes[index]);
    return true;
  }

  function handleMovieDetailKeys(code) {
    var modal = document.getElementById("movie-detail-modal");
    if (
      !state.movieDetail.open ||
      !modal ||
      !modal.classList.contains("open") ||
      trailerState.open
    ) {
      return false;
    }
    if (code !== 37 && code !== 38 && code !== 39 && code !== 40) {
      return false;
    }
    var nodes = Array.prototype.filter.call(
      modal.querySelectorAll(".focusable[tabindex]"),
      function (node) {
        return node && node.tabIndex >= 0 && !node.disabled && isVisible(node);
      }
    );
    if (!nodes.length) {
      return true;
    }
    var index = Array.prototype.indexOf.call(nodes, document.activeElement);
    if (index < 0) {
      focusNode(nodes[0]);
      return true;
    }
    if (code === 37 || code === 38) {
      index = index === 0 ? nodes.length - 1 : index - 1;
    } else {
      index = index === nodes.length - 1 ? 0 : index + 1;
    }
    focusNode(nodes[index]);
    return true;
  }

  function handleInlineKeys(code) {
    var target;
    var active = document.activeElement;
    if (!active || active.id !== "inline-video") {
      return false;
    }
    if (code === 13) {
      openOverlayPlayer(state.inline.record, state.inline.list, state.inline.index);
      return true;
    }
    if (code === 37) {
      target =
        document.querySelector(
          '#live-list [data-record-uid="' + (state.live.activeUid || "") + '"]'
        ) || document.querySelector("#live-list [data-record-uid]");
      if (target) {
        focusNode(target);
      }
      return true;
    }
    if (code === 39 || code === 38 || code === 40) {
      target =
        document.getElementById("inline-ov-full") || document.getElementById("inline-ov-prev");
      if (target) {
        focusNode(target);
      }
      return true;
    }
    return false;
  }

  function handleChannelKey(code) {
    if (code !== 33 && code !== 34 && code !== 427 && code !== 428) {
      return false;
    }
    if (state.overlay.open && state.overlay.record && state.overlay.record.view === "live") {
      if (code === 33 || code === 427) {
        changeOverlayRecord(-1);
      } else {
        changeOverlayRecord(1);
      }
      return true;
    }
    if (state.inline.record) {
      if (code === 33 || code === 427) {
        changeInlineChannel(-1);
      } else {
        changeInlineChannel(1);
      }
      return true;
    }
    return false;
  }

  function bindStaticEvents() {
    var mainShell = document.getElementById("main");

    resetViewportScroll();
    window.addEventListener("scroll", resetViewportScroll);
    if (mainShell) {
      mainShell.addEventListener("scroll", function () {
        if (mainShell.scrollTop || mainShell.scrollLeft) {
          mainShell.scrollTop = 0;
          mainShell.scrollLeft = 0;
        }
      });
    }
    if (dom.workspace) {
      dom.workspace.addEventListener("scroll", function () {
        if (dom.workspace.scrollTop || dom.workspace.scrollLeft) {
          dom.workspace.scrollTop = 0;
          dom.workspace.scrollLeft = 0;
        }
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll(".tab-btn"), function (btn) {
      btn.addEventListener("click", function () {
        setSourceTab(btn.getAttribute("data-source-tab"));
      });
    });

    document.getElementById("source-save").addEventListener("click", function () {
      clearSourceError();
      var saveBtn = this;
      var originalLabel = saveBtn.textContent;
      var unlockTimer = null;
      var source;
      try {
        source = buildSourceObject();
      } catch (e) {
        showSourceError(e.message || "Invalid source.");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Checking...";
      // Move focus away from the now-disabled button so the TV remote keeps working.
      var cancelBtn = document.getElementById("source-cancel");
      if (cancelBtn) {
        safeFocus(cancelBtn);
      }
      unlockTimer = setTimeout(function () {
        var stuckBtn = document.getElementById("source-save");
        if (!stuckBtn || !stuckBtn.disabled) {
          return;
        }
        stuckBtn.disabled = false;
        stuckBtn.textContent = originalLabel;
        safeFocus(stuckBtn);
        showSourceError("Validation timed out. Check server URL, credentials, and internet.");
      }, 15000);
      validateSource(source)
        .then(
          function () {
            upsertSource(source);
          },
          function (err) {
            showSourceError(err && err.message ? err.message : "Source validation failed.");
          }
        )
        .then(
          function () {
            clearTimeout(unlockTimer);
            var btn = document.getElementById("source-save");
            if (btn) {
              btn.disabled = false;
              btn.textContent = originalLabel;
              safeFocus(btn);
            }
          },
          function () {
            clearTimeout(unlockTimer);
            var btn = document.getElementById("source-save");
            if (btn) {
              btn.disabled = false;
              btn.textContent = originalLabel;
              safeFocus(btn);
            }
          }
        );
    });

    document.getElementById("source-cancel").addEventListener("click", closeSourceModal);
    if (dom.openSourceModalBtn) {
      dom.openSourceModalBtn.addEventListener("click", openSourceModal);
    }
    dom.sourceMenuBtn.addEventListener("click", function () {
      if (dom.sourceMenu.classList.contains("open")) {
        closeSourceMenu();
      } else {
        openSourceMenu();
      }
    });
    if (dom.refreshBtn) {
      dom.refreshBtn.addEventListener("click", function () {
        refreshSelectedSubcategory();
      });
    }
    dom.logoutBtn.addEventListener("click", function () {
      openConfirmDialog({
        title: "Close TV Navigator?",
        message: "Do you want to close the application?",
        confirmLabel: "Yes",
        cancelLabel: "Cancel",
        returnFocusSelector: "#logout-btn",
        onConfirm: closeApplication
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".rail-btn[data-view]"), function (btn) {
      btn.addEventListener("click", function () {
        state.view = btn.getAttribute("data-view");
        renderCurrentView();
      });
    });

    // Searching on every keystroke is far too slow on TV hardware - wait for OK/Enter.
    dom.search.addEventListener("keydown", function (event) {
      var code = event.keyCode || event.which;
      if (code !== 13) {
        return;
      }
      event.preventDefault();
      state.searchQuery = dom.search.value;
      refreshCurrentView();
    });
    dom.search.addEventListener("input", function () {
      if (trim(dom.search.value) === "" && trim(state.searchQuery) !== "") {
        state.searchQuery = "";
        refreshCurrentView();
      }
    });

    dom.overlayPlayPause.addEventListener("click", toggleOverlayPlayback);
    dom.overlayRew.addEventListener("click", function () {
      overlaySeek(-15);
    });
    dom.overlayFwd.addEventListener("click", function () {
      overlaySeek(15);
    });
    dom.overlayFavorite.addEventListener("click", function () {
      if (state.overlay.record) {
        toggleFavorite(state.overlay.record, true);
      }
    });
    dom.overlaySubtitleBtn.addEventListener("click", cycleOverlaySubtitle);
    dom.overlayQualityBtn.addEventListener("click", cycleOverlayQuality);
    dom.overlayFullscreenBtn.addEventListener("click", toggleOverlayFullscreen);
    dom.overlayClose.addEventListener("click", function () {
      closeOverlayPlayer();
    });
    dom.overlayPrev.addEventListener("click", function () {
      changeOverlayRecord(-1);
    });
    dom.overlayNext.addEventListener("click", function () {
      changeOverlayRecord(1);
    });

    if (dom.confirmCancel) {
      dom.confirmCancel.addEventListener("click", function () {
        closeConfirmDialog();
      });
    }
    if (dom.confirmOk) {
      dom.confirmOk.addEventListener("click", function () {
        confirmDialogAccept();
      });
    }

    document.addEventListener("click", function (event) {
      if (!dom.sourceMenu.contains(event.target) && event.target !== dom.sourceMenuBtn) {
        closeSourceMenu();
      }
    });

    function normalizedRemoteCode(event) {
      var code = event.keyCode || event.which || 0;
      var key = event.key || "";
      if (code) {
        return code;
      }
      if (key === "ArrowLeft") {
        return 37;
      }
      if (key === "ArrowUp") {
        return 38;
      }
      if (key === "ArrowRight") {
        return 39;
      }
      if (key === "ArrowDown") {
        return 40;
      }
      if (key === "Enter" || key === "OK") {
        return 13;
      }
      if (key === "Backspace") {
        return 8;
      }
      if (key === "Escape") {
        return 27;
      }
      if (key === "GoBack" || key === "Back") {
        return 461;
      }
      if (key === "ChannelUp") {
        return 33;
      }
      if (key === "ChannelDown") {
        return 34;
      }
      return 0;
    }

    function ensureRemoteFocusAnchor(code) {
      var active = document.activeElement;
      var target;
      if (code !== 37 && code !== 38 && code !== 39 && code !== 40) {
        return;
      }
      if (active && active !== document.body && active !== document.documentElement) {
        return;
      }
      // Prefer the open modal's focusable elements first.
      if (dom.sourceModal.classList.contains("open")) {
        var modalNodes = modalFocusableNodes ? modalFocusableNodes() : [];
        target = modalNodes[0] || null;
      }
      if (!target) {
        target =
          firstFocusableIn("#workspace") ||
          document.querySelector(".rail-btn.active") ||
          firstFocusableIn("#rail") ||
          firstFocusableIn("#topbar");
      }
      if (target) {
        focusNode(target);
      }
    }

    // Returns visible focusable nodes inside the source modal.
    // Avoids offsetParent checks (unreliable for position:fixed on webOS 3.x).
    function modalFocusableNodes() {
      var nodes = [];
      if (!dom.sourceModal.classList.contains("open")) return nodes;
      Array.prototype.forEach.call(
        dom.sourceModal.querySelectorAll("button[tabindex], input[tabindex], [tabindex]"),
        function (n) {
          if (n.tabIndex < 0 || n.disabled) return;
          // Skip elements inside a hidden (inactive) form tab
          var block = n.parentNode;
          while (block && block !== dom.sourceModal) {
            if (
              block.classList &&
              block.classList.contains("source-form-block") &&
              !block.classList.contains("active")
            ) {
              return; // inside hidden tab – skip
            }
            block = block.parentNode;
          }
          nodes.push(n);
        }
      );
      return nodes;
    }

    function handleModalKeys(code) {
      if (!dom.sourceModal.classList.contains("open")) return false;
      var active = document.activeElement;
      var nodes = modalFocusableNodes();
      if (!nodes.length) return false;

      // If focus is outside the modal, claim it on any directional/OK press
      var inModal = active && dom.sourceModal.contains(active);
      if (!inModal) {
        if (code === 37 || code === 38 || code === 39 || code === 40 || code === 13) {
          focusNode(nodes[0]);
          return true;
        }
        return false;
      }

      var idx = Array.prototype.indexOf.call(nodes, active);

      if (code === 13) {
        // OK/Enter on a non-input – fire click
        if (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") {
          active.click();
          return true;
        }
        // On webOS 3.x, Enter on an input advances focus to the next modal node
        // (or wraps to Save Source) so users don't need arrows to reach buttons.
        var nextEnterIdx = idx + 1;
        if (nextEnterIdx < nodes.length) {
          focusNode(nodes[nextEnterIdx]);
        } else {
          var saveNode = document.getElementById("source-save");
          if (saveNode) focusNode(saveNode);
        }
        return true;
      }

      // Horizontal tab-row navigation (LEFT/RIGHT on tab buttons)
      var inTabRow = active.classList && active.classList.contains("tab-btn");
      if (inTabRow && (code === 37 || code === 39)) {
        var nextIdx = code === 37 ? idx - 1 : idx + 1;
        if (
          nextIdx >= 0 &&
          nextIdx < nodes.length &&
          nodes[nextIdx].classList.contains("tab-btn")
        ) {
          focusNode(nodes[nextIdx]);
          return true;
        }
        return true; // consume – don't let focus escape
      }

      // Vertical navigation (UP/DOWN move through the node list)
      if (code === 38 || code === 40) {
        var dir = code === 38 ? -1 : 1;
        var candidate = idx + dir;
        if (candidate >= 0 && candidate < nodes.length) {
          focusNode(nodes[candidate]);
        }
        return true; // always consume to prevent focus escaping modal
      }

      // LEFT/RIGHT between action buttons at the bottom
      if (code === 37 || code === 39) {
        var d = code === 37 ? -1 : 1;
        var c = idx + d;
        if (c >= 0 && c < nodes.length) {
          focusNode(nodes[c]);
        }
        return true;
      }

      return false;
    }

    // Timestamp-based dedup for document + window dual listeners
    var _lastKeyTime = 0;
    var _lastKeyCode = 0;

    function onRemoteKeydown(event) {
      if (!event) {
        return;
      }
      var code = normalizedRemoteCode(event);
      if (!code) {
        return;
      }
      hud("key:" + code);
      // Do NOT use event.defaultPrevented — webOS spatial navigation sets it
      // for every arrow key, which would block all remote navigation.
      var now = Date.now();
      if (code === _lastKeyCode && now - _lastKeyTime < 60) {
        return;
      }
      _lastKeyTime = now;
      _lastKeyCode = code;
      ensureRemoteFocusAnchor(code);
      try {
        var activeTag = document.activeElement ? document.activeElement.tagName : "";
        var isInput = activeTag === "INPUT" || activeTag === "TEXTAREA";
        if (code === 461 || code === 10009 || code === 27 || (code === 8 && !isInput)) {
          // On webOS 3.x: BACK while a modal input is focused dismisses the
          // virtual keyboard instead of closing the modal.
          if (
            (code === 461 || code === 10009 || code === 27) &&
            dom.sourceModal.classList.contains("open") &&
            isInput &&
            dom.sourceModal.contains(document.activeElement)
          ) {
            document.activeElement.blur();
            event.preventDefault();
            // Restore focus to first available button so remote navigation resumes.
            setTimeout(function () {
              var ns = modalFocusableNodes();
              var btn = null;
              for (var bi = 0; bi < ns.length; bi++) {
                if (ns[bi].tagName === "BUTTON") {
                  btn = ns[bi];
                  break;
                }
              }
              if (btn) focusNode(btn);
            }, 80);
            return;
          }
          if (handleBack()) {
            event.preventDefault();
          }
          return;
        }
        if (handleTrailerKeys(code)) {
          event.preventDefault();
          return;
        }
        if (handleModalKeys(code)) {
          event.preventDefault();
          return;
        }
        if (handleOverlayKeys(code)) {
          event.preventDefault();
          return;
        }
        if (handleMovieDetailKeys(code)) {
          event.preventDefault();
          return;
        }
        if (handleChannelKey(code)) {
          event.preventDefault();
          return;
        }
        if (handleInlineKeys(code)) {
          event.preventDefault();
          return;
        }
        if (
          !isInput &&
          code === 13 &&
          document.activeElement &&
          typeof document.activeElement.click === "function"
        ) {
          document.activeElement.click();
          event.preventDefault();
          return;
        }
        if (isInput && document.activeElement === dom.search) {
          if (code === 37) {
            moveFocus("left");
            event.preventDefault();
            return;
          }
          if (code === 39) {
            moveFocus("right");
            event.preventDefault();
            return;
          }
          if (code === 40) {
            var workspaceItem = firstFocusableIn("#workspace");
            if (workspaceItem) {
              focusNode(workspaceItem);
            } else {
              moveFocus("down");
            }
            event.preventDefault();
            return;
          }
          if (code === 38) {
            var railItem = document.querySelector(".rail-btn.active") || firstFocusableIn("#rail");
            if (railItem) {
              focusNode(railItem);
            } else {
              moveFocus("up");
            }
            event.preventDefault();
            return;
          }
        }
        if (
          isInput &&
          document.activeElement &&
          document.activeElement.classList &&
          document.activeElement.classList.contains("category-search-input")
        ) {
          if (code === 37) {
            moveFocus("left");
            event.preventDefault();
            return;
          }
          if (code === 39) {
            moveFocus("right");
            event.preventDefault();
            return;
          }
          if (code === 38) {
            moveFocus("up");
            event.preventDefault();
            return;
          }
          if (code === 40) {
            moveFocus("down");
            event.preventDefault();
            return;
          }
        }
        // Source-modal inputs: UP/DOWN must escape the field to reach the buttons.
        if (
          isInput &&
          dom.sourceModal.classList.contains("open") &&
          dom.sourceModal.contains(document.activeElement)
        ) {
          if (code === 38) {
            moveFocus("up");
            event.preventDefault();
            return;
          }
          if (code === 40) {
            moveFocus("down");
            event.preventDefault();
            return;
          }
        }
        if (isInput) {
          return;
        }
        if (
          (code === 37 || code === 38 || code === 39 || code === 40) &&
          sequencedDirectionalNavigation(
            code === 37 ? "left" : code === 38 ? "up" : code === 39 ? "right" : "down"
          )
        ) {
          event.preventDefault();
          return;
        }
        if (code === 37) {
          if (shelfArrowNav("left")) {
            event.preventDefault();
            return;
          }
          moveFocus("left");
          event.preventDefault();
        } else if (code === 38) {
          moveFocus("up");
          event.preventDefault();
        } else if (code === 39) {
          if (shelfArrowNav("right")) {
            event.preventDefault();
            return;
          }
          moveFocus("right");
          event.preventDefault();
        } else if (code === 40) {
          if (tryLockedPanelDownNavigation()) {
            event.preventDefault();
            return;
          }
          moveFocus("down");
          event.preventDefault();
        }
      } catch (e) {
        // Keep remote navigation resilient on TV even if a specific branch errors.
      }
    }

    document.addEventListener("keydown", onRemoteKeydown);
    window.addEventListener("keydown", onRemoteKeydown);

    // webOS 3.x fallback: some remotes fire keyup for OK when a button is focused.
    // If the keydown handler already processed OK we skip; otherwise fire click here.
    var _okKeydownHandled = false;
    document.addEventListener(
      "keydown",
      function (e) {
        var kc = e.keyCode || e.which || 0;
        _okKeydownHandled = kc === 13 || kc === 0x000d;
      },
      true
    );
    document.addEventListener("keyup", function (e) {
      var kc = e.keyCode || e.which || 0;
      if ((kc === 13 || kc === 0x000d) && !_okKeydownHandled) {
        var el = document.activeElement;
        if (el && el.tagName === "BUTTON" && dom.sourceModal.contains(el)) {
          el.click();
          e.preventDefault();
        }
      }
      _okKeydownHandled = false;
    });
  }

  function init() {
    hud("init:1 applyClass");
    applyCardDensityClass();
    applyThemeClass();
    hud("init:2 syncIcons");
    syncOverlayControlIcons();
    hud("init:3 bindEvents");
    bindStaticEvents();
    hud("init:4 clock");
    startAppClockTicker();
    hud("init:5 syncSrc");
    syncSourceButton();
    renderSourceMenu();
    hud("init:6 sources=" + state.sources.length);
    if (!state.sources.length) {
      window.location.replace("login.html");
      return;
    }
    hud("init:7 render");
    dom.sourceModal.classList.remove("open");
    renderCurrentView();
    hud("init:8 focus");
    focusFirst(".rail-btn.active");
  }

  try {
    init();
    hud("init OK");
    hideDiag();
  } catch (e) {
    // Surface any startup crash in the on-screen overlay so it is readable on the TV.
    if (window.onerror) {
      window.onerror((e && e.message) || String(e), "app.js", (e && e.lineNumber) || 0, 0);
    }
    try {
      var box = document.getElementById("app-err-overlay");
      if (box) box.style.display = "block";
      var ul = document.getElementById("app-err-list");
      if (ul) {
        var li = document.createElement("li");
        li.textContent = "INIT CRASH: " + ((e && e.stack) || (e && e.message) || String(e));
        ul.appendChild(li);
      }
    } catch (e2) {}
  }

  // Allow BACK key to dismiss the error overlay on the TV.
  document.addEventListener("keydown", function (ev) {
    var kc = ev.keyCode || ev.which || 0;
    if (kc === 461 || kc === 10009 || kc === 27 || kc === 8) {
      var box = document.getElementById("app-err-overlay");
      if (box && box.style.display !== "none") {
        box.style.display = "none";
        ev.preventDefault();
      }
    }
  });
})();
