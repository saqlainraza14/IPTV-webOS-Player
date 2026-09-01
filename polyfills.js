/* polyfills.js — webOS 3.x / Chromium 38 compatibility shims */

/* Promise (required by app flow and fetch polyfill)
   Chromium 38 normally has Promise, but this guarantees availability on constrained webOS builds. */
if (typeof window.Promise !== "function") {
  (function () {
    function isFunction(fn) {
      return typeof fn === "function";
    }

    function SimplePromise(executor) {
      if (!isFunction(executor)) {
        throw new TypeError("Promise resolver is not a function");
      }
      this._state = "pending";
      this._value = undefined;
      this._handlers = [];

      var self = this;
      function resolve(value) {
        if (self._state !== "pending") return;
        if (value && (typeof value === "object" || isFunction(value))) {
          var then;
          try {
            then = value.then;
          } catch (e) {
            reject(e);
            return;
          }
          if (isFunction(then)) {
            try {
              then.call(value, resolve, reject);
              return;
            } catch (e2) {
              reject(e2);
              return;
            }
          }
        }
        self._state = "fulfilled";
        self._value = value;
        flush(self);
      }

      function reject(reason) {
        if (self._state !== "pending") return;
        self._state = "rejected";
        self._value = reason;
        flush(self);
      }

      try {
        executor(resolve, reject);
      } catch (e) {
        reject(e);
      }
    }

    function schedule(fn) {
      setTimeout(fn, 0);
    }

    function flush(promise) {
      schedule(function () {
        while (promise._handlers.length) {
          handle(promise, promise._handlers.shift());
        }
      });
    }

    function handle(promise, handler) {
      if (promise._state === "pending") {
        promise._handlers.push(handler);
        return;
      }
      var cb =
        promise._state === "fulfilled"
          ? handler.onFulfilled
          : handler.onRejected;
      if (!isFunction(cb)) {
        if (promise._state === "fulfilled") handler.resolve(promise._value);
        else handler.reject(promise._value);
        return;
      }
      try {
        var ret = cb(promise._value);
        handler.resolve(ret);
      } catch (e) {
        handler.reject(e);
      }
    }

    SimplePromise.prototype.then = function (onFulfilled, onRejected) {
      var self = this;
      return new SimplePromise(function (resolve, reject) {
        handle(self, {
          onFulfilled: onFulfilled,
          onRejected: onRejected,
          resolve: resolve,
          reject: reject,
        });
      });
    };

    SimplePromise.prototype.catch = function (onRejected) {
      return this.then(null, onRejected);
    };

    SimplePromise.resolve = function (value) {
      return new SimplePromise(function (resolve) {
        resolve(value);
      });
    };

    SimplePromise.reject = function (reason) {
      return new SimplePromise(function (resolve, reject) {
        reject(reason);
      });
    };

    SimplePromise.all = function (iterable) {
      return new SimplePromise(function (resolve, reject) {
        var arr = Array.prototype.slice.call(iterable || []);
        if (!arr.length) {
          resolve([]);
          return;
        }
        var result = new Array(arr.length);
        var remaining = arr.length;
        function resolver(i) {
          return function (val) {
            result[i] = val;
            remaining--;
            if (remaining === 0) resolve(result);
          };
        }
        for (var i = 0; i < arr.length; i++) {
          SimplePromise.resolve(arr[i]).then(resolver(i), reject);
        }
      });
    };

    SimplePromise.race = function (iterable) {
      return new SimplePromise(function (resolve, reject) {
        var arr = Array.prototype.slice.call(iterable || []);
        for (var i = 0; i < arr.length; i++) {
          SimplePromise.resolve(arr[i]).then(resolve, reject);
        }
      });
    };

    window.Promise = SimplePromise;
  })();
}

/* fetch polyfill (XHR-backed) */
if (typeof window.fetch !== "function") {
  window.fetch = function (url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(options.method || "GET", url, true);

      if (options.headers) {
        for (var h in options.headers) {
          if (Object.prototype.hasOwnProperty.call(options.headers, h)) {
            xhr.setRequestHeader(h, options.headers[h]);
          }
        }
      }

      xhr.onload = function () {
        var bodyText = xhr.responseText;
        var response = {
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          statusText: xhr.statusText,
          url: url,
          text: function () {
            return Promise.resolve(bodyText);
          },
          json: function () {
            try {
              return Promise.resolve(JSON.parse(bodyText));
            } catch (e) {
              return Promise.reject(e);
            }
          },
        };
        resolve(response);
      };

      xhr.onerror = function () {
        reject(new TypeError("Network request failed"));
      };
      xhr.ontimeout = function () {
        reject(new TypeError("Network request timed out"));
      };

      xhr.send(options.body || null);
    });
  };
}

/* Object.assign (added Chrome 45 — not in Chromium 38) */
if (typeof Object.assign !== "function") {
  Object.assign = function (target) {
    if (target == null) {
      throw new TypeError("Cannot convert undefined or null to object");
    }
    var to = Object(target);
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source != null) {
        for (var key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) {
            to[key] = source[key];
          }
        }
      }
    }
    return to;
  };
}

/* Array.from (added Chrome 45 — not in Chromium 38) */
if (!Array.from) {
  Array.from = function (arrayLike, mapFn, thisArg) {
    var arr = Array.prototype.slice.call(arrayLike);
    if (typeof mapFn === "function") {
      return arr.map(mapFn, thisArg);
    }
    return arr;
  };
}

/* Array.prototype.find (added Chrome 45) */
if (!Array.prototype.find) {
  Object.defineProperty(Array.prototype, "find", {
    value: function (predicate) {
      for (var i = 0; i < this.length; i++) {
        if (predicate(this[i], i, this)) {
          return this[i];
        }
      }
      return undefined;
    },
    configurable: true,
    writable: true,
  });
}

/* Array.prototype.findIndex */
if (!Array.prototype.findIndex) {
  Object.defineProperty(Array.prototype, "findIndex", {
    value: function (predicate) {
      for (var i = 0; i < this.length; i++) {
        if (predicate(this[i], i, this)) {
          return i;
        }
      }
      return -1;
    },
    configurable: true,
    writable: true,
  });
}

/* String.prototype.includes */
if (!String.prototype.includes) {
  String.prototype.includes = function (search, start) {
    return this.indexOf(search, start) !== -1;
  };
}

/* String.prototype.startsWith */
if (!String.prototype.startsWith) {
  String.prototype.startsWith = function (search, pos) {
    return this.indexOf(search, pos) === (pos || 0);
  };
}

/* String.prototype.endsWith */
if (!String.prototype.endsWith) {
  String.prototype.endsWith = function (search, len) {
    var l = len === undefined ? this.length : len;
    return this.lastIndexOf(search, l) === l - search.length;
  };
}

/* Element.prototype.matches */
if (!Element.prototype.matches) {
  Element.prototype.matches =
    Element.prototype.msMatchesSelector ||
    Element.prototype.webkitMatchesSelector ||
    function (selector) {
      var matches = (this.document || this.ownerDocument).querySelectorAll(
        selector
      );
      for (var i = 0; i < matches.length; i++) {
        if (matches[i] === this) {
          return true;
        }
      }
      return false;
    };
}

/* Element.prototype.closest (added Chrome 41) */
if (!Element.prototype.closest) {
  Element.prototype.closest = function (selector) {
    var el = this;
    while (el && el.nodeType === 1) {
      if (el.matches(selector)) {
        return el;
      }
      el = el.parentElement || el.parentNode;
    }
    return null;
  };
}

/* ChildNode.remove (added Chrome 29 — should be fine, but just in case) */
if (!Element.prototype.remove) {
  Element.prototype.remove = function () {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  };
}

/* NodeList.forEach (added Chrome 51) */
if (typeof NodeList !== "undefined" && !NodeList.prototype.forEach) {
  NodeList.prototype.forEach = Array.prototype.forEach;
}

/* Number.isNaN */
if (!Number.isNaN) {
  Number.isNaN = function (value) {
    return typeof value === "number" && isNaN(value);
  };
}

/* Number.isFinite */
if (!Number.isFinite) {
  Number.isFinite = function (value) {
    return typeof value === "number" && isFinite(value);
  };
}

/* IntersectionObserver (lightweight polyfill for lazy-load paths)
   This implementation reports basic visibility based on bounding rects. */
if (typeof window.IntersectionObserver !== "function") {
  (function () {
    function nowRect() {
      return {
        top: 0,
        left: 0,
        right: window.innerWidth || document.documentElement.clientWidth || 0,
        bottom:
          window.innerHeight || document.documentElement.clientHeight || 0,
      };
    }

    function intersects(a, b, margin) {
      margin = margin || 0;
      return !(
        a.bottom < b.top - margin ||
        a.top > b.bottom + margin ||
        a.right < b.left - margin ||
        a.left > b.right + margin
      );
    }

    function parseRootMargin(m) {
      if (!m) return 0;
      var n = parseInt(String(m).split(" ")[0], 10);
      return isNaN(n) ? 0 : n;
    }

    function SimpleIntersectionObserver(callback, options) {
      this._callback = callback;
      this._targets = [];
      this._margin = parseRootMargin(options && options.rootMargin);
      this._boundCheck = this._check.bind(this);
      window.addEventListener("scroll", this._boundCheck, true);
      window.addEventListener("resize", this._boundCheck, true);
    }

    SimpleIntersectionObserver.prototype.observe = function (el) {
      if (!el) return;
      if (this._targets.indexOf(el) === -1) this._targets.push(el);
      this._check();
    };

    SimpleIntersectionObserver.prototype.unobserve = function (el) {
      var i = this._targets.indexOf(el);
      if (i !== -1) this._targets.splice(i, 1);
    };

    SimpleIntersectionObserver.prototype.disconnect = function () {
      this._targets = [];
      window.removeEventListener("scroll", this._boundCheck, true);
      window.removeEventListener("resize", this._boundCheck, true);
    };

    SimpleIntersectionObserver.prototype._check = function () {
      var root = nowRect();
      var entries = [];
      for (var i = 0; i < this._targets.length; i++) {
        var el = this._targets[i];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        var isIntersecting = intersects(r, root, this._margin);
        entries.push({
          target: el,
          isIntersecting: isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          boundingClientRect: r,
          rootBounds: root,
          time: Date.now(),
        });
      }
      if (entries.length) this._callback(entries, this);
    };

    window.IntersectionObserver = SimpleIntersectionObserver;
  })();
}

/* console safety */
if (!window.console) {
  window.console = {
    log: function () {},
    error: function () {},
    warn: function () {},
    info: function () {},
  };
}
