#!/usr/bin/env node
import { styleText } from "node:util";
import { run } from "./cli.js";

// A reader that stops early, such as `| head`, is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
  process.exit();
});

run(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  tty: process.stdout.isTTY === true,
  // Node's own rules for color: a terminal that has them, NO_COLOR, FORCE_COLOR.
  color: styleText("red", "x", { stream: process.stdout }) !== "x",
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e);
    process.exitCode = 2;
  },
);
