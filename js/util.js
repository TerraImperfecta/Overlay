/* Shared by every section below, and by nothing in particular -- these
   lived at the foot of icon.js only because something had to hold them. */
export const $ = s => document.querySelector(s);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
export const idle = ms => new Promise(r => setTimeout(r, ms || 0));
