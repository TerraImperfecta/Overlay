/* The entry point, and the only script index.html loads. Each import below
   pulls in the ones it depends on, so load order is the import graph rather
   than the order of tags in the page -- which is the point of the change.

   The re-exports exist for the test suite, which reaches the app through
   these names. Nothing in the app imports from here. */
export * from "./util.js";
export * from "./00-icon.js";
export * from "./01-gif-decoder.js";
export * from "./02-source-loader.js";
export * from "./03-timeline.js";
export * from "./04-gif-encoder.js";
export * from "./05-webp.js";
export * from "./06-apng.js";
export * from "./07-isobmff.js";
export * from "./08-webm.js";
export * from "./09-webcodecs.js";
export * from "./10-formats.js";
export * from "./11-app.js";
export * from "./12-export.js";
export * from "./13-ui.js";
