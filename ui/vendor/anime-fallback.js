/*
 * Tiny fallback engine, only used if vendor/anime.min.js hasn't been added
 * yet (see README — download the real anime.js v3 for the full easing set).
 * Implements just enough of anime.js's call shape for this app:
 *   anime({ targets, translateY, translateX, opacity, scale, width, height,
 *            duration, delay, easing, complete })
 *   anime.stagger(ms)
 */
(function () {
  if (window.anime) return; // real library already loaded, don't shadow it

  var EASES = {
    linear: function (t) { return t; },
    easeOutQuad: function (t) { return 1 - (1 - t) * (1 - t); },
    easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    easeOutElastic: function (t) {
      var c4 = (2 * Math.PI) / 3;
      return t === 0 ? 0 : t === 1 ? 1
        : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    easeOutBack: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
  };

  function pickEase(name) {
    if (!name) return EASES.easeOutQuad;
    var key = Object.keys(EASES).find(function (k) { return name.indexOf(k) === 0; });
    return EASES[key] || EASES.easeOutQuad;
  }

  function toEls(targets) {
    if (typeof targets === "string") return Array.prototype.slice.call(document.querySelectorAll(targets));
    if (targets instanceof NodeList || Array.isArray(targets)) return Array.prototype.slice.call(targets);
    return [targets];
  }

  var PROP_UNITS = { translateX: "px", translateY: "px", width: "", height: "" };

  function animate(el, props, opts, extraDelay) {
    var start = performance.now();
    var duration = opts.duration || 400;
    var delay = (opts.delay || 0) + (extraDelay || 0);
    var ease = pickEase(opts.easing);

    var from = {};
    var to = {};
    var units = {};

 Object.keys(props).forEach(function (key) {
      var target = props[key];
      units[key] = typeof target === "string" && target.indexOf("%") > -1 ? "%" : (PROP_UNITS[key] || "");

      if (Array.isArray(target)) {
        // anime.js [from, to] shorthand
        from[key] = parseFloat(target[0]);
        to[key] = parseFloat(target[1]);
        return;
      }

      to[key] = parseFloat(target);
      if (key === "opacity") {
        from[key] = parseFloat(getComputedStyle(el).opacity) || 0;
      } else if (key === "width" || key === "height") {
        from[key] = el.getBoundingClientRect()[key];
      } else {
        from[key] = 0; // translate/scale default baseline
      }
    });
    
    function frame(now) {
      var elapsed = now - start - delay;
      if (elapsed < 0) { requestAnimationFrame(frame); return; }
      var t = Math.min(1, elapsed / duration);
      var e = ease(t);

      var transforms = [];
      Object.keys(props).forEach(function (key) {
        var v = from[key] + (to[key] - from[key]) * e;
        if (key === "opacity") {
          el.style.opacity = v;
        } else if (key === "translateY") {
          transforms.push("translateY(" + v + "px)");
        } else if (key === "translateX") {
          transforms.push("translateX(" + v + "px)");
        } else if (key === "scale") {
          transforms.push("scale(" + v + ")");
        } else if (key === "width" || key === "height") {
          el.style[key] = v + units[key];
        }
      });
      if (transforms.length) el.style.transform = transforms.join(" ");

      if (t < 1) {
        requestAnimationFrame(frame);
      } else if (typeof opts.complete === "function") {
        opts.complete();
      }
    }
    requestAnimationFrame(frame);
  }

  function anime(opts) {
    var els = toEls(opts.targets);
    var delayIsFn = typeof opts.delay === "function";
    var lastDone = 0;
    els.forEach(function (el, i) {
      var extraDelay = delayIsFn ? opts.delay(i) : 0;
      animate(el, opts, delayIsFn ? Object.assign({}, opts, { delay: 0 }) : opts, extraDelay);
      lastDone = i;
    });
    if (typeof opts.complete === "function" && els.length > 1) {
      // fallback already calls complete per-element for delay=0 case; when
      // staggered, let the last element's own complete (set below) fire once.
    }
    return { finished: Promise.resolve() };
  }

  anime.stagger = function (ms) {
    return function (i) { return i * ms; };
  };

  window.anime = anime;
})();
