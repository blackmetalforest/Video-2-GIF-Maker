/**
 * Preflight: say what is wrong when the browser cannot run the app.
 *
 * The app is a set of ES modules. When one fails to load — an old browser, a
 * stale cached file, the page opened from disk — the app stops before a
 * single button is wired up, and the page just goes dead. Error handling
 * inside the modules dies with them. So the checks live here instead: a
 * classic script, loaded first, that needs nothing the app might be missing.
 *
 * Deliberately old-fashioned JavaScript — var, function, no arrows, no ?. —
 * so it parses and runs on browsers far too old for the app, which are
 * exactly the ones it has to talk to.
 *
 * Problems are shown under the file browser, never as pop-ups, as one line
 * of plain coloured text each — the headline and a link to Browser check.
 * Red when the app cannot do its job, orange when one feature is lost. The
 * full explanation is in the Browser check panel, which is also the only
 * place anything minor appears.
 *
 * Everything user-facing is built with textContent, never innerHTML, because
 * error messages and file names end up in it.
 */
(function (window) {
  'use strict';

  var document = window.document;

  /*
   * What each problem is called, why it matters and one thing to try.
   * F = fatal (the app cannot do its job), W = a warning (it can, worse).
   */
  var MESSAGES = {
    F1: {
      title: 'This page has to be opened through a web server.',
      why: 'Browsers will not load the app’s scripts from a file on disk, so nothing on the page can work.',
      tryText: 'In the app’s folder run “python3 serve.py”, then open http://localhost:8000.',
    },
    F2: {
      title: 'This browser is too old to run the app.',
      why: 'The app is built from modern script files (“ES modules”) that the browser has to understand.',
      tryText: 'Update the browser: Chrome, Edge or Brave 107 or later; Firefox 130 or later; Safari 16.4 or later.',
    },
    F4: {
      title: 'This browser cannot assemble image frames.',
      why: 'Every GIF frame is put together on a hidden drawing surface (OffscreenCanvas), which this browser does not support.',
      tryText: 'Update the browser.',
    },
    F5: {
      title: 'This browser cannot copy video frames.',
      why: 'Converting needs createImageBitmap, which this browser does not support.',
      tryText: 'Update the browser.',
    },
    F6: {
      title: 'This browser will not let the page read its own images.',
      why: 'Every frame is read back pixel by pixel to build the GIF, and a privacy setting or extension is blocking that, so nothing could be saved.',
      tryText: 'Allow this site in the browser’s fingerprinting or privacy protection, or in the extension that blocks canvas reading.',
    },
    F7: {
      title: 'The app did not start.',
      why: 'Something went wrong while it was loading. The usual cause is the browser mixing old cached files with new ones after an update.',
      tryText: 'Press Ctrl+Shift+R (Cmd+Shift+R on a Mac) to reload without the cache. If it keeps happening, Browser check shows what failed.',
    },
    W1: {
      title: 'This browser has no fast video decoder (WebCodecs).',
      why: 'Without it every video has to be converted by ffmpeg inside the page first, which is slow and downloads 32 MB once.',
      tryText: 'Update the browser: Chrome, Edge or Brave 94 or later; Firefox 130 or later; Safari 26 or later.',
    },
    W2: {
      title: 'Your browser is altering image pixels.',
      why: 'A privacy protection adds faint noise when the page reads its own images, so the GIF may not match the video exactly.',
      tryText: 'Allow this site in the browser’s fingerprinting protection (in Brave: Shields).',
    },
    W3: {
      title: 'The timecode is approximate while the video plays.',
      why: 'This browser does not report each frame as it is shown (requestVideoFrameCallback). Paused and stepped frames are still exact.',
      tryText: 'Nothing is lost; pause before marking a frame.',
      note: true,
    },
    W4: {
      title: 'Saving WebP is unavailable.',
      why: 'This browser cannot make WebP images.',
      tryText: 'GIF, APNG and ZIP work normally.',
      note: true,
    },
    W5: {
      title: 'Converting unusual videos is unavailable.',
      why: 'Files the browser cannot play itself are converted by ffmpeg, which needs WebAssembly, and this browser has it switched off.',
      tryText: 'MP4, WebM and other files the browser plays still work.',
      note: true,
    },
    R3: {
      title: 'Something went wrong.',
      why: 'An error happened that the app did not expect. The exact messages are in the details below.',
      tryText: 'If something stopped working, reload the page.',
    },
  };

  function isFatal(id) { return id.charAt(0) === 'F'; }

  /*
   * How loudly each problem is reported. Red and orange get a line under the
   * file browser; minor ones appear only in the Browser check panel.
   */
  function levelOf(id) {
    if (isFatal(id)) return 'red';
    return id === 'W2' || id === 'W3' || id === 'W5' ? 'minor' : 'orange';
  }

  /** Browser facts in, problem ids out. Pure, so the tests can run it. */
  function checks(f) {
    var out = [];
    if (f.protocol === 'file:') out.push('F1');
    if (f.modules === false) out.push('F2');
    if (!f.offscreen2d) out.push('F4');
    if (!f.imageBitmap) out.push('F5');
    if (f.readback === 'blocked') out.push('F6');
    if (!f.webCodecs) out.push('W1');
    if (f.readback === 'altered') out.push('W2');
    if (!f.frameCallback) out.push('W3');
    if (!f.wasm) out.push('W5');
    return out;
  }

  /* ----------------------------------------------------------- probes */

  /**
   * Draw an exact pattern, read it back, compare.
   *
   * 'ok' when it comes back untouched; 'altered' for the faint noise some
   * anti-fingerprinting adds; 'blocked' when reading throws or comes back as
   * something else entirely (a blank or randomised image), which would make
   * every export useless.
   */
  function probeReadback() {
    try {
      var canvas = typeof window.OffscreenCanvas === 'function'
        ? new window.OffscreenCanvas(4, 4)
        : document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      var ctx = canvas.getContext('2d');
      if (!ctx) return 'blocked';
      var expected = [];
      for (var i = 0; i < 16; i++) {
        var rgb = [(i * 16 + 3) % 256, (255 - i * 13) % 256, (i * 37 + 11) % 256];
        ctx.fillStyle = 'rgb(' + rgb.join(',') + ')';
        ctx.fillRect(i % 4, Math.floor(i / 4), 1, 1);
        expected.push(rgb[0], rgb[1], rgb[2], 255);
      }
      var data = ctx.getImageData(0, 0, 4, 4).data;
      var total = 0;
      for (var j = 0; j < expected.length; j++) total += Math.abs(data[j] - expected[j]);
      if (total === 0) return 'ok';
      return total / expected.length > 16 ? 'blocked' : 'altered';
    } catch (e) {
      return 'blocked';
    }
  }

  function probeOffscreen2d() {
    try {
      return typeof window.OffscreenCanvas === 'function'
        && !!new window.OffscreenCanvas(1, 1).getContext('2d');
    } catch (e) {
      return false;
    }
  }

  function gatherFacts() {
    var S = window.HTMLScriptElement;
    var V = window.HTMLVideoElement;
    return {
      protocol: window.location ? window.location.protocol : '',
      modules: S ? 'noModule' in S.prototype : false,
      offscreen2d: probeOffscreen2d(),
      imageBitmap: typeof window.createImageBitmap === 'function',
      readback: probeReadback(),
      webCodecs: typeof window.VideoDecoder === 'function',
      frameCallback: !!(V && 'requestVideoFrameCallback' in V.prototype),
      wasm: typeof window.WebAssembly === 'object',
    };
  }

  /* ------------------------------------------------------------ state */

  var state = {
    ready: false,
    finished: false,
    errors: [],
    facts: null,
    problems: [],
  };

  // Errors that are noise rather than news: Chrome reports a benign resize
  // loop as an error, and cancelled requests arrive as AbortError.
  function ignorable(text) {
    return /ResizeObserver loop|AbortError/.test(text);
  }

  function record(text) {
    if (!text || state.errors.length >= 20) return;
    if (state.errors.indexOf(text) < 0) state.errors.push(text);
  }

  function shortPath(url) {
    var origin = window.location ? window.location.origin : '';
    return String(url || '').replace(origin, '');
  }

  // Capture phase, so a <script> or <link> that fails to load is caught too:
  // those errors do not bubble, and a missing module file is one of them.
  window.addEventListener('error', function (e) {
    var target = e && e.target;
    if (target && target !== window && (target.src || target.href)) {
      // A module whose import is missing is reported against the module at
      // the top of the chain, and the page is never told which file it was.
      var module = target.type === 'module' ? ' or one of the files it imports' : '';
      record('Could not load ' + shortPath(target.src || target.href) + module);
      return;
    }
    var where = e && e.filename ? ' (' + shortPath(e.filename) + ':' + e.lineno + ')' : '';
    var text = ((e && e.message) || 'Unknown error') + where;
    record(text);
    if (state.ready && !ignorable(text)) unexpected();
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var text = (reason && (reason.message || reason.name)) || String(reason);
    if (reason && reason.name === 'AbortError') return;
    record(text);
    if (state.ready && !ignorable(text)) unexpected();
  });

  /* --------------------------------------------------------------- UI */

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var key in attrs) {
      if (key === 'style') node.style.cssText = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function yes(value) {
    return value === true ? 'yes' : value === false ? 'no' : 'unknown';
  }

  function detailsText() {
    var f = state.facts || {};
    var x = api.extras || {};
    var version = document.getElementById('app-version');
    var lines = [
      'App: ' + (version ? version.textContent : 'version not found'),
      'Browser: ' + (window.navigator ? window.navigator.userAgent : ''),
      'Address: ' + (window.location ? window.location.protocol + '//' + window.location.host : ''),
      'ES modules: ' + yes(f.modules)
        + ' · OffscreenCanvas: ' + yes(f.offscreen2d)
        + ' · createImageBitmap: ' + yes(f.imageBitmap)
        + ' · pixel read-back: ' + (f.readback || 'unknown'),
      'WebCodecs: ' + yes(f.webCodecs)
        + ' · frame callbacks: ' + yes(f.frameCallback)
        + ' · WebAssembly: ' + yes(f.wasm)
        + ' · WebP encode: ' + yes(x.webp),
    ];
    if (x.decoders) lines.push('Decoders: ' + x.decoders);
    if (x.video) lines.push('Video: ' + x.video);
    lines.push('App started: ' + yes(state.ready));
    if (state.errors.length) {
      lines.push('Errors:');
      for (var i = 0; i < state.errors.length; i++) lines.push('  ' + state.errors[i]);
    }
    return lines.join('\n');
  }

  /*
   * The Browser check panel: the only thing here that opens over the page,
   * and only when someone asks for it. Styled inline so it is readable even
   * when style.css is missing or stale — which is sometimes the problem.
   */
  function showCheck() {
    var old = document.getElementById('browser-check-panel');
    if (old) old.parentNode.removeChild(old);
    if (!state.facts) state.facts = gatherFacts();

    var panel = el('div', {
      id: 'browser-check-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'browser-check-title',
      style: 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;overflow:auto;padding:24px 16px;'
        + 'background:rgba(12,13,16,0.94);color:#e7e9ee;'
        + 'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
    });
    var card = el('div', {
      style: 'max-width:640px;margin:0 auto;background:#1c1e24;border:1px solid #2f333c;'
        + 'border-radius:8px;padding:20px',
    });
    card.appendChild(el('h2', { id: 'browser-check-title', style: 'margin:0 0 16px;font-size:18px' },
      'Browser check'));
    if (state.problems.length) card.appendChild(problemList());
    card.appendChild(checkList());

    var details = el('details', { open: '' });
    details.appendChild(el('summary', { style: 'cursor:pointer;color:#9aa1ad' }, 'Details for a bug report'));
    details.appendChild(el('pre', {
      style: 'white-space:pre-wrap;word-break:break-word;background:#15161a;padding:10px;'
        + 'border-radius:6px;font-size:12px;margin:8px 0 0;user-select:text',
    }, detailsText()));
    card.appendChild(details);

    var close = el('button', {
      type: 'button',
      style: 'margin-top:16px;padding:6px 14px;border-radius:6px;border:1px solid #2f333c;'
        + 'background:#22252c;color:inherit;font:inherit;cursor:pointer',
    }, 'Close');
    var onKey = function (e) { if (e.key === 'Escape') dismiss(); };
    var dismiss = function () {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      document.removeEventListener('keydown', onKey);
    };
    close.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
    card.appendChild(close);
    panel.appendChild(card);
    document.body.appendChild(panel);
    close.focus();
  }

  var COLOURS = { red: '#ff6b6b', orange: '#e8912d', minor: '#9aa1ad' };

  /**
   * Each problem found, in full: the headline shown under the file browser,
   * then why it matters and what to try. This is where the explanation lives,
   * so the line on the page can stay one headline long.
   */
  function problemList() {
    var list = el('ul', { style: 'list-style:none;margin:0 0 18px;padding:0' });
    for (var i = 0; i < state.problems.length; i++) {
      var id = state.problems[i];
      var m = MESSAGES[id];
      var item = el('li', { style: 'margin:0 0 12px' });
      item.appendChild(el('strong', { style: 'display:block;color:' + COLOURS[levelOf(id)] }, m.title));
      item.appendChild(el('div', { style: 'color:#c4c9d2' }, m.why));
      var tryLine = el('div', null, (m.note ? '' : 'Try: ') + m.tryText + ' ');
      if (id === 'R3') {
        tryLine.appendChild(link('Reload the page', function () { window.location.reload(); }));
      }
      item.appendChild(tryLine);
      list.appendChild(item);
    }
    return list;
  }

  /**
   * Every check, passed or not. A failed row is coloured by how much it
   * matters: red stops the app, orange loses a feature, grey is minor and is
   * shown nowhere but here.
   */
  function checkList() {
    var f = state.facts;
    var x = api.extras || {};
    var rows = [
      // Once the app is running it has proved these, whatever a probe says.
      ['Opened from a web server', state.ready || f.protocol !== 'file:', 'red'],
      ['Modern script loading (ES modules)', state.ready || f.modules, 'red'],
      ['Frame assembly (OffscreenCanvas)', f.offscreen2d, 'red'],
      ['Frame copying (createImageBitmap)', f.imageBitmap, 'red'],
      ['Reading pixels back', f.readback !== 'blocked', 'red'],
      ['App started', state.ready, 'red'],
      ['Fast video decoding (WebCodecs)', f.webCodecs, 'orange'],
      ['Saving WebP', x.webp, 'orange'],
      ['No unexpected errors', state.errors.length === 0, 'orange'],
      ['Pixels read back unchanged', f.readback === 'ok', 'minor'],
      ['Exact timecode while playing (frame callbacks)', f.frameCallback, 'minor'],
      ['Converting other video types (WebAssembly)', f.wasm, 'minor'],
    ];
    var list = el('ul', { style: 'list-style:none;margin:0 0 16px;padding:0' });
    for (var i = 0; i < rows.length; i++) {
      var ok = rows[i][1] == null ? null : !!rows[i][1];
      var mark = ok === true ? '✅' : ok === false ? '❌' : '❔';
      var text = rows[i][0];
      list.appendChild(el('li', {
        style: 'margin:0 0 6px' + (ok === false ? ';color:' + COLOURS[rows[i][2]] : ''),
      }, mark + '  ' + text));
    }
    return list;
  }

  /*
   * Where problems are shown: under the file browser. The markup provides
   * the spot; a stale index.html might not, and then the top of the page
   * will do.
   */
  function alertHost() {
    var host = document.getElementById('alerts');
    if (!host) {
      host = el('div', { id: 'alerts', style: 'margin:8px' });
      document.body.insertBefore(host, document.body.firstChild);
    }
    return host;
  }

  function link(text, onClick) {
    var a = el('a', { href: '#', style: 'color:#4f8cff;white-space:nowrap' }, text);
    a.addEventListener('click', function (e) { e.preventDefault(); onClick(); });
    return a;
  }

  /**
   * One line under the file browser: the headline in the app's own error
   * colours (the .warn and .caution classes every other error uses) and a
   * link to the Browser check, where the explanation is. The colour is also
   * set inline, so it holds when the stylesheet is the stale file.
   */
  function show(id) {
    var host = alertHost();
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i].getAttribute('data-key') === id) return;   // already showing
    }
    var red = levelOf(id) === 'red';
    var line = el('p', { 'class': 'alert small', role: red ? 'alert' : 'status', 'data-key': id,
      style: 'margin:0 0 4px' });
    line.appendChild(el('span', {
      'class': red ? 'warn' : 'caution',
      style: 'font-weight:600;color:' + (red ? '#e03131' : '#e8912d'),
    }, MESSAGES[id].title));
    line.appendChild(el('span', null, ' '));
    line.appendChild(link('Browser check', showCheck));
    host.appendChild(line);
  }

  /** Record a problem, and show its line unless it is a minor one. */
  function raise(id) {
    if (state.problems.indexOf(id) < 0) state.problems.push(id);
    if (levelOf(id) !== 'minor') show(id);
  }

  /*
   * An error nothing else caught, once the app is running. One orange line
   * however many there are; each message is listed in the Browser check.
   */
  function unexpected() {
    raise('R3');
  }

  /* --------------------------------------------------------- start-up */

  /*
   * Module scripts always run — or fail — before the load event, so by then
   * the app has either called ready() or never will. No timer to tune.
   */
  function finish() {
    if (state.finished) return;
    state.finished = true;
    state.facts = gatherFacts();
    var found = checks(state.facts);
    if (state.ready) {
      // The app is running, so its scripts proved these. Being opened from
      // disk goes too: it is only a problem where it stops the start.
      found = found.filter(function (id) { return id !== 'F1' && id !== 'F2'; });
    }
    var fatal = found.filter(isFatal);
    if (!state.ready && !fatal.length) fatal.push('F7');
    var all = fatal.concat(found.filter(function (id) { return !isFatal(id); }));
    for (var i = 0; i < all.length; i++) raise(all[i]);
  }

  window.addEventListener('load', function () { window.setTimeout(finish, 0); });

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('browser-check');
    if (button) button.addEventListener('click', function (e) {
      e.preventDefault();
      showCheck();
    });
  });

  var api = {
    MESSAGES: MESSAGES,
    checks: checks,
    /** Called by main.js as its last start-up step. */
    ready: function () { state.ready = true; },
    /** Filled in by main.js: WebP support, the loaded video, decoders tried. */
    extras: null,
    /** Report a problem by id. main.js uses it for the ones only it can see. */
    raise: raise,
    showCheck: showCheck,
    state: state,
  };
  window.Preflight = api;
})(window);
