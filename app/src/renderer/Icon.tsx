const paths: Record<string, string> = {
  sidebar: 'M3 4.5h14v11H3zM7.5 4.5v11',
  plus: 'M10 4v12M4 10h12',
  search: 'M8.5 3.5a5 5 0 1 1 0 10a5 5 0 0 1 0-10zM12.2 12.2L16.5 16.5',
  folder: 'M2.5 5.5h5l1.5 1.5h8.5v8.5h-15z',
  // A gear: eight teeth and a center hole.
  settings: 'M15.75 8.67L17.5 8.75L17.5 11.25L15.75 11.33L15.01 13.12L16.18 14.42L14.42 16.18L13.12 15.01L11.33 15.75L11.25 17.5L8.75 17.5L8.67 15.75L6.88 15.01L5.58 16.18L3.82 14.42L4.99 13.12L4.25 11.33L2.5 11.25L2.5 8.75L4.25 8.67L4.99 6.88L3.82 5.58L5.58 3.82L6.88 4.99L8.67 4.25L8.75 2.5L11.25 2.5L11.33 4.25L13.12 4.99L14.42 3.82L16.18 5.58L15.01 6.88ZM10 7.6a2.4 2.4 0 1 1 0 4.8a2.4 2.4 0 0 1 0-4.8z',
  chevron: 'M7.5 5l5 5l-5 5',
  // A row's menu (three dots), Rename (a pencil) and Archive (a box with a lid).
  more: 'M10 3.6a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8zM10 9.1a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8zM10 14.6a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8z',
  pencil: 'M13.2 3.8l3 3L7 16H4v-3zM11.2 5.8l3 3',
  // Claude desktop's send (a return arrow), where a chat runs (a laptop, a cloud), and a pull request.
  enter: 'M15.5 5v5a2 2 0 0 1-2 2H5M8 9l-3 3l3 3',
  paperclip: 'M14.5 9.5l-5 5a3 3 0 0 1-4.2-4.2l5.8-5.8a2 2 0 0 1 2.8 2.8l-5.6 5.6a1 1 0 0 1-1.4-1.4l5-5',
  slash: 'M4 4h12v12H4zM11.5 7l-3 6',
  laptop: 'M4.5 5h11v7.5h-11zM2.5 15h15',
  arrowLeft: 'M15.5 10h-11M9 5.5L4.5 10L9 14.5',
  arrowRight: 'M4.5 10h11M11 5.5l4.5 4.5l-4.5 4.5',
  reload: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 4v3.5H12',
  globe: 'M10 3a7 7 0 1 1 0 14a7 7 0 0 1 0-14zM3 10h14M10 3c2 2 2.8 4.3 2.8 7s-.8 5-2.8 7c-2-2-2.8-4.3-2.8-7S8 5 10 3z',
  cloud: 'M6 15.5h8a3 3 0 0 0 .5-5.96A4.5 4.5 0 0 0 5.9 9.6A3 3 0 0 0 6 15.5z',
  pullRequest: 'M6 6.5v7M6 3.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM6 13.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM14 13.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM14 13.5V8.5a2 2 0 0 0-2-2H9.5M11 5l-1.5 1.5L11 8',
  // A merged pull request: two commits joined.
  merged: 'M6 6.5v7M6 3.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM6 13.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM14 10a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM6 6.5c0 3 3 5 6.5 5',
  archive: 'M3 4.5h14v3H3zM4.5 7.5v8h11v-8M8 10.5h4',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  clone: 'M6 3.5v9M6 12.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4zM14 7.5a2 2 0 1 0 0-4a2 2 0 0 0 0 4zM14 7.5c0 3-8 2-8 5',
  arrowUp: 'M10 15.5v-11M5.5 9l4.5-4.5L14.5 9',
  stop: 'M6.5 6.5h7v7h-7z',
  chevronDown: 'M6 8l4 4l4-4',
  chevronUp: 'M6 12l4-4l4 4',
  moreHorizontal: 'M4.5 9.1a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8zM10 9.1a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8zM15.5 9.1a.9.9 0 1 1 0 1.8a.9.9 0 0 1 0-1.8z',
  // The title bar's Chat (a speech bubble) and Agents (three linked heads).
  chat: 'M4 4.5h12v8.5H9.5L6 16v-3H4z',
  agents: 'M10 3.5a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 0 1 0-3.6zM5 12.5a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 0 1 0-3.6zM15 12.5a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 0 1 0-3.6zM9 6.8L6 12.7M11 6.8l3 5.9M6.8 14.3h6.4',
  check: 'M4.5 10.5l3.5 3.5l7.5-8',
  terminal: 'M3.5 4.5h13v11h-13zM6.5 8.5l2 1.5l-2 1.5M10.5 12.5h3',
  diff: 'M6 3.5v6M3 6.5h6M3.5 14.5h6M12.5 3.5h4v13h-4',
};

/** A small line icon, drawn with the current text color. */
export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
