const backgroundPolicy = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

/** Puppeteer filters supplied arguments too, so preserve explicit opt-outs. */
export function browserDefaultArgsToIgnore(args: string[], filtered: string[]) {
  return [
    "--enable-automation",
    "--disable-extensions",
    ...backgroundPolicy.filter((arg) => !args.includes(arg)),
    ...filtered,
  ];
}
