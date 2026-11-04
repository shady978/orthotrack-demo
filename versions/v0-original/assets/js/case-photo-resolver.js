/* OrthoTrack — case-photo resolver.
   The screens build image paths in JavaScript ('assets/pNN.jpeg'), which a
   bundler cannot see, so in a single-file build those paths have nothing to
   resolve against and every case photo breaks.

   Rather than embed megabytes of base64 in source, the page carries a hidden
   manifest of <img data-ot-key="assets/x.jpeg" src="assets/x.jpeg"> tags. A
   bundler rewrites the `src` of real markup (to a blob or data URL) but leaves
   `data-ot-key` alone, so pairing the two recovers original → bundled. Served
   normally the two are identical and this is a no-op. */
(function () {
  var MAP = {};

  function learn() {
    var seeds = document.querySelectorAll('img[data-ot-key]');
    for (var i = 0; i < seeds.length; i++) {
      var key = seeds[i].getAttribute('data-ot-key');
      var real = seeds[i].currentSrc || seeds[i].getAttribute('src');
      if (key && real && real !== key) MAP[key] = real;
    }
    window.OrthoAssets = MAP;
    return Object.keys(MAP).length > 0;
  }

  function fix(el) {
    var attrs = ['src', 'data-src', 'data-fb'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v && MAP[v]) el.setAttribute(attrs[i], MAP[v]);
    }
  }

  function sweep(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'IMG' && !node.hasAttribute('data-ot-key')) fix(node);
    if (!node.querySelectorAll) return;
    var list = node.querySelectorAll('img:not([data-ot-key])');
    for (var i = 0; i < list.length; i++) fix(list[i]);
  }

  function start() {
    /* the manifest's own srcs may be swapped in asynchronously during unpack */
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      if (learn() || tries > 40) { clearInterval(poll); sweep(document.body); }
    }, 60);
    learn();
    sweep(document.body);
    new window.MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') { if (!m.target.hasAttribute('data-ot-key')) fix(m.target); }
        for (var j = 0; j < m.addedNodes.length; j++) sweep(m.addedNodes[j]);
      }
    }).observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['src', 'data-src', 'data-fb']
    });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
