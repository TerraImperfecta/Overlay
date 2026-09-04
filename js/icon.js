/* =====================================================================
   ICON — the apple-touch-icon, rasterised from the header mark
   ===================================================================== */

/* iOS wants a PNG for a home-screen bookmark, and this draws one from the same
   <svg> the header shows, so the icon and the logo cannot drift apart. That is
   the reason it still runs at load: the banner used to say "so it works on
   file:// and hosted", which stopped being true when file:// support was
   dropped, and would not justify it now. Measured in #76 at 0.4-2 ms, after
   onload and off the critical path.

   It had never once produced an icon. XMLSerializer below explains why. */
(function(){
  try {
    /* XMLSerializer, not outerHTML. HTML's serialiser writes no xmlns on a
       foreign element, because inside an HTML document the namespace is
       implied -- but a data: URI is parsed standalone, and SVG without
       xmlns="http://www.w3.org/2000/svg" is not SVG at all. Every engine
       refused the image, onerror swallowed the refusal, and nothing appeared. */
    const svg = new XMLSerializer()
      .serializeToString(document.querySelector("header svg"));

    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 180;
      const x = c.getContext("2d");
      x.fillStyle = "#151827"; x.fillRect(0,0,180,180);
      x.drawImage(img, 10, 10, 160, 160);
      const link = document.createElement("link");
      link.rel = "apple-touch-icon"; link.href = c.toDataURL("image/png");
      document.head.appendChild(link);
    };
    /* Silent: an icon is not worth a console error. It is now a failure that
       can only cost the icon. */
    img.onerror = () => {};
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  } catch {
    /* Decoration must not be able to take the app down. A classic script that
       threw took only itself with it; a module that throws during evaluation
       fails the import that pulled it in, and main.js imports this one first. */
  }
})();
