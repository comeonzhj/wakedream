// 内联 SVG 图标（lucide 风格单线描边）。不引入任何外链图标/CDN，也不用 emoji 当图标。
// 用法：icon('moon', 16) → svg 字符串。

const P = {
  sunrise: '<path d="M12 3v3M5.6 9.6 4.2 8.2M18.4 9.6l1.4-1.4M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0"/><path d="M2 22h20"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/><path d="M17 3.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8Z"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.8l5.9-.9Z"/>',
  messages: '<path d="M8 4h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1v3l-3.5-3H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M16 18.5V19a2 2 0 0 1-2 2H7l-3.5 3V13a2 2 0 0 1 2-2h1"/>',
  brain: '<path d="M9.5 4.5A3 3 0 0 0 6.6 7 2.6 2.6 0 0 0 5 9.4c0 .9.4 1.7 1.1 2.2A2.7 2.7 0 0 0 5 13.9c0 1.4 1 2.6 2.4 2.8A3 3 0 0 0 10.3 20c.9 0 1.7-.4 2.2-1V5.7a2 2 0 0 0-3-1.2Z"/><path d="M14.5 4.5A3 3 0 0 1 17.4 7 2.6 2.6 0 0 1 19 9.4c0 .9-.4 1.7-1.1 2.2A2.7 2.7 0 0 1 19 13.9c0 1.4-1 2.6-2.4 2.8A3 3 0 0 1 13.7 20c-.9 0-1.7-.4-2.2-1"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.6 1.5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m4 12.5 5 5L20 6.5"/>',
  scan: '<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><path d="M12 12a3.2 3.2 0 1 0 0-.01"/><path d="M12 5.5V8M12 16v2.5M5.5 12H8M16 12h2.5"/>',
  radar: '<path d="M12 12 19 5"/><path d="M4.9 19.1a10 10 0 1 1 14.2 0"/><path d="M8.5 15.5a5 5 0 1 1 7 0"/>',
  play: '<path d="M6 4.5 19 12 6 19.5Z"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alert: '<path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  folder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  fileText: '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M13.5 3v5.5H19M9 13h6M9 17h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M9.5 1.8v1.7M14.5 1.8v1.7M9.5 20.5v1.7M14.5 20.5v1.7M1.8 9.5h1.7M1.8 14.5h1.7M20.5 9.5h1.7M20.5 14.5h1.7"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  wrench: '<path d="M14.5 6.5a4.5 4.5 0 1 0 5 5L21 10l-2-2-3.5 3.5-1-1L18 7l-2-2Z" transform="translate(-1.5 1.5)"/><path d="m3 21 8.5-8.5"/>',
  zap: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12Z"/>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.3 3M6.5 7.6A16.6 16.6 0 0 0 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1"/><path d="m3 3 18 18"/>',
  externalLink: '<path d="M14 4h6v6M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  wifi: '<path d="M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10.5 10.5 0 0 1 13 0M8.5 16a6 6 0 0 1 7 0"/><path d="M12 19.5h.01"/>',
  cloudDown: '<path d="M7 16a4 4 0 0 1 .6-7.9 5.5 5.5 0 0 1 10.6 1.4A3.6 3.6 0 0 1 18 16"/><path d="M12 12v7M9 16.5 12 19.7l3-3.2"/>',
  cloudUp: '<path d="M7 16a4 4 0 0 1 .6-7.9 5.5 5.5 0 0 1 10.6 1.4A3.6 3.6 0 0 1 18 16"/><path d="M12 19.5v-7M9 15.5l3-3.2 3 3.2"/>',
  activity: '<path d="M3 12h4l2.5-7 4 14L16.5 12H21"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  bookOpen: '<path d="M12 6.5S10 4.5 6.5 4.5c-1.5 0-2.5.4-2.5.4v13.6s1-.4 2.5-.4C10 18.1 12 20 12 20s2-1.9 5.5-1.9c1.5 0 2.5.4 2.5.4V4.9s-1-.4-2.5-.4C14 4.5 12 6.5 12 6.5Z"/><path d="M12 6.5V20"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  power: '<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.7-5.1L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 13.7 5.1L21 15"/><path d="M21 20v-5h-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.4 3.8 5.6 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3Z"/>',
  message: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4V6a1 1 0 0 1 1-1Z"/>',
  cornerDownRight: '<path d="M4 5v7a3 3 0 0 0 3 3h13"/><path d="m16 11 4 4-4 4"/>',
  terminalSquare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 10h.01M12 10h4M8 14h8"/>',
  text: '<path d="M5 5h14M5 10h14M5 15h9"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4.5v4h4"/><path d="M12 8v4.5l3 1.8"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4.3-3 7.4-7 8.6-4-1.2-7-4.3-7-8.6V6Z"/><path d="m9.5 12 2 2 3.5-3.5"/>',
  network: '<rect x="9" y="3" width="6" height="5" rx="1.5"/><rect x="3" y="16" width="6" height="5" rx="1.5"/><rect x="15" y="16" width="6" height="5" rx="1.5"/><path d="M12 8v4M6 16v-2h12v2"/>',
  clipboard: '<rect x="8" y="4" width="8" height="4" rx="1.5"/><path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 6H15"/><path d="M9 12h6M9 16h4"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6Z"/><path d="M12 17v4"/>',
  download: '<path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19h16"/>',
  upload: '<path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M4 19h16"/>',
};

export function icon(name, size = 16, extraClass = '') {
  const body = P[name] || P.info;
  const cls = extraClass ? `icon ${extraClass}` : 'icon';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function hasIcon(name) { return Object.hasOwn(P, name); }
export const ICON_NAMES = Object.keys(P);
