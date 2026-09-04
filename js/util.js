"use strict";

/* Shared by every section below, and by nothing in particular -- these
   lived at the foot of section 0 only because something had to hold them. */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const idle = ms => new Promise(r => setTimeout(r, ms || 0));
