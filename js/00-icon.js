/* =====================================================================
   0. ICON — rasterised at runtime so it works on file:// and hosted
   ===================================================================== */
(function(){
  const svg = document.querySelector("header svg").outerHTML;
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
  img.onerror = () => {};
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
})();
